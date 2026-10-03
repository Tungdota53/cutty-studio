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
export interface McpSelectionOptions { maxTools?: number; maxSchemaTokens?: number; maxInitialTools?: number }
export interface McpSearchOptions { serverId?: string; limit?: number; includeSchema?: boolean }
export interface McpCatalogOptions extends McpSearchOptions { query?: string; role?: Role; readOnlyTask?: boolean }
export interface McpToolInfo { id: string; serverId: string; name: string; title: string; description: string; readOnly: boolean; schemaTokens: number; inputSchema?: Tool['inputSchema']; schemaOmitted?: boolean }
export type McpDefinition = { type: 'function'; function: { name: string; description: string; parameters: Tool['inputSchema'] } };
interface Candidate { id: string; serverId: string; tool: Tool; definition: McpDefinition; info: McpToolInfo }
interface Entry { config: McpServerConfig; client?: Client; connecting?: Promise<void>; tools: Map<string, Tool>; error?: string; connected: boolean }
const registryCache = new Map<string, { hash: string; registry: McpRegistry }>();
function namespace(server: string, tool: string, display = tool) {
  return `mcp_${server.slice(0, 24)}_${display.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20)}_${createHash('sha256').update(server + '\0' + tool).digest('hex').slice(0, 8)}`;
}
function allowed(tool: Tool, role: Role, readOnly: boolean) {
  return tool.annotations?.readOnlyHint === true || (!readOnly && (role === 'coder' || role === 'general'));
}
const schemaTokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3) + 10;
function selectionLimits(options: McpSelectionOptions = {}) {
  const maxTools = options.maxTools ?? 12, maxSchemaTokens = options.maxSchemaTokens ?? 4096;
  if (!Number.isInteger(maxTools) || maxTools < 0 || maxTools > 32 || !Number.isInteger(maxSchemaTokens) || maxSchemaTokens < 0 || maxSchemaTokens > 65536) throw new Error('MCP selection budget must be 0–32 tools and 0–65536 schema tokens');
  const maxInitialTools = options.maxInitialTools ?? Math.ceil(maxTools / 2);
  if (!Number.isInteger(maxInitialTools) || maxInitialTools < 0 || maxInitialTools > maxTools) throw new Error('MCP initial selection must fit the active tool count budget');
  return { maxTools, maxSchemaTokens, maxInitialTools };
}
function relevance(candidate: Candidate, query: string) {
  const terms = [...new Set(query.slice(0, 8000).toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])].filter(term => term.length > 1).slice(0, 64);
  const name = `${candidate.tool.name} ${candidate.tool.title || ''}`.toLowerCase(), text = (candidate.tool.description || '').toLowerCase();
  return terms.reduce((score, term) => score + (name.includes(term) ? 4 : text.includes(term) ? 1 : 0), 0);
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
  private scrub(entry: Entry, value: unknown) {
    const config = entry.config;
    const secrets = config.transport === 'http'
      ? [...Object.values(config.headers || {}).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')]), ...new URL(config.url).searchParams.values()]
      : Object.entries(config.env || {}).filter(([key]) => /key|token|secret|password|credential/i.test(key)).map(([, value]) => value);
    const args = config.transport === 'stdio' ? config.args : [];
    args.forEach((arg, index) => {
      if (/token|secret|password|api[-_]?key|authorization|credential/i.test(arg)) {
        const separator = arg.indexOf('=');
        if (separator >= 0) secrets.push(arg.slice(separator + 1));
        else if (args[index + 1] && !args[index + 1].startsWith('-')) secrets.push(args[index + 1]);
      }
    });
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('[REDACTED]'), item) : item));
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
        let cursor: string | undefined; const seen = new Set<string>(); let catalogBytes = 0;
        for (let page = 0; page < 16; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: config.timeoutMs });
          for (const tool of result.tools) {
            if (config.toolNames && !config.toolNames.includes(tool.name)) continue;
            catalogBytes += Buffer.byteLength(JSON.stringify(tool), 'utf8');
            if (entry.tools.size >= 1024 || JSON.stringify(tool.inputSchema).length > 128000 || catalogBytes > 4 * 1024 * 1024) throw new Error('MCP tool catalog too large; configure toolNames to limit discovery');
            entry.tools.set(namespace(id, tool.name, this.scrub(entry, tool.name)), tool);
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
      return this.scrub(entry, { id, name: id, transport: config.transport, enabled: config.enabled, timeoutMs: config.timeoutMs, toolNames: config.toolNames, hasHeaders: config.transport === 'http' && !!Object.keys(config.headers || {}).length, hasEnv: config.transport === 'stdio' && !!Object.keys(config.env || {}).length, ...(url ? { url, hasUrlQuery: !!new URL((config as Extract<McpServerConfig, { transport: 'http' }>).url).search } : {}), ...(config.transport === 'stdio' ? { command: config.command, ...(hasSensitiveArgs ? { hasSensitiveArgs: true } : { args: config.args }) } : {}), status: !config.enabled ? 'disabled' : entry.connected ? 'connected' : entry.error ? 'error' : 'idle', toolCount: entry.tools.size, ...(entry.error ? { error: entry.error } : {}) });
    });
  }
  async discover(signal?: AbortSignal) {
    signal?.throwIfAborted();
    // A caller's cancellation only stops its wait, never another agent's shared handshake.
    await abortable(Promise.allSettled([...this.entries].filter(([, entry]) => entry.config.enabled).map(([id, entry]) => this.connect(id, entry))), signal);
    return this.statuses();
  }
  private candidate(serverId: string, entry: Entry, id: string, tool: Tool): Candidate {
      const safe = this.scrub(entry, tool) as Tool;
      const definition: McpDefinition = { type: 'function', function: { name: id, description: `[MCP ${serverId}; external tool] ${(safe.description || safe.name).slice(0, 1000)}`, parameters: safe.inputSchema } };
      const info: McpToolInfo = { id, serverId, name: safe.name, title: (safe.title || safe.annotations?.title || safe.name).slice(0, 256), description: (safe.description || '').slice(0, 500), readOnly: tool.annotations?.readOnlyHint === true, schemaTokens: schemaTokens(definition) };
      return { id, serverId, tool, definition, info };
  }
  private candidates(role: Role, readOnlyTask = false): Candidate[] {
    return [...this.entries].flatMap(([serverId, entry]) => [...entry.tools].filter(([, tool]) => allowed(tool, role, readOnlyTask)).map(([id, tool]) => this.candidate(serverId, entry, id, tool)));
  }
  private ranked(role: Role, readOnlyTask: boolean, query: string, serverId?: string) {
    if (query.length > 2000) throw new Error('MCP search query exceeds 2000 characters');
    return this.candidates(role, readOnlyTask).filter(item => !serverId || item.serverId === serverId)
      .map(item => ({ item, score: relevance(item, query) })).filter(({ score }) => !query.trim() || score > 0)
      .sort((a, b) => b.score - a.score || a.item.serverId.localeCompare(b.item.serverId) || a.item.id.localeCompare(b.item.id)).map(({ item }) => item);
  }
  async catalog(options: McpCatalogOptions = {}, signal?: AbortSignal): Promise<McpToolInfo[]> {
    const limit = options.limit ?? 24;
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('MCP catalog limit must be 1–64');
    // Validate before connecting so malformed queries cannot launch stdio servers.
    if ((options.query || '').length > 2000) throw new Error('MCP search query exceeds 2000 characters');
    await this.discover(signal);
    let remaining = 4096;
    const results: McpToolInfo[] = [];
    for (const item of this.ranked(options.role || 'general', !!options.readOnlyTask, options.query || '', options.serverId)) {
      let info: McpToolInfo = { ...item.info, ...(options.includeSchema ? { inputSchema: item.definition.function.parameters } : {}) };
      if (options.includeSchema && schemaTokens(info) > remaining) info = { ...item.info, schemaOmitted: true };
      const cost = schemaTokens(info);
      if (cost > remaining) continue;
      results.push(info); remaining -= cost;
      if (results.length >= limit) break;
    }
    return results;
  }
  async createSession(role: Role, readOnlyTask = false, task = '', signal?: AbortSignal, options: McpSelectionOptions = {}) {
    const limits = selectionLimits(options);
    await this.discover(signal);
    const candidates = this.candidates(role, readOnlyTask), queues = new Map<string, Candidate[]>();
    const scores = new Map(candidates.map(candidate => [candidate.id, relevance(candidate, task)]));
    // Rank within each server, then round-robin servers. One large catalog cannot
    // monopolize the initial selection; oversized schemas are skipped, not sent.
    for (const candidate of candidates) {
      const queue = queues.get(candidate.serverId) || [];
      queue.push(candidate); queues.set(candidate.serverId, queue);
    }
    for (const queue of queues.values()) queue.sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || a.id.localeCompare(b.id));
    const ordered = [...queues.values()].sort((a, b) => scores.get(b[0].id)! - scores.get(a[0].id)! || a[0].serverId.localeCompare(b[0].serverId));
    const session = new McpToolSession(this, role, readOnlyTask, limits);
    // Reserve count and schema space so deferred discovery can actually add tools.
    const initialSchemaBudget = Math.floor(limits.maxSchemaTokens * 0.7);
    while (ordered.some(queue => queue.length) && session.definitions().length < limits.maxInitialTools) {
      for (const queue of ordered) {
        const candidate = queue.shift();
        if (candidate && schemaTokens([...session.definitions(), candidate.definition]) <= initialSchemaBudget) session.activate([candidate.id]);
        if (session.definitions().length >= limits.maxInitialTools) break;
      }
    }
    return session;
  }
  async definitions(role: Role, readOnlyTask = false, signal?: AbortSignal, task = '', options: McpSelectionOptions = {}) {
    return (await this.createSession(role, readOnlyTask, task, signal, options)).definitions();
  }
  permittedDefinition(name: string, role: Role, readOnlyTask = false) {
    for (const [serverId, entry] of this.entries) {
      const tool = entry.tools.get(name);
      if (tool && allowed(tool, role, readOnlyTask)) return this.candidate(serverId, entry, name, tool).definition;
    }
  }
  safeIdentifier(name: string): string {
    for (const entry of this.entries.values()) name = this.scrub(entry, name);
    return name;
  }
  handles(name: string) { return [...this.entries.values()].some(entry => entry.tools.has(name)); }
  isReadOnly(name: string) { return [...this.entries.values()].some(entry => entry.tools.get(name)?.annotations?.readOnlyHint === true); }
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
      const serialized = JSON.stringify(this.scrub(entry, result));
      const output = serialized.length > 100000 ? { content: [{ type: 'text', text: serialized.slice(0, 50000) + '\n[MCP result truncated; refine query]' }] } : JSON.parse(serialized);
      return { ok: result.isError !== true, result: output, output: JSON.stringify(output), untrusted: true };
    } catch (error) { signal?.throwIfAborted(); return { ok: false, error: this.safeError(error) }; }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map(async entry => { await entry.connecting?.catch(() => {}); await entry.client?.close(); entry.connected = false; entry.tools.clear(); }));
  }
}

