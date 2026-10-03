import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Role } from './types.js';

const common = { enabled: z.boolean().default(true), timeoutMs: z.number().int().min(1000).max(300000).default(30000), toolNames: z.array(z.string().min(1).max(256)).max(128).optional() };
export const mcpServerSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.literal('http'), url: z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'MCP URL must use HTTP(S), without URL credentials'), headers: z.record(z.string(), z.string()).optional() }),
  z.object({ ...common, transport: z.literal('stdio'), command: z.string().min(1).max(2000), args: z.array(z.string().max(10000)).max(100).default([]), env: z.record(z.string(), z.string()).optional() })
]);
export const mcpServersSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), mcpServerSchema).refine(value => Object.keys(value).length <= 32, 'At most 32 MCP servers');
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServersConfig = z.infer<typeof mcpServersSchema>;
export interface McpServerStatus { id: string; name: string; transport: 'http' | 'stdio'; enabled: boolean; url?: string; command?: string; args?: string[]; timeoutMs: number; toolNames?: string[]; hasHeaders: boolean; hasEnv: boolean; hasSensitiveArgs?: boolean; hasUrlQuery?: boolean; status: 'idle' | 'disabled' | 'connected' | 'error'; toolCount: number; error?: string }
export interface McpCallResult { ok: boolean; result?: unknown; output?: string; error?: string; untrusted?: boolean; [key: string]: unknown }
interface Entry { config: McpServerConfig; client?: Client; connecting?: Promise<void>; tools: Map<string, Tool>; error?: string; connected: boolean }
const registryCache = new Map<string, { hash: string; registry: McpRegistry }>();
function namespace(server: string, tool: string) {
  return `mcp_${server.slice(0, 24)}_${tool.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20)}_${createHash('sha256').update(tool).digest('hex').slice(0, 8)}`;
}
function allowed(tool: Tool, role: Role, readOnly: boolean) {
  return tool.annotations?.readOnlyHint === true || (!readOnly && (role === 'coder' || role === 'general'));
}
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('MCP cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One independent protocol client per named server; requests may execute concurrently. */
export class McpRegistry {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private workspace: string, servers: McpServersConfig = {}) {
    for (const [id, config] of Object.entries(mcpServersSchema.parse(servers))) this.entries.set(id, { config, tools: new Map(), connected: false });
  }
  static forWorkspace(workspace: string, servers: McpServersConfig = {}) {
    const key = path.resolve(workspace), hash = createHash('sha256').update(JSON.stringify(servers)).digest('hex');
    const current = registryCache.get(key);
    if (current?.hash === hash && !current.registry.closed) return current.registry;
    if (current) void current.registry.close();
    const registry = new McpRegistry(key, servers); registryCache.set(key, { hash, registry }); return registry;
  }
  static async closeAll() { const registries = [...registryCache.values()]; registryCache.clear(); await Promise.allSettled(registries.map(({ registry }) => registry.close())); }
  private safeError(error: unknown) {
    // Transport errors can echo bearer headers, environment or signed URL queries.
    // Preserve only a useful category; raw external error messages never reach logs/UI.
    if (error instanceof Error && (error.name === 'AbortError' || /timeout|timed out/i.test(error.message))) return 'MCP request timed out or was cancelled';
    if (error instanceof Error && /catalog too large|pagination budget/.test(error.message)) return 'MCP tool catalog exceeded budget; select toolNames in configuration';
    return 'MCP connection or request failed; check endpoint, authentication and server availability';
  }
  private async connect(id: string, entry: Entry) {
    if (this.closed) throw new Error('MCP registry closed');
    if (!entry.config.enabled || entry.connected) return;
    if (entry.connecting) return entry.connecting;
    entry.connecting = (async () => {
      const { Client: ClientConstructor } = await import('@modelcontextprotocol/sdk/client/index.js');
      const config = entry.config, client = new ClientConstructor({ name: 'vibe-studio', version: '1.0.0' }, { capabilities: {} });
      entry.client = client;
      client.onclose = () => { entry.connected = false; entry.tools.clear(); if (!this.closed) entry.error = 'MCP connection closed; refresh discovery to reconnect'; };
      const transport = config.transport === 'http'
        ? new (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')).StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
        : await (async () => { const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js'); return new StdioClientTransport({ command: config.command, args: config.args, env: { ...getDefaultEnvironment(), ...config.env }, cwd: this.workspace, stderr: 'ignore' }); })();
      try {
        const signal = AbortSignal.timeout(config.timeoutMs);
        await client.connect(transport, { signal, timeout: config.timeoutMs });
        let cursor: string | undefined; const seen = new Set<string>();
        for (let page = 0; page < 16; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: config.timeoutMs });
          for (const tool of result.tools) {
            if (config.toolNames && !config.toolNames.includes(tool.name)) continue;
            if (entry.tools.size >= 128 || JSON.stringify(tool.inputSchema).length > 32000) throw new Error('MCP tool catalog too large; configure toolNames to limit discovery');
            entry.tools.set(namespace(id, tool.name), tool);
          }
          if (!result.nextCursor) { entry.connected = true; entry.error = undefined; return; }
          if (seen.has(result.nextCursor)) throw new Error('MCP repeating pagination cursor');
          seen.add(result.nextCursor); cursor = result.nextCursor;
        }
        throw new Error('MCP tool catalog exceeded pagination budget');
      } catch (error) {
        entry.error = this.safeError(error); entry.tools.clear(); entry.connected = false;
        await client.close().catch(() => {}); entry.client = undefined;
        throw new Error(entry.error);
      }
    })();
    try { await entry.connecting; } finally { entry.connecting = undefined; }
  }
  statuses(): McpServerStatus[] {
    return [...this.entries].map(([id, entry]) => {
      const config = entry.config;
      let url: string | undefined;
      if (config.transport === 'http') { const publicUrl = new URL(config.url); publicUrl.search = ''; publicUrl.hash = ''; url = publicUrl.toString(); }
      const hasSensitiveArgs = config.transport === 'stdio' && config.args.some(arg => /token|secret|password|api[-_]?key|authorization|credential|https?:\/\/\S+\?/i.test(arg));
      return { id, name: id, transport: config.transport, enabled: config.enabled, timeoutMs: config.timeoutMs, toolNames: config.toolNames, hasHeaders: config.transport === 'http' && !!Object.keys(config.headers || {}).length, hasEnv: config.transport === 'stdio' && !!Object.keys(config.env || {}).length, ...(url ? { url, hasUrlQuery: !!new URL((config as Extract<McpServerConfig, { transport: 'http' }>).url).search } : {}), ...(config.transport === 'stdio' ? { command: config.command, ...(hasSensitiveArgs ? { hasSensitiveArgs: true } : { args: config.args }) } : {}), status: !config.enabled ? 'disabled' : entry.connected ? 'connected' : entry.error ? 'error' : 'idle', toolCount: entry.tools.size, ...(entry.error ? { error: entry.error } : {}) };
    });
  }
  async discover(signal?: AbortSignal) {
    signal?.throwIfAborted();
    // A caller's cancellation only stops its wait, never another agent's shared handshake.
    await abortable(Promise.allSettled([...this.entries].filter(([, entry]) => entry.config.enabled).map(([id, entry]) => this.connect(id, entry))), signal);
    return this.statuses();
  }
  async definitions(role: Role, readOnlyTask = false, signal?: AbortSignal) {
    await this.discover(signal);
    return [...this.entries].flatMap(([id, entry]) => [...entry.tools].filter(([, tool]) => allowed(tool, role, readOnlyTask)).map(([name, tool]) => ({ type: 'function' as const, function: { name, description: `[MCP ${id}; external tool] ${(tool.description || tool.name).slice(0, 1000)}`, parameters: tool.inputSchema } })));
  }
  handles(name: string) { return [...this.entries.values()].some(entry => entry.tools.has(name)); }
  async call(name: string, args: Record<string, unknown>, role: Role, readOnlyTask = false, signal?: AbortSignal): Promise<McpCallResult> {
    signal?.throwIfAborted();
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'MCP arguments must be a JSON object' };
    const pair = [...this.entries].find(([, entry]) => entry.tools.has(name));
    if (!pair) return { ok: false, error: 'MCP tool not discovered or server unavailable' };
    const [, entry] = pair, tool = entry.tools.get(name)!;
    if (!allowed(tool, role, readOnlyTask)) return { ok: false, error: `Role ${role} cannot use this mutating MCP tool` };
    if (!entry.client || !entry.connected || this.closed) return { ok: false, error: 'MCP server is not connected' };
    try {
      // Tool mutations are never automatically retried; cancellation is forwarded to the server.
      const result = await entry.client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: entry.config.timeoutMs, maxTotalTimeout: entry.config.timeoutMs });
      const secrets = entry.config.transport === 'http'
        ? [...Object.values(entry.config.headers || {}).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]), ...new URL(entry.config.url).searchParams.values()]
        : Object.entries(entry.config.env || {}).filter(([key]) => /key|token|secret|password|credential/i.test(key)).map(([, value]) => value);
      const serialized = JSON.stringify(result, (_key, value) => typeof value === 'string' ? secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) : value);
      const output = serialized.length > 100000 ? { content: [{ type: 'text', text: serialized.slice(0, 50000) + '\n[MCP result truncated; refine query]' }] } : JSON.parse(serialized);
      return { ok: result.isError !== true, result: output, output: JSON.stringify(output), untrusted: true };
    } catch (error) { signal?.throwIfAborted(); return { ok: false, error: this.safeError(error) }; }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map(async entry => { await entry.connecting?.catch(() => {}); await entry.client?.close(); entry.connected = false; entry.tools.clear(); }));
  }
}
