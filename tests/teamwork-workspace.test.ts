import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Teamwork } from '../src/teamwork.js';
import { Worktrees } from '../src/worktree.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { ModelRouter } from '../src/router.js';
import type { ModelClient } from '../src/model.js';
import type { Message } from '../src/types.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-workspace-')); roots.push(value); return value; }
async function git(root: string, ...args: string[]) { return execa('git', args, { cwd: root }); }
async function repository(root: string) {
  await git(root, 'init'); fs.writeFileSync(path.join(root, 'existing.txt'), 'user source'); await git(root, 'add', 'existing.txt');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
}
function runner(root: string, plan: any[], reply: (messages: Message[]) => Promise<any>) {
  const config = { ...loadConfig(root), namedAgents: [], maxAgents: 4, useWorktrees: true };
  const store = new Store(path.join(root, '.vibe')); stores.push(store); let first = true;
  const client = { config, chat: async (messages: Message[]) => {
    if (first) { first = false; return { content: JSON.stringify({ tasks: plan }), toolCalls: [] }; }
    return reply(messages);
  } } as unknown as ModelClient;
  return { team: new Teamwork(config, store, client, new ModelRouter(config), async () => false), store };
}
describe('Teamwork workspace mode', () => {
  it('creates a page and lets tester/reviewer inspect the same files in an ordinary folder', async () => {
    const dir = root(); let wrote = false; const checked: string[] = [];
    const plan = [{ id: 'T1', role: 'coder', title: 'Create page', description: 'create-page', dependencies: [] }, { id: 'T2', role: 'tester', title: 'Check page', description: 'check-page', dependencies: ['T1'] }, { id: 'T3', role: 'reviewer', title: 'Review page', description: 'review-page', dependencies: ['T2'] }];
    const { team, store } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      if (request === 'create-page' && !wrote) { wrote = true; return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>alo alo</h1>' }) } }] }; }
      if (request !== 'create-page') { expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('alo alo'); checked.push(request!); }
      return { content: 'Verified page evidence', toolCalls: [] };
    });
    const result = await team.run('Tạo trang alo alo');
    expect(result.status).toBe('completed'); expect(result.workspaceMode).toBe('shared-folder'); expect(checked).toEqual(['check-page', 'review-page']);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(store.tasks(result.id).map(task => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(result.verified).toBe(false); // Free-form model claims are not execution evidence.
    const session = path.join(dir, '.vibe', 'sessions', result.id);
    expect(fs.readFileSync(path.join(session, 'GATE_STATUS.md'), 'utf8')).toContain('UNVERIFIED');
    expect(fs.readFileSync(path.join(session, 'agents', 'agent-coder-01', 'DISPATCH.md'), 'utf8')).toContain('Workspace:');
    expect(fs.readFileSync(path.join(session, 'agents', 'agent-reviewer-03', 'handoff.md'), 'utf8')).toContain('Tool evidence:');
  });
  it('serializes independent writers when no worktree isolation is available', async () => {
    const dir = root(); let active = 0, peak = 0;
    const { team } = runner(dir, ['T1', 'T2'].map(id => ({ id, role: 'coder', title: id, dependencies: [] })), async () => {
      peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { content: 'Done', toolCalls: [] };
    });
    expect((await team.run('Two changes')).status).toBe('completed'); expect(peak).toBe(1);
  });
  it('uses shared-folder mode for a repository without an initial commit', async () => {
    const dir = root(); await git(dir, 'init');
    const worktrees = new Worktrees(dir, path.join(dir, '.vibe')); expect(await worktrees.inspect()).toEqual({ worktrees: false, reason: 'no-commit' });
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async () => ({ content: 'Done', toolCalls: [] }));
    expect((await team.run('Code')).status).toBe('completed');
  });
  it('ignores app state but still blocks real source changes in Git repositories', async () => {
    const dir = root(); await repository(dir);
    fs.mkdirSync(path.join(dir, '.vibe')); fs.writeFileSync(path.join(dir, '.vibe', 'runtime.txt'), 'app state');
    const worktrees = new Worktrees(dir, path.join(dir, '.vibe'));
    expect((await worktrees.inspect()).worktrees).toBe(true); expect(await worktrees.status()).toBe('');
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'uncommitted user edit');
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async () => { throw new Error('Must not execute coder'); });
    const result = await team.run('Code'); expect(result.tasks[0].error).toContain('Workspace dirty');
    expect(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8')).toBe('uncommitted user edit');
  });
  it('creates a real isolated worktree when Git and a clean committed source are available', async () => {
    const dir = root(); await repository(dir);
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async messages => {
      expect(messages[0].content).toContain(path.join(dir, '.vibe', 'worktrees'));
      return { content: 'Checked workspace', toolCalls: [] };
    });
    const result = await team.run('Code'); expect(result.status).toBe('completed'); expect(result.workspaceMode).toBe('git-worktree');
    expect(fs.readFileSync(path.join(result.tasks[0].worktreePath!, 'existing.txt'), 'utf8')).toBe('user source');
  });
  it('persists blocked dependencies with a concrete cause after a genuine task failure', async () => {
    const dir = root(); const { team, store } = runner(dir, [{ id: 'T1', title: 'Fail', role: 'coder', dependencies: [] }, { id: 'T2', title: 'Dependent', role: 'tester', dependencies: ['T1'] }], async () => { throw new Error('API unavailable'); });
    const result = await team.run('Code'); expect(store.tasks(result.id).find(task => task.id === 'T2')).toMatchObject({ status: 'blocked', error: expect.stringContaining('T1') });
  });
  it('shares one implementation worktree across parallel workers and downstream verification', async () => {
    const dir = root(); await repository(dir);
    const seen: string[] = [];
    const tasks = ['a', 'b'].map(id => ({ id, role: 'coder', title: id, description: id, dependencies: [], expectedFiles: [id + '.txt'] }));
    const { team } = runner(dir, [...tasks, { id: 'test', role: 'tester', title: 'Check', description: 'test', dependencies: ['a', 'b'] }], async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      const scope = messages.find(message => message.role === 'user' && message.content?.includes('Assigned write files:'))!.content!.match(/^Workspace: ([^\n]+)/m)![1]; seen.push(scope);
      if (request === 'test') { expect(fs.readFileSync(path.join(scope, 'a.txt'), 'utf8')).toBe('a'); expect(fs.readFileSync(path.join(scope, 'b.txt'), 'utf8')).toBe('b'); }
      else if (!messages.some(message => message.role === 'tool')) return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: request + '.txt', content: request }) } }] };
      return { content: 'done', toolCalls: [] };
    });
    const result = await team.run('Two features'); expect(result.status).toBe('completed'); expect(new Set(seen).size).toBe(1);
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
  });
  it('repairs a real failed check with fresh agents and reruns verification', async () => {
    const dir = root();
    const command = `node -e "process.exit(require('fs').readFileSync('answer.txt','utf8')==='good'?0:1)"`;
    const plan = [{ id: 'code', role: 'coder', title: 'Code', description: 'initial-code', expectedFiles: ['answer.txt'] }, { id: 'test', role: 'tester', title: 'Test', description: 'verify-value', dependencies: ['code'], verificationCommands: [command] }, { id: 'review', role: 'reviewer', title: 'Review', description: 'review-value', dependencies: ['test'] }];
    const { team, store } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content || '', tools = messages.filter(message => message.role === 'tool');
      if (!tools.length) {
        const coder = request === 'initial-code' || request.startsWith('[REPAIR]');
        const name = coder ? 'write_file' : request === 'verify-value' ? 'run_command' : 'read_file';
        const args = coder ? { path: 'answer.txt', content: request === 'initial-code' ? 'bad' : 'good' } : name === 'run_command' ? { command } : { path: 'answer.txt' };
        return { content: '', toolCalls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      return { content: request === 'review-value' ? '{"verdict":"PASS","findings":[]}' : 'done', toolCalls: [] };
    });
    const result = await team.run('Fix value');
    expect(result.gate.verdict).toBe('PASS'); expect(fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8')).toBe('good');
    expect(result.tasks.find(task => task.id === 'test')?.assignedAgentId).toContain('-r1');
    expect(store.tasks(result.id).find(task => task.id === 'repair-1')?.status).toBe('completed');
    const attempts = fs.readdirSync(path.join(dir, '.vibe', 'sessions', result.id, 'agents'));
    expect(attempts).toContain('agent-tester-02'); expect(attempts).toContain('agent-tester-02-r1');
  });
  it('vetoes a validator that changes assigned source while claiming success', async () => {
    const dir = root();
    const plan = [{ id: 'code', role: 'coder', title: 'Code', description: 'make-source', expectedFiles: ['source.txt'] }, { id: 'test', role: 'tester', title: 'Verify', description: 'tamper-source', dependencies: ['code'] }];
    const { team } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      if (!messages.some(message => message.role === 'tool')) {
        const name = request === 'make-source' ? 'write_file' : 'run_command';
        const args = name === 'write_file' ? { path: 'source.txt', content: 'real' } : { command: `node -e "require('fs').writeFileSync('source.txt','tampered')"` };
        return { content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      return { content: '{"verdict":"PASS","findings":[]}', toolCalls: [] };
    });
    const result = await team.run('Verify source');
    expect(result.gate.verdict).toBe('FAIL');
    expect(result.tasks.find(task => task.id === 'test')?.error).toContain('Integrity veto');
    expect(result.tasks.some(task => task.id.startsWith('repair-'))).toBe(false);
  });
});