/** Active tools belong to one agent run, never to another agent sharing clients. */
export class McpToolSession {
  private active = new Map<string, McpDefinition>();
  constructor(private registry: McpRegistry, readonly role: Role, readonly readOnlyTask: boolean, readonly limits: { maxTools: number; maxSchemaTokens: number }) {}
  definitions() { return [...this.active.values()].map(definition => structuredClone(definition)); }
  async search(query: string, options: McpSearchOptions = {}, signal?: AbortSignal) {
    return this.registry.catalog({ ...options, query, role: this.role, readOnlyTask: this.readOnlyTask }, signal);
  }
  activate(names: string[]) {
    if (!Array.isArray(names) || names.length > 32 || names.some(name => typeof name !== 'string' || name.length > 128)) throw new Error('Activate 0–32 MCP tool IDs, each at most 128 characters');
    const activated: string[] = [], rejected: { id: string; reason: string }[] = [];
    for (const id of [...new Set(names)]) {
      if (this.active.has(id)) { activated.push(id); continue; }
      const definition = this.registry.permittedDefinition(id, this.role, this.readOnlyTask);
      if (!definition) { rejected.push({ id: this.registry.safeIdentifier(id), reason: 'Tool unavailable, excluded by server allowlist, or forbidden for this role' }); continue; }
      const next = [...this.active.values(), definition];
      if (next.length > this.limits.maxTools || schemaTokens(next) > this.limits.maxSchemaTokens) { rejected.push({ id, reason: 'Active MCP tool/schema budget exceeded; refine the task or increase its explicit budget' }); continue; }
      this.active.set(id, definition); activated.push(id);
    }
    return { ok: !rejected.length, activated, rejected, activeToolCount: this.active.size, schemaTokens: schemaTokens([...this.active.values()]), limits: { ...this.limits } };
  }
  handles(name: string) { return this.active.has(name); }
  isReadOnly(name: string) { return this.active.has(name) && this.registry.isReadOnly(name); }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.active.has(name)) return { ok: false, error: 'MCP tool is not active for this agent; use search_mcp_tools then activate_mcp_tools' };
    return this.registry.call(name, args, this.role, this.readOnlyTask, signal);
  }
}
