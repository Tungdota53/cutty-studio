import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillLibrary } from '../src/skills.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { ModelClient } from '../src/model.js';
import { ModelRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { parseTeamPlan } from '../src/teamwork.js';
import type { Message } from '../src/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-role-')); roots.push(dir); return dir; }
function skill(dir: string, name: string, description: string, body = 'Read the relevant code before editing.') {
  const folder = path.join(dir, '.agents', 'skills', name); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`); return folder;
}
describe('Role permissions and skill loading', () => {
  it('uses the assigned role model before higher-scoring pool candidates', () => {
    const c = loadConfig(root()); c.agentProfiles = { tester: { model: 'assigned-tester' } };
    c.modelPool = [{ id: 'high-scoring', tags: ['tools', 'tester'], priority: 999 }];
    const decision = new ModelRouter(c).route({ role: 'tester', taskType: 'testing', complexity: 5, contextTokens: 100, requiresTools: true, requiresLongContext: false });
    expect(decision.selectedModel).toBe('assigned-tester'); expect(decision.fallbacks).toContain('high-scoring');
  });
  it('discovers project skills and selects relevant skills without auto-loading user skills', () => {
    const dir = root(); skill(dir, 'react-ui', 'React interface components');
    const user = path.join(dir, 'user'); fs.mkdirSync(path.join(user, 'react-user'), { recursive: true });
    fs.writeFileSync(path.join(user, 'react-user', 'SKILL.md'), '---\nname: react-user\ndescription: React components\n---\nUser instructions');
    const lib = new SkillLibrary(dir, user);
    expect(lib.search('React')[0].source).toBe('project');
    expect(lib.select('coder', 'React components').map(item => item.id)).toEqual(['builtin:scoped-implementation', 'project:react-ui']);
  });
  it('supports manual selection, disables auto-selection and rejects nonexistent/ambiguous skills', () => {
    const dir = root(); skill(dir, 'code-review', 'Review testing');
    const lib = new SkillLibrary(dir, path.join(dir, 'absent'));
    expect(lib.select('coder', 'Review', { agentProfiles: { coder: { skills: ['project:code-review'], autoSkills: false } } }).map(item => item.id)).toEqual(['project:code-review']);
    expect(() => lib.load('missing')).toThrow('Không tìm'); expect(() => lib.load('code-review')).toThrow('trùng tên');
  });
  it('reads skill resources within the skill folder and blocks traversal and oversized instructions', () => {
    const dir = root(), folder = skill(dir, 'custom', 'Custom'); const lib = new SkillLibrary(dir);
    fs.writeFileSync(path.join(folder, 'reference.md'), 'Reference evidence');
    fs.writeFileSync(path.join(dir, 'outside.md'), 'Outside');
    expect(lib.resource('project:custom', 'reference.md')).toBe('Reference evidence');
    expect(() => lib.resource('project:custom', '../../../outside.md')).toThrow();
    fs.writeFileSync(path.join(folder, 'SKILL.md'), 'x'.repeat(17000)); expect(() => lib.load('project:custom')).toThrow('quá dài');
  });
  it('blocks planner/reviewer writes and commands even if a model fabricates unauthorized tool calls', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'source.ts'), 'original');
    for (const role of ['planner', 'reviewer', 'judge'] as const) {
      const tools = new Tools(dir, async () => true, role);
      expect((await tools.run('write_file', JSON.stringify({ path: 'source.ts', content: 'changed' }))).ok).toBe(false);
      expect((await tools.run('run_command', '{"command":"echo hi"}')).ok).toBe(false);
      expect((await tools.run('read_file', '{"path":"source.ts"}')).ok).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, 'source.ts'), 'utf8')).toBe('original');
  });
  it('injects selected skills and role instructions, filters tool schemas and refuses bypass calls', async () => {
    const dir = root(); skill(dir, 'custom', 'Custom', 'CUSTOM_SKILL_EVIDENCE');
    const config = { ...loadConfig(dir), agentProfiles: { reviewer: { instructions: 'Review auth carefully', skills: ['project:custom'], autoSkills: false } } };
    const calls: any[] = []; let count = 0;
    const client = { config, chat: vi.fn(async (messages: Message[], tools: any[]) => {
      calls.push({ messages: structuredClone(messages), tools });
      return { content: 'Review', model: config.model, toolCalls: count++ ? [] : [{ id: 'bad', type: 'function', function: { name: 'write_file', arguments: '{"path":"source.ts","content":"bad"}' } }] };
    }) } as unknown as ModelClient;
    await new Agent('reviewer', 'reviewer', dir, client, new ModelRouter(config), new Tools(dir)).run('Review changes');
    expect(calls[0].messages[0].content).toContain('CUSTOM_SKILL_EVIDENCE');
    expect(calls[0].messages[0].content).toContain('Review auth carefully');
    expect(calls[0].tools.some((tool: any) => tool.function.name === 'write_file')).toBe(false);
    expect(calls[1].messages.find((message: Message) => message.role === 'tool').content).toContain('không được');
    expect(fs.existsSync(path.join(dir, 'source.ts'))).toBe(false);
  });
  it('dynamically loads a discovered skill into subsequent system context and reports its exact ID', async () => {
    const dir = root(); skill(dir, 'custom', 'Custom', 'DYNAMIC_SKILL');
    const config = { ...loadConfig(dir), agentProfiles: { general: { autoSkills: false } } }; let count = 0;
    const calls: Message[][] = [], loaded: string[][] = [];
    const client = { config, chat: vi.fn(async (messages: Message[]) => {
      calls.push(structuredClone(messages)); return { content: 'ok', model: config.model, toolCalls: count++ ? [] : [{ id: 'load', type: 'function', function: { name: 'load_skill', arguments: '{"id":"project:custom"}' } }] };
    }) } as unknown as ModelClient;
    await new Agent('general', 'general', dir, client, new ModelRouter(config), new Tools(dir)).run('Custom task', undefined, undefined, [], { onSkills: skills => loaded.push(skills.map(skill => skill.id)) });
    expect(calls[0][0].content).not.toContain('DYNAMIC_SKILL'); expect(calls[1][0].content).toContain('DYNAMIC_SKILL');
    expect(loaded.at(-1)).toContain('project:custom');
  });
  it('validates planner roles, unique IDs and dependency graphs before starting agents', () => {
    const task = { id: 'T1', title: 'Implement', role: 'coder', dependencies: [] };
    expect(parseTeamPlan(JSON.stringify({ tasks: [task] }))[0].role).toBe('coder');
    for (const tasks of [[{ ...task, role: 'invented' }], [task, task], [{ ...task, dependencies: ['missing'] }], [{ ...task, dependencies: ['T1'] }], [{ ...task, id: '../../outside' }]]) expect(() => parseTeamPlan(JSON.stringify({ tasks }))).toThrow();
  });
});
