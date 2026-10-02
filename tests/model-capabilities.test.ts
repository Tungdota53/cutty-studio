import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ModelClient } from '../src/model.js';
import type { Config } from '../src/config.js';
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function setup(data: unknown) {
  let count = 0; const server = http.createServer((_req, res) => { count++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data })); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { client: new ModelClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fixture', model: 'wide' } as Config), count: () => count };
}
describe('Declared model capabilities', () => {
  it('uses declared context/output and caches shared concurrent discovery', async () => {
    const c = await setup([{ id: 'wide', context_length: 4000000, top_provider: { max_completion_tokens: 32000 } }]);
    const [one, two] = await Promise.all([c.client.modelLimits('wide'), c.client.modelLimits('wide')]);
    expect(one).toEqual({ id: 'wide', contextWindow: 4000000, maxOutputTokens: 32000 }); expect(two).toEqual(one); expect(c.count()).toBe(1);
  });
  it('does not infer capacity from model name or invalid metadata', async () => {
    const c = await setup([{ id: 'gpt-large-1m', context_length: '1000000', max_output_tokens: -1 }, { id: 'invalid', context_window: Infinity }]);
    expect(await c.client.modelLimits('gpt-large-1m')).toEqual({ id: 'gpt-large-1m', contextWindow: undefined, maxOutputTokens: undefined });
    expect(await c.client.modelLimits('missing')).toBeUndefined();
  });
});
