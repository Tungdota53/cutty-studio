import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ConversationContext, contextLimits, estimateMessages, estimateTokens, messageGroups, newConversation } from '../src/conversation.js';
import { ModelClient } from '../src/model.js';
import { Agent } from '../src/agent.js';
import { ModelRouter } from '../src/router.js';
import { Tools } from '../src/tools.js';
import { Store } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { taskHandoff } from '../src/handoff.js';
import type { Message, Task } from '../src/types.js';

const roots: string[] = [];
const stores: Store[] = [];
const servers: http.Server[] = [];
afterEach(async () => { stores.splice(0).forEach(store => { if (store.db.open) store.close(); }); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function config() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-memory-')); roots.push(root); return { ...loadConfig(root), contextWindow: 8192, maxOutputTokens: 1024 }; }
const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'list_files', arguments: '{}' } };
describe('Persistent context and compaction', () => {
  it('feeds assistant outputs and complete tool results into the next turn after reopening SQLite', async () => {
    const c = config(), store = new Store(path.join(c.workspace, '.vibe')); stores.push(store);
    const received: Message[][] = [];
    let calls = 0;
    const client = { config: c, chat: vi.fn(async (messages: Message[]) => {
      received.push(structuredClone(messages)); calls++;
      return { content: calls === 1 ? 'Inspecting files' : 'Previous output is available', toolCalls: calls === 1 ? [toolCall] : [], model: c.model, usage: { prompt: 100, completion: 20, total: 120, cached: 25, estimated: false } };
    }) } as unknown as ModelClient;
    fs.writeFileSync(path.join(c.workspace, 'important-file.ts'), 'export const value = 1;');
    const run = (state: ReturnType<typeof newConversation>, prompt: string) => new Agent('test', 'general', c.workspace, client, new ModelRouter(c), new Tools(c.workspace)).run(prompt, undefined, undefined, [], { state, checkpoint: snapshot => store.saveConversation('chat-memory', snapshot), onItem: item => store.archiveItem('chat-memory', item) });
    await run(newConversation(), 'Remember the file names');
    store.close(); const reopened = new Store(path.join(c.workspace, '.vibe')); stores.push(reopened);
    const state = reopened.conversation('chat-memory');
    await new Agent('test', 'general', c.workspace, client, new ModelRouter(c), new Tools(c.workspace)).run('Continue from the previous result', undefined, undefined, [], { state });
    expect(received[2].some(item => item.role === 'assistant' && item.content === 'Previous output is available')).toBe(true);
    expect(received[2].find(item => item.role === 'tool')?.content).toContain('important-file.ts');
    expect(received[2].find(item => item.tool_calls)?.tool_calls?.[0].id).toBe('call-1');
    expect(reopened.items('chat-memory')).toHaveLength(4);
    expect(state.usage).toMatchObject({ prompt: 300, completion: 60, cached: 75, estimated: false });
  });
  it('auto-compacts old messages within the budget, retaining the original and latest user instructions', async () => {
    const c = config();
    const state = newConversation([{ role: 'user', content: 'Never modify the authentication flow.' }, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `Turn ${i}: ` + 'Long previous context. '.repeat(100) })), { role: 'user', content: 'Now continue with the UI.' }]);
    const events: string[] = [];
    const client = { chat: vi.fn(async (messages: Message[], _tools: unknown[], _model: string, _signal: unknown, _token: unknown, options: { maxOutputTokens: number }) => {
      expect(estimateMessages(messages) + options.maxOutputTokens).toBeLessThanOrEqual(contextLimits(c).inputBudget);
      return { content: 'Preserve authentication. Prior UI evidence retained; continue the UI.', toolCalls: [], model: c.model };
    }) } as unknown as ModelClient;
    const context = new ConversationContext(c, state, event => events.push(event.type));
    await context.prepare('System prompt', [], client, c.model);
    expect(client.chat).toHaveBeenCalled(); expect(state.compactions).toBeGreaterThan(0);
    expect(state.messages[0].content).toBe('Never modify the authentication flow.');
    expect(state.messages.at(-1)?.content).toBe('Now continue with the UI.');
    expect(context.requestMessages('System prompt')[1]).toMatchObject({ role: 'assistant', content: expect.stringContaining('Preserve authentication') });
    expect(context.stats('System prompt').estimatedInput).toBeLessThan(context.limits.inputBudget);
    expect(events).toContain('compaction_end');
    const store = new Store(path.join(c.workspace, '.vibe')); stores.push(store); store.saveConversation('chat-long', state);
    expect(store.conversation('chat-long').summary).toBe(state.summary);
  });
  it('falls back to labeled excerpts without modifying the archived transcript when summarization fails', async () => {
    const c = config(), state = newConversation([{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Old output '.repeat(1500) }, { role: 'user', content: 'More' }, { role: 'assistant', content: 'Last answer' }]);
    const store = new Store(path.join(c.workspace, '.vibe')); stores.push(store);
    const before = structuredClone(state.messages); before.forEach(item => store.archiveItem('fallback', item));
    const client = { chat: vi.fn(async () => { throw new Error('Summary service unavailable'); }) } as unknown as ModelClient;
    await new ConversationContext(c, state).prepare('System', [], client, c.model, undefined, true);
    expect(state.summary).toContain('Extractive fallback');
    expect(state.summary).toContain('Old output');
    expect(state.messages.filter(item => item.role === 'user')).toEqual(before.filter(item => item.role === 'user'));
    expect(store.items('fallback')).toEqual(before);
    expect(state.lastCompaction?.mode).toBe('extractive');
  });
  it('does not send an oversized latest user request or silently truncate it', async () => {
    const c = config(), latest = 'Latest complete request '.repeat(3000), state = newConversation([{ role: 'user', content: latest }]);
    const client = { chat: vi.fn() } as unknown as ModelClient;
    await expect(new ConversationContext(c, state).prepare('System', [], client, c.model)).rejects.toThrow('vượt ngân sách');
    expect(state.messages[0].content).toBe(latest); expect(client.chat).not.toHaveBeenCalled();
  });
  it('removes unfinished tool exchanges atomically and preserves completed pairs', () => {
    const messages: Message[] = [{ role: 'user', content: 'Goal' }, { role: 'assistant', content: '', tool_calls: [toolCall] }, { role: 'tool', tool_call_id: 'call-1', content: 'Result' }, { role: 'assistant', content: '', tool_calls: [{ ...toolCall, id: 'unfinished' }] }];
    expect(messageGroups(messages)).toEqual([[0], [1, 2]]);
    const state = newConversation(messages); new ConversationContext(config(), state);
    expect(state.messages).toHaveLength(3); expect(state.messages[2].tool_call_id).toBe('call-1');
  });
  it('bounds multilingual tool output in live context while archiving the full raw result', async () => {
    const c = config(), raw = 'Kết quả tiếng Việt 😀 '.repeat(6000);
    const client = { config: c, chat: vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [toolCall], model: c.model }).mockResolvedValueOnce({ content: 'Done', toolCalls: [], model: c.model }) } as unknown as ModelClient;
    const state = newConversation(), archive: Message[] = [];
    const tools = { run: vi.fn(async () => ({ ok: true, output: raw })) } as unknown as Tools;
    await new Agent('test', 'general', c.workspace, client, new ModelRouter(c), tools).run('Read result', undefined, undefined, [], { state, onItem: item => archive.push(item) });
    const live = state.messages.find(item => item.role === 'tool')!;
    expect(JSON.parse(live.content!).contextTruncated).toBe(true); expect(estimateTokens(live.content!)).toBeLessThan(1100);
    expect(archive.find(item => item.role === 'tool')?.content).toContain(raw);
  });
  it('rejects invalid output reserves and counts tool schemas against the input budget', () => {
    expect(() => contextLimits({ contextWindow: 4096, maxOutputTokens: 4096 })).toThrow('một nửa');
    expect(estimateMessages([{ role: 'user', content: 'hello' }], [{ schema: 'large'.repeat(100) }])).toBeGreaterThan(estimateMessages([{ role: 'user', content: 'hello' }]));
  });
  it('passes completed dependency outputs and worktree paths to downstream teamwork agents', () => {
    const base: Task = { id: 'coder', title: 'Implement', description: 'Build', role: 'coder', status: 'completed', dependencies: [], createdAt: '', resultSummary: 'Implemented the button; test command passed.', worktreePath: 'D:/project/.vibe/worktrees/coder' };
    const next = { ...base, id: 'reviewer', role: 'reviewer' as const, dependencies: ['coder', 'pending'] };
    const messages = taskHandoff('Keep existing login', next, [base, { ...base, id: 'pending', status: 'pending', resultSummary: 'Do not pass unexecuted proposals.' }]);
    expect(messages[0].content).toContain('Keep existing login'); expect(messages[1].content).toContain(base.worktreePath);
    expect(messages[1].content).toContain('Implemented the button'); expect(messages[1].content).not.toContain('unexecuted proposals');
  });
});

