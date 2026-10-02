import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Agent } from '../src/agent.js';
import { ModelClient, ModelStreamInterruptedError } from '../src/model.js';
import { loadConfig } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import { Tools } from '../src/tools.js';
import { newConversation } from '../src/conversation.js';
import type { Message } from '../src/types.js';
const roots: string[] = [], servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function setup(chat: (...args: any[]) => any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-stream-')); roots.push(dir);
  const config = { ...loadConfig(dir), namedAgents: [], maxAgentIterations: 0, maxAgentToolCalls: 0 };
  const client = { config, chat: vi.fn(chat) } as unknown as ModelClient;
  const tools = new Tools(dir, undefined, 'coder');
  return { dir, config, client, tools, agent: new Agent('recovery', 'coder', dir, client, new ModelRouter(config), tools), state: newConversation() };
}
describe('Interrupted response recovery', () => {
  it.each([['auto', 4_000_000], ['manual', 32768]] as const)('applies the provider context in %s mode and reserves its output limit', async (mode, window) => {
    const fixture = setup((_messages, _tools, _model, _signal, _tokens, options) => {
      expect(options.maxOutputTokens).toBe(2048);
      return { content: 'finished', toolCalls: [] };
    });
    fixture.config.contextMode = mode;
    fixture.config.contextWindow = 32768;
    fixture.config.maxOutputTokens = 4096;
    fixture.client.modelLimits = async model => ({ id: model, contextWindow: 4_000_000, maxOutputTokens: 2048 });
    const contexts: any[] = [];
    await fixture.agent.run('Inspect', undefined, undefined, [], { onContext: event => contexts.push(event) });
    expect(contexts.at(-1).stats.window).toBe(window);
  });
  it('continues the same model without duplicate visible output or replaying completed writes', async () => {
    let request = 0; const models: string[] = [];
    const fixture = setup((messages: Message[], _tools: unknown, model: string, _signal: unknown, onToken?: (text: string) => void) => {
      models.push(model);
      if (++request === 1) return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'once' }) } }], model };
      if (request === 2) { onToken?.('The file is ready. '); throw new ModelStreamInterruptedError('terminated', 'The file is ready. ', true); }
      expect(messages.some(message => message.role === 'tool' && message.tool_call_id === 'write')).toBe(true);
      expect(messages.findLast(message => message.role === 'system')?.content).toContain('do not replay writes');
      return { content: 'The file is ready. Verified.', toolCalls: [], model };
    });
    const run = vi.spyOn(fixture.tools, 'run'), tokens: string[] = [];
    expect(await fixture.agent.run('Create file', undefined, token => tokens.push(token), [], { state: fixture.state })).toBe('The file is ready. Verified.');
    expect(tokens.join('')).toBe('The file is ready. Verified.');
    expect(new Set(models).size).toBe(1); expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(fixture.dir, 'result.txt'), 'utf8')).toBe('once');
  });
  it('bounds interruption recovery and retains the partial checkpoint', async () => {
    const fixture = setup(() => { throw new ModelStreamInterruptedError('terminated', 'Partial explanation', true); });
    const checkpoint = vi.fn();
    await expect(fixture.agent.run('Implement', undefined, undefined, [], { state: fixture.state, checkpoint })).rejects.toThrow('terminated');
    expect(fixture.client.chat).toHaveBeenCalledTimes(3); expect(checkpoint).toHaveBeenCalled();
    expect(fixture.state.messages.filter(message => message.content === 'Partial explanation')).toHaveLength(1);
  });
  it('unlimited budgets allow more than the previous 200 reasoning turns', async () => {
    let turn = 0;
    const fixture = setup(() => turn++ < 205 ? { content: '', toolCalls: [{ id: `read-${turn}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `${turn}.txt` }) } }] } : { content: 'finished', toolCalls: [] });
    fixture.config.contextWindow = 1048576;
    expect(await fixture.agent.run('Inspect distinct files')).toBe('finished');
    expect(fixture.client.chat).toHaveBeenCalledTimes(206);
  });
  it('does not accept EOF without a completion marker even for valid tool JSON', async () => {
    const server = http.createServer((request, response) => {
      request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial', tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '{"path":"x","content":"x"}' } }] } }] }) + '\n\n');
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixture = setup(() => {});
    const port = (server.address() as import('node:net').AddressInfo).port;
    const model = new ModelClient({ ...fixture.config, baseUrl: `http://127.0.0.1:${port}` });
    try { await model.chat([], []); throw new Error('Expected interruption'); }
    catch (error) { expect(error).toBeInstanceOf(ModelStreamInterruptedError); expect(error).toMatchObject({ partialContent: 'partial', hadToolFragments: true }); }
  });
  it('preserves text when the real HTTP transport terminates midway through a tool call', async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++; request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Already streamed.', tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '{"path":' } }] } }] }) + '\n\n');
      setTimeout(() => response.destroy(), 25);
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const fixture = setup(() => {});
    const port = (server.address() as import('node:net').AddressInfo).port;
    const model = new ModelClient({ ...fixture.config, baseUrl: `http://127.0.0.1:${port}` });
    await expect(model.chat([], [])).rejects.toMatchObject({ name: 'ModelStreamInterruptedError', partialContent: 'Already streamed.', hadToolFragments: true });
    expect(requests).toBe(1);
  });
  it('caller cancellation is never automatically recovered', async () => {
    const controller = new AbortController();
    const fixture = setup(() => { controller.abort(new Error('user stopped')); throw new ModelStreamInterruptedError('terminated', 'partial', false); });
    await expect(fixture.agent.run('Work', controller.signal)).rejects.toThrow('user stopped');
    expect(fixture.client.chat).toHaveBeenCalledTimes(1);
  });
});
