import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationContext, estimateMessages, newConversation, messageGroups } from '../src/conversation.js';
import { Agent } from '../src/agent.js';
import { ModelRouter } from '../src/router.js';
import { Tools } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import type { ModelClient } from '../src/model.js';
import type { Message } from '../src/types.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function setup() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recovery-')); roots.push(root); return { ...loadConfig(root), contextWindow: 8192, maxOutputTokens: 1024, namedAgents: [] }; }
const payload = 'const tiếngViệt = "日本語 😀";\n'.repeat(5000);
const exchange: Message[] = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'large-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.js', content: payload }) } }] },
  { role: 'tool', tool_call_id: 'large-write', content: '{"ok":true,"output":"written"}' }
];
describe('Context failure regressions', () => {
  it.each(['empty', 'tools', 'oversized', 'outage'])('compacts huge recent writes safely with a %s summarizer reply', async mode => {
    const c = setup();
    const requestSizes: number[] = [];
    const state = newConversation([{ role: 'user', content: 'Original goal: preserve authentication.' }, { role: 'user', content: 'Current task: implement the UI.' }, ...exchange]);
    const chat = vi.fn(async (messages: Message[], tools: unknown[], model: string, _signal: unknown, _tokens: unknown, options: { maxOutputTokens: number }) => {
      requestSizes.push(estimateMessages(messages, tools) + options.maxOutputTokens);
      if (mode === 'outage') throw new Error('temporarily unavailable');
      return { content: mode === 'oversized' ? payload : '', toolCalls: mode === 'tools' ? exchange[0].tool_calls! : [], model };
    });
    const context = new ConversationContext(c, state);
    await context.prepare('System', [], { chat } as unknown as ModelClient, c.model);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(requestSizes[0]).toBeLessThanOrEqual(context.limits.inputBudget);
    expect(state.messages.map(item => item.content)).toEqual(['Original goal: preserve authentication.', 'Current task: implement the UI.']);
    expect(context.stats('System').estimatedInput).toBeLessThan(context.limits.inputBudget);
    expect(state.summary).not.toContain('\uFFFD');
    expect(messageGroups(state.messages).flat()).toHaveLength(state.messages.length);
    expect(state.compactions).toBe(1);
  });
  it('continues after oversized write and invalid summary without replaying file mutations', async () => {
    const c = setup(); let normalCalls = 0;
    const chat = vi.fn(async (_messages: Message[], tools: unknown[]) => {
      if (!tools.length) return { content: '', toolCalls: [], model: c.model };
      normalCalls++;
      return normalCalls === 1 ? { content: '', toolCalls: exchange[0].tool_calls!, model: c.model } : { content: 'Done', toolCalls: [], model: c.model };
    });
    const tools = new Tools(c.workspace, undefined, 'coder'); const run = vi.spyOn(tools, 'run');
    const state = newConversation(); const archive: Message[] = [];
    expect(await new Agent('recovery', 'coder', c.workspace, { config: c, chat } as unknown as ModelClient, new ModelRouter(c), tools).run('Create app.js', undefined, undefined, [], { state, onItem: item => archive.push(item) })).toBe('Done');
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(c.workspace, 'app.js'), 'utf8')).toBe(payload);
    expect(archive.find(item => item.tool_calls)?.tool_calls?.[0].function.arguments).toContain('app.js');
    expect(state.lastCompaction?.mode).toBe('extractive');
  });
  it('preserves state on cancellation during summarization', async () => {
    const c = setup(); const state = newConversation([{ role: 'user', content: 'Keep my goal' }, ...exchange]); const before = structuredClone(state);
    const controller = new AbortController();
    const client = { chat: async () => { controller.abort(); throw controller.signal.reason; } } as unknown as ModelClient;
    await expect(new ConversationContext(c, state).prepare('System', [], client, c.model, controller.signal)).rejects.toThrow();
    expect(state).toEqual(before);
  });
});
