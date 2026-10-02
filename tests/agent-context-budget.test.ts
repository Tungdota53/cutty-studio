import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import type { ModelClient } from '../src/model.js';
import { Tools } from '../src/tools.js';
import { skillPrompt } from '../src/skill-prompt.js';
import { estimateTokens, estimateMessages, newConversation } from '../src/conversation.js';
import type { Message } from '../src/types.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function config() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-budget-')); roots.push(root); return { ...loadConfig(root), namedAgents: [] }; }
describe('Agent context allocation', () => {
  it('keeps skill instructions discoverable without exceeding multilingual token allocation', () => {
    const skills = Array.from({ length: 8 }, (_, i) => ({ id: `project:skill-${i}`, name: `skill-${i}`, file: 'SKILL.md', source: 'project', description: '', instructions: 'Chỉ dẫn kỹ thuật tiếng Việt 日本語 😀 '.repeat(500) }));
    const prompt = skillPrompt(skills, 1200);
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(1200);
    for (const skill of skills) expect(prompt).toContain(skill.id);
    expect(prompt).toContain('read_skill_resource');
    expect(estimateTokens(skillPrompt(skills, 10))).toBeLessThanOrEqual(10);
  });
  it('runs with several large explicit skills using a small model window', async () => {
    const c = config();
    const ids = Array.from({ length: 3 }, (_, i) => {
      const dir = path.join(c.workspace, '.agents', 'skills', `long-${i}`); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: long\ndescription: large skill\n---\n' + 'instruction '.repeat(1100));
      return `project:long-${i}`;
    });
    c.agentProfiles = { coder: { skills: ids, autoSkills: false } };
    c.modelPool = [{ id: c.model, tags: [], priority: 100, maxContext: 8192 }];
    const chat = vi.fn(async (messages: Message[], tools: unknown[], _model: string, _signal: unknown, _onToken: unknown, options: { maxOutputTokens: number }) => {
      expect(estimateMessages(messages, tools) + options.maxOutputTokens).toBeLessThan(8192);
      expect(messages[0].content).toContain('read_skill_resource');
      return { content: 'done', toolCalls: [], model: c.model };
    });
    const client = { config: c, chat } as unknown as ModelClient;
    expect(await new Agent('budget', 'coder', c.workspace, client, new ModelRouter(c), new Tools(c.workspace)).run('Implement UI')).toBe('done');
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it('does not retry a provider context rejection when nothing can be compacted', async () => {
    const c = config(); c.modelPool = [{ id: c.model, priority: 100, tags: [] }];
    const chat = vi.fn().mockRejectedValue(new Error('API HTTP 400: context_length_exceeded'));
    const client = { config: c, chat } as unknown as ModelClient;
    await expect(new Agent('budget', 'general', c.workspace, client, new ModelRouter(c), new Tools(c.workspace)).run('hello', undefined, undefined, [], { state: newConversation() })).rejects.toThrow('context_length_exceeded');
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it('retries a provider context rejection once on the same model only after reducing input', async () => {
    const c = config(); c.modelPool = [{ id: c.model, priority: 100, tags: [] }];
    const sizes: number[] = []; const models: string[] = [];
    const chat = vi.fn(async (messages: Message[], tools: unknown[], model: string) => {
      models.push(model);
      if (!tools.length) return { content: 'Earlier file inspection; current task remains outstanding.', toolCalls: [], model };
      sizes.push(estimateMessages(messages, tools));
      if (sizes.length === 1) throw new Error('API HTTP 400: context_length_exceeded');
      return { content: 'Recovered', toolCalls: [], model };
    });
    const state = newConversation([{ role: 'user', content: 'Original requirements' }, { role: 'assistant', content: 'old inspection output '.repeat(600) }]);
    const client = { config: c, chat } as unknown as ModelClient;
    const result = await new Agent('budget', 'general', c.workspace, client, new ModelRouter(c), new Tools(c.workspace)).run('Continue current task', undefined, undefined, [], { state });
    expect(result).toBe('Recovered'); expect(sizes).toHaveLength(2); expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(new Set(models)).toEqual(new Set([c.model]));
  });
});