async function modelServer(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
describe('Stream usage and output limits', () => {
  it('reads actual input/output/cache usage including an EOF event without a newline', async () => {
    let request: any;
    const url = await modelServer((req, res) => { let body = ''; req.on('data', data => body += data); req.on('end', () => { request = JSON.parse(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":321,"completion_tokens":18,"total_tokens":339,"prompt_tokens_details":{"cached_tokens":200}}}'); }); });
    const c = { ...config(), baseUrl: url, apiKey: 'fake-key' };
    const result = await new ModelClient(c).chat([{ role: 'user', content: 'hello' }], [], c.model, undefined, undefined, { maxOutputTokens: 512 });
    expect(result.usage).toEqual({ prompt: 321, completion: 18, total: 339, cached: 200, estimated: false });
    expect(request.max_tokens).toBe(512); expect(request.tools).toBeUndefined(); expect(request.stream_options.include_usage).toBe(true);
  });
  it('falls back for routers that reject include_usage and remembers the capability', async () => {
    const requests: any[] = [];
    const url = await modelServer((req, res) => { let body = ''; req.on('data', data => body += data); req.on('end', () => { const payload = JSON.parse(body); requests.push(payload); if (payload.stream_options) { res.writeHead(400); res.end('unsupported stream_options include_usage'); } else { res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'); } }); });
    const c = { ...config(), baseUrl: url, apiKey: 'fake-key' }, client = new ModelClient(c);
    expect((await client.chat([], [])).content).toBe('OK'); await client.chat([], []);
    expect(requests).toHaveLength(3); expect(requests[2].stream_options).toBeUndefined();
  });
  it('does not replay a stream after output has already arrived', async () => {
    let count = 0;
    const url = await modelServer((_req, res) => { count++; res.end('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"message":"stream failed"}}\n\n'); });
    const c = { ...config(), baseUrl: url, apiKey: 'fake-key' }, tokens: string[] = [];
    await expect(new ModelClient(c).chat([], [], c.model, undefined, token => tokens.push(token))).rejects.toThrow('stream failed');
    expect(tokens).toEqual(['Partial']); expect(count).toBe(1);
  });
});
