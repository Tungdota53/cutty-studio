import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../src/checkpoints.js';
import { RunJournal } from '../src/run-journal.js';
import { newConversation } from '../src/conversation.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import { BudgetTracker } from '../src/budgets.js';
import type { ModelClient } from '../src/model.js';
import type { ToolCall, Message } from '../src/types.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-undo-')); roots.push(dir); return dir; }
const write: ToolCall = { id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"new"}' } };
function pending(dir: string) {
  const journal = new RunJournal(dir, 'chat-crash'), state = newConversation([{ role: 'user', content: 'Write file once' }]);
  journal.saveState(state); journal.beginBatch({ role: 'assistant', content: '', tool_calls: [write] }, state); const token = journal.beginTool(write, true);
  return { journal, state, token };
}
describe('Durable checkpoints and undo', () => {
  it('records real write/edit pre- and post-state and restores explicitly selected files', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
    const store = new CheckpointStore(dir), tools = new Tools(dir, undefined, 'coder').setCheckpointContext(dir, 'chat-test');
    const result = await tools.run('write_file', write.function.arguments);
    expect(result.ok).toBe(true); const id = String(result.checkpointId);
    expect(store.list('chat-test')).toHaveLength(1); expect(store.diff(id).files[0]).toMatchObject({ before: 'old', after: 'new' });
    store.restore(id, ['a.txt']); expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
    const edit = await tools.run('edit_file', '{"path":"a.txt","oldText":"old","newText":"edited"}');
    expect(store.diff(String(edit.checkpointId)).files[0].after).toBe('edited');
  });
  it('rejects user-edit conflicts before restoring any selected file', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const store = new CheckpointStore(dir), id = store.begin({ tool: 'run_command' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed'); fs.writeFileSync(path.join(dir, 'b.txt'), 'changed'); store.finish(id);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'user edit');
    expect(() => store.restore(id, ['a.txt', 'b.txt'])).toThrow('Undo conflict');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('changed'); expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('user edit');
  });
  it('undoes shell-created and shell-deleted files, including an original empty file', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'empty.txt'), ''); fs.writeFileSync(path.join(dir, 'deleted.txt'), 'original');
    const store = new CheckpointStore(dir), tools = new Tools(dir, async () => true, 'coder');
    const command = `node -e "const fs=require('fs');fs.unlinkSync('deleted.txt');fs.writeFileSync('empty.txt','changed');fs.writeFileSync('new.txt','created')"`;
    const result = await tools.run('run_command', JSON.stringify({ command })); expect(result.ok).toBe(true);
    store.restore(String(result.checkpointId), ['deleted.txt', 'empty.txt', 'new.txt']);
    expect(fs.readFileSync(path.join(dir, 'deleted.txt'), 'utf8')).toBe('original'); expect(fs.readFileSync(path.join(dir, 'empty.txt'), 'utf8')).toBe(''); expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
  });
  it('recovers crash before/after deterministic write while rejecting uncertain shell undo', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.txt'), 'old'); const store = new CheckpointStore(dir);
    const before = store.begin({ tool: 'write_file', files: ['a.txt'], intendedContent: { 'a.txt': 'new' } });
    store.restore(before, ['a.txt']); expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
    const after = store.begin({ tool: 'write_file', files: ['a.txt'], intendedContent: { 'a.txt': 'new' } }); fs.writeFileSync(path.join(dir, 'a.txt'), 'new');
    new CheckpointStore(dir).restore(after, ['a.txt']); expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
    const uncertain = store.begin({ tool: 'run_command' }); expect(() => store.restore(uncertain, ['a.txt'])).toThrow('outcome unknown');
  });
  it('blocks protected paths and symlinks, and bounds snapshot size', () => {
    const dir = root(), store = new CheckpointStore(dir);
    expect(() => store.begin({ tool: 'write_file', files: ['../outside.txt'] })).toThrow('Protected');
    expect(() => store.begin({ tool: 'write_file', files: ['.env'] })).toThrow('Protected');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => store.begin({ tool: 'write_file', files: ['big.bin'] })).toThrow('2 MiB');
    const target = root(); fs.symlinkSync(target, path.join(dir, 'link'), 'junction');
    expect(() => store.begin({ tool: 'write_file', files: ['link/outside.txt'] })).toThrow('symlink');
  });
  it('skips locked files during shell capture with explicit undo coverage warnings', () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'locked.txt'), 'locked'); fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
    const original = fs.readFileSync, read = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith('locked.txt')) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return (original as any)(file, ...args);
    }) as any);
    try { const store = new CheckpointStore(dir), id = store.begin({ tool: 'run_command' }); store.finish(id); expect(store.list()[0].warnings.join(' ')).toContain('locked.txt'); } finally { read.mockRestore(); }
  });
  it('keeps commands available for large workspaces while explicitly reporting partial undo coverage', () => {
    const dir = root(); for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(dir, `file-${i}.txt`), 'x');
    const store = new CheckpointStore(dir), id = store.begin({ tool: 'run_command' }); store.finish(id);
    expect(store.list()[0].warnings.join(' ')).toContain('coverage truncated');
  });
});
describe('Interrupted run journal', () => {
  it('reconstructs a pending side effect as unknown and prevents replay after process restart', () => {
    const dir = root(); pending(dir); const restarted = new RunJournal(dir, 'chat-crash'), state = restarted.resumeState();
    expect(JSON.parse(state.messages.at(-1)!.content!).outcome).toBe('unknown');
    restarted.beginBatch({ role: 'assistant', content: '', tool_calls: [write] }, state);
    expect(() => restarted.beginTool({ ...write, id: 'new-id' }, true)).toThrow('blocked replay');
    expect(() => restarted.beginTool({ ...write, id: 'reordered', function: { name: 'write_file', arguments: '{ "content": "new", "path": "a.txt" }' } }, true)).toThrow('blocked replay');
  });
  it('preserves completed tool outputs when crash occurs before conversation publication', () => {
    const dir = root(), { journal, token } = pending(dir); journal.completeTool(token, { ok: true, output: 'written' });
    const state = new RunJournal(dir, 'chat-crash').resumeState(); expect(JSON.parse(state.messages.at(-1)!.content!)).toEqual({ ok: true, output: 'written' });
  });
  it('marks another turn running durably even when the previous turn completed', () => {
    const dir = root(), journal = new RunJournal(dir, 'chat-turn'), state = newConversation([{ role: 'user', content: 'First' }]);
    journal.beginRun(state); journal.finish(state); expect(new RunJournal(dir, 'chat-turn').status().resumable).toBe(false);
    journal.beginRun(state); expect(new RunJournal(dir, 'chat-turn').status().resumable).toBe(true);
  });
  it('compacts historical payloads while retaining semantic replay protection across restart', () => {
    const dir = root(), journal = new RunJournal(dir, 'chat-large'), state = newConversation([{ role: 'user', content: 'Produce once' }]);
    const payload = 'private-raw-payload-'.repeat(30000), call = { ...write, function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: payload }) } };
    journal.beginRun(state); journal.beginBatch({ role: 'assistant', content: '', tool_calls: [call] }, state);
    const token = journal.beginTool(call, true); journal.completeTool(token, { ok: true, output: payload }, 'checkpoint-reference'); journal.finishBatch(state); journal.interrupted();
    const file = path.join(dir, '.vibe', 'run-journals', fs.readdirSync(path.join(dir, '.vibe', 'run-journals'))[0]), data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(fs.statSync(file).size).toBeLessThan(2000); expect(JSON.stringify(data.history)).not.toContain('private-raw-payload');
    expect(data.history[0]).toMatchObject({ name: 'write_file', mutating: true, status: 'completed', checkpointId: 'checkpoint-reference' });
    expect(data.history[0].signature).toMatch(/^[a-f0-9]{64}$/);
    const restarted = new RunJournal(dir, 'chat-large'), resumed = restarted.resumeState(); restarted.beginBatch({ role: 'assistant', content: '', tool_calls: [call] }, resumed);
    expect(() => restarted.beginTool({ ...call, id: 'new-id', function: { name: 'write_file', arguments: JSON.stringify({ content: payload, path: 'a.txt' }) } }, true)).toThrow('blocked replay');
  });
  it('upgrades a legacy raw history lazily without weakening the replay guard', () => {
    const dir = root(), { journal, token, state } = pending(dir); journal.completeTool(token, { ok: true, output: 'written' }); journal.finishBatch(state); journal.interrupted();
    const file = path.join(dir, '.vibe', 'run-journals', fs.readdirSync(path.join(dir, '.vibe', 'run-journals'))[0]), data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.history = [{ id: 'legacy', call: write, mutating: true, status: 'completed', result: '{"ok":true,"output":"large raw result"}' }]; fs.writeFileSync(file, JSON.stringify(data));
    const restarted = new RunJournal(dir, 'chat-crash'); expect(JSON.parse(fs.readFileSync(file, 'utf8')).history[0].call).toBeDefined();
    const restored = restarted.resumeState(); restarted.beginBatch({ role: 'assistant', content: '', tool_calls: [write] }, restored);
    expect(() => restarted.beginTool(write, true)).toThrow('blocked replay');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')); expect(persisted.history[0].call).toBeUndefined(); expect(persisted.history[0].result).toBeUndefined();
  });
  it('resumes real Agent after a write without executing the write or command a second time', async () => {
    const dir = root(); pending(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'new');
    const config = { ...loadConfig(dir), namedAgents: [] }, tools = new Tools(dir, undefined, 'coder'), run = vi.spyOn(tools, 'run');
    let call = 0;
    const chat = vi.fn(async (messages: Message[]) => {
      if (!call++) { expect(messages.some(message => message.role === 'tool' && message.content?.includes('unknown'))).toBe(true); return { content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }], model: config.model }; }
      return { content: 'Resumed without replay.', toolCalls: [], model: config.model };
    });
    const client = { config, chat } as unknown as ModelClient, state = newConversation();
    const result = await new Agent('resume', 'coder', dir, client, new ModelRouter(config), tools).run('Resume and inspect existing output.', undefined, undefined, [], { state, journal: new RunJournal(dir, 'chat-crash'), resume: true });
    expect(result).toBe('Resumed without replay.'); expect(run).toHaveBeenCalledExactlyOnceWith('read_file', '{"path":"a.txt"}', undefined);
    expect(state.messages.some(message => message.content === 'Write file once')).toBe(true); // Supplied state updated, not replaced.
  });
  it('stops before another provider call when configured token budget has been consumed', async () => {
    const dir = root(), config = { ...loadConfig(dir), namedAgents: [] }, budget = new BudgetTracker({ budget: { maxTokens: 1 } });
    const chat = vi.fn().mockResolvedValue({ content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }], usage: { prompt: 10, completion: 1, total: 11 }, model: config.model });
    const client = { config, chat } as unknown as ModelClient;
    await expect(new Agent('budget', 'coder', dir, client, new ModelRouter(config), new Tools(dir)).run('Inspect', undefined, undefined, [], { budgetTracker: budget })).rejects.toThrow('ngân sách token');
    expect(chat).toHaveBeenCalledTimes(1); expect(budget.snapshot().modelCalls).toBe(1);
  });
});
