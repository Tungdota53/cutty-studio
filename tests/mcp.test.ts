import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpRegistry, mcpServersSchema } from '../src/mcp.js';
import { Tools } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import type { ModelClient } from '../src/model.js';
const registries: McpRegistry[] = [], servers: http.Server[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  await McpRegistry.closeAll();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mcp-')); roots.push(value); return value; }
async function fixture(label = 'A', fail = false) {
  const calls: any[] = [], notifications: any[] = []; let initializations = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' || request.method === 'DELETE') { response.writeHead(405); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (payload.id === undefined) { notifications.push(payload); response.writeHead(204); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (fail) { response.writeHead(401); response.end('Bearer super-secret-token'); return; }
    let result: unknown;
    if (payload.method === 'initialize') { initializations++; result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }; }
    else if (payload.method === 'tools/list') result = { tools: [
      { name: 'inspect', description: 'Inspect', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'mutate', description: 'Mutate', inputSchema: { type: 'object', properties: {} } }
    ] };
    else if (payload.method === 'tools/call') {
      calls.push(payload.params);
      if (payload.params.arguments?.delay) await new Promise(resolve => setTimeout(resolve, 100));
      result = { content: [{ type: 'text', text: `${label}:${payload.params.arguments?.value || payload.params.name}` }], ...(payload.params.arguments?.fail ? { isError: true } : {}) };
    } else { response.writeHead(400); response.end(); return; }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`, calls, notifications, initializations: () => initializations };
}
function registry(dir: string, config: unknown) { const value = new McpRegistry(dir, mcpServersSchema.parse(config)); registries.push(value); return value; }
describe('Multi MCP registry', () => {
  it('connects two servers concurrently and isolates identical names and tool calls', async () => {
    const [a, b] = await Promise.all([fixture('A'), fixture('B')]);
    const mcp = registry(root(), { a: { transport: 'http', url: a.url }, b: { transport: 'http', url: b.url } });
    const [first, second] = await Promise.all([mcp.definitions('coder'), mcp.definitions('coder')]);
    expect(first).toHaveLength(4); expect(second).toHaveLength(4);
    expect(new Set(first.map(tool => tool.function.name)).size).toBe(4);
    const names = first.filter(tool => tool.function.name.includes('_inspect_')).map(tool => tool.function.name);
    const results = await Promise.all(names.map(name => mcp.call(name, { value: 'request' }, 'coder')));
    expect(results.map(result => result.output)).toEqual([expect.stringContaining('A:request'), expect.stringContaining('B:request')]);
    expect(a.initializations()).toBe(1); expect(b.initializations()).toBe(1);
  });
  it('restricts both discovery and invocation by role and read-only task policy', async () => {
    const server = await fixture(); const mcp = registry(root(), { service: { transport: 'http', url: server.url } });
    const coder = await mcp.definitions('coder'), reviewer = await mcp.definitions('reviewer'), tester = await mcp.definitions('tester'), readOnly = await mcp.definitions('general', true);
    expect(coder).toHaveLength(2); expect(reviewer).toHaveLength(1); expect(tester).toHaveLength(1); expect(readOnly).toHaveLength(1);
    const mutation = coder.find(tool => tool.function.name.includes('_mutate_'))!.function.name;
    expect((await mcp.call(mutation, {}, 'reviewer')).ok).toBe(false);
    expect((await mcp.call(mutation, {}, 'general', true)).ok).toBe(false);
    expect(server.calls).toHaveLength(0);
    const tools = new Tools(root(), undefined, 'reviewer').setMcp(mcp);
    expect((await tools.run(mutation, '{}')).ok).toBe(false);
  });
  it('isolates a failed server and hides authentication, URL query and raw errors', async () => {
    const [good, bad] = await Promise.all([fixture(), fixture('bad', true)]);
    const mcp = registry(root(), { good: { transport: 'http', url: good.url }, bad: { transport: 'http', url: bad.url + '?token=super-secret-token', headers: { Authorization: 'Bearer super-secret-token' } }, disabled: { transport: 'http', url: bad.url, enabled: false } });
    expect((await mcp.definitions('coder')).length).toBe(2);
    expect(mcp.statuses().map(server => server.status)).toEqual(['connected', 'error', 'disabled']);
    expect(JSON.stringify(mcp.statuses())).not.toContain('super-secret-token');
    const name = (await mcp.definitions('coder'))[0].function.name;
    const result = await mcp.call(name, { fail: true }, 'coder');
    expect(result.ok).toBe(false); // MCP isError cannot become phantom success.
  });
  it('forwards cancellation without replay or cancelling another concurrent request', async () => {
    const server = await fixture(); const mcp = registry(root(), { service: { transport: 'http', url: server.url } });
    const name = (await mcp.definitions('coder'))[0].function.name, controller = new AbortController();
    const cancelled = mcp.call(name, { value: 'cancel', delay: true }, 'coder', false, controller.signal);
    const intact = mcp.call(name, { value: 'intact', delay: true }, 'coder');
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await expect(cancelled).rejects.toThrow('stop'); expect((await intact).ok).toBe(true);
    expect(server.calls).toHaveLength(2);
    expect(server.notifications.some(notification => notification.method === 'notifications/cancelled')).toBe(true);
  });
  it('launches an explicitly configured stdio process and closes it', async () => {
    const dir = root(), script = path.join(dir, 'fixture.cjs');
    fs.writeFileSync(script, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.id===undefined)return;let result;if(p.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}};else if(p.method==='tools/list')result={tools:[{name:'inspect',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};else result={content:[{type:'text',text:'stdio result'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:p.id,result}));});`);
    const mcp = registry(dir, { local: { transport: 'stdio', command: process.execPath, args: [script], env: { API_TOKEN: 'test-secret' } } });
    const definitions = await mcp.definitions('reviewer'); expect(definitions).toHaveLength(1);
    expect((await mcp.call(definitions[0].function.name, {}, 'reviewer')).output).toContain('stdio result');
    await mcp.close(); expect((await mcp.call(definitions[0].function.name, {}, 'reviewer')).ok).toBe(false);
    expect(JSON.stringify(mcp.statuses())).not.toContain('test-secret');
  });
  it('exposes discovered MCP tools to the real Agent execution loop', async () => {
    const server = await fixture(), dir = root();
    const config = { ...loadConfig(dir), namedAgents: [], mcpServers: mcpServersSchema.parse({ service: { transport: 'http', url: server.url } }) };
    let requested = false;
    const chat = vi.fn(async (_messages: unknown, definitions: any[]) => {
      if (!requested) { requested = true; return { content: '', toolCalls: [{ id: 'external', type: 'function', function: { name: definitions.find(tool => tool.function.name.startsWith('mcp_')).function.name, arguments: '{"value":"agent"}' } }], model: config.model }; }
      return { content: 'done', toolCalls: [], model: config.model };
    });
    const client = { config, chat } as unknown as ModelClient;
    const agent = new Agent('fixture', 'reviewer', dir, client, new ModelRouter(config), new Tools(dir));
    expect(await agent.run('Inspect MCP evidence')).toBe('done'); expect(server.calls).toHaveLength(1);
  });
});
