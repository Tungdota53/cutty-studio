import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ModelClient } from '../src/model.js';
import type { Config } from '../src/config.js';
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function client(response: (request: number) => string) {
  let requests = 0;
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(response(++requests)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { model: new ModelClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', model: 'same-model' } as Config), requests: () => requests };
}
const event = (delta: unknown, finish_reason?: string) => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n';
describe('Model response integrity', () => {
  it('recovers an empty stream without reporting empty completion', async () => {
    const c = await client(n => n === 1 ? 'data: [DONE]\n\n' : event({ content: 'Recovered' }, 'stop'));
    expect((await c.model.chat([], [])).content).toBe('Recovered'); expect(c.requests()).toBe(2);
  });
  it('fails after bounded empty replies instead of silently completing', async () => {
    const c = await client(() => 'data: [DONE]\n\n');
    await expect(c.model.chat([], [])).rejects.toThrow('phản hồi rỗng'); expect(c.requests()).toBe(4);
  });
  it('honors the single-attempt summarization budget', async () => {
    const c = await client(() => 'data: [DONE]\n\n');
    await expect(c.model.chat([], [], undefined, undefined, undefined, { retryAttempts: 1, timeoutMs: 30000 })).rejects.toThrow('phản hồi rỗng');
    expect(c.requests()).toBe(1);
  });
  it.each(['length', 'content_filter'])('rejects %s after text without replaying visible output', async reason => {
    const c = await client(() => event({ content: 'Partial' }, reason)); const tokens: string[] = [];
    await expect(c.model.chat([], [], undefined, undefined, token => tokens.push(token))).rejects.toThrow('chưa hoàn tất');
    expect(tokens).toEqual(['Partial']); expect(c.requests()).toBe(1);
  });
  it.each(['{"path":"app.js",', 'null', '[]'])('refuses malformed tool arguments %s before execution', async args => {
    const c = await client(() => event({ tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: args } }] }));
    await expect(c.model.chat([], [])).rejects.toThrow('API stream'); expect(c.requests()).toBe(1);
  });
  it('refuses a whole batch when tool IDs collide', async () => {
    const c = await client(() => event({ tool_calls: [0, 1].map(index => ({ index, id: 'same', function: { name: 'write_file', arguments: '{}' } })) }));
    await expect(c.model.chat([], [])).rejects.toThrow('trùng ID'); expect(c.requests()).toBe(1);
  });
});
