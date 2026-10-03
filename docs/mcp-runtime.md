# Multiple MCP servers in Vibe

Vibe uses the official TypeScript MCP SDK client. Supported transports are Streamable HTTP and explicitly configured local stdio processes. Server definitions live in `mcpServers` in `.vibe/config.json`; each key is a unique server ID. MCP OAuth and legacy SSE transports are not implemented in this version. HTTP credentials can be supplied using headers; local processes can receive explicitly configured environment variables.

```json
{
  "mcpServers": {
    "docs": { "transport": "http", "url": "http://127.0.0.1:8080/mcp", "enabled": true, "timeoutMs": 30000 },
    "local": { "transport": "stdio", "command": "node", "args": ["D:/tools/mcp-server.js"], "enabled": false }
  }
}
```

The `toolNames` array optionally limits discovery to exact server tool names. Discovery accepts up to 128 tools per server and 16 pages, rejecting an oversized catalog rather than silently presenting an incomplete list. Each server has a separate protocol client. Shared initialization is deduplicated; concurrent tool requests use their own request IDs and cancellation signals. A server connection failure does not disable another server. Cancellation stops only the caller's wait during shared initialization; tool cancellation is forwarded using the MCP SDK. Mutation requests are not automatically replayed.

`Agent.run` discovers enabled servers and adds namespaced functions to its model tool definitions. Server tool names do not collide with built-in tools or tools from other servers. `readOnlyHint: true` is required for planner, orchestrator, reviewer, judge, tester and read-only tasks. Unannotated tools are treated as mutations and can run only for coder or general agents with writable tasks. An annotation is a declaration by the configured server, not an operating-system sandbox: configure only servers you trust. MCP content remains untrusted external evidence, and `isError` responses are retained as failures.

Integration API from `src/mcp.ts`:

- `mcpServersSchema.parse(value)` validates the named server record.
- `McpRegistry.forWorkspace(workspace, servers)` shares connections for unchanged configuration and replaces the registry when configuration changes.
- `registry.statuses()` returns redacted configuration/status without connecting.
- `await registry.discover(signal?)` connects enabled servers concurrently and returns statuses; a failed server remains visible as an error.
- `await registry.definitions(role, readOnlyTask, signal?)` returns allowed OpenAI function definitions.
- `await registry.call(name, args, role, readOnlyTask, signal?)` executes a discovered tool and returns `ok`, redacted `result`/`output`, or a safe error.
- `await registry.close()` and `await McpRegistry.closeAll()` close owned transports and stdio children.
- `tools.setMcp(registry)` enables the same policy for direct `Tools.run` calls; the Agent integration checks its own role independently.

Statuses expose `id`, `name`, `transport`, `enabled`, `timeoutMs`, optional `toolNames`, safe `url`/`command`/`args`, credential-presence flags, connection status, tool count and a safe error. Header values, environment values, URL queries and arguments detected as credential-bearing are withheld. Configuration editors must merge omitted credential fields with existing local configuration; an unchanged sanitized URL should retain its original query. Clearing a secret requires an explicitly supplied empty object/value. Output redaction covers configured HTTP credentials/query values and environment variables with secret-related names; this cannot identify arbitrary private content supplied by a server.

Reference: [official SDK client documentation](https://ts.sdk.modelcontextprotocol.io/client).
