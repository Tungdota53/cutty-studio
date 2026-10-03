# Task-specific MCP discovery

Vibe discovers configured HTTP/stdio server catalogs through MCP `tools/list`, but does not append every server schema to every model request. Each agent run creates a separate `McpToolSession`; shared clients do not share its active-tool list.

## Selection and deferred discovery

The initial selection ranks tool names/titles/descriptions against the task, groups candidates by server and round-robins those ranked groups. A large server cannot monopolize every initial slot while a smaller server has a fitting candidate. Stable tie-breaks use server/tool IDs. Limits remain finite: default twelve active tools, six initially selected, and 4,096 estimated schema tokens. Initial selection uses at most 70% of the schema budget, leaving room for deferred activation. Agent integration may lower the budget to match the available context.

`search_mcp_tools` queries the actual configured catalog with role filtering, an optional server ID and bounded metadata results. `activate_mcp_tools` adds exact namespaced IDs to the current session and refreshes the next model request. An omitted tool remains discoverable; it cannot be invoked before activation. Activation preserves all earlier active schemas, checks permissions again, and reports count/schema budget rejection instead of silently evicting tools or sending an oversized prompt. Searches do not execute the external tool.

The registry API is `createSession(role, readOnlyTask, task, signal, { maxTools, maxSchemaTokens, maxInitialTools })`. Session methods are `definitions`, `search`, `activate`, `handles`, `isReadOnly` and `call`. `catalog({ serverId, query, role, readOnlyTask, limit, includeSchema })` supplies the settings UI with safe IDs, titles, descriptions, read-only hints and estimated schema costs. Schemas are omitted unless explicitly requested; catalog replies have a separate 4,096-token estimate cap and at most 64 results. Default UI pagination size is 24; search/server filters find omitted entries without loading the complete catalog into a prompt.

## Bounds and trust

Discovery supports at most 1,024 allowlisted tools per server, sixteen catalog pages, 128,000 schema characters per tool and 4 MB total retained catalog bytes per server. Exceeding these bounds produces a server diagnostic directing the user to configure `toolNames`; it does not pretend the omitted catalog is available. The existing tool allowlist applies before selection and search. Disabled/disconnected servers cannot serve calls. Namespace hashes include both the full server ID and upstream tool name, preventing collisions when their readable prefixes coincide.

Reviewer/planner/judge/tester sessions expose tools only when the configured server declares `readOnlyHint: true`; coder/general sessions may expose mutations unless the task is read-only. Both discovery and invocation enforce this policy. **Annotations are server declarations, not a sandbox or proof of harmlessness.** Configure only trusted servers and narrow their `toolNames` allowlist. This follows the [MCP tools specification's annotation trust boundary](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). No tool mutation is automatically replayed by the MCP layer.

Tool metadata/results and status views scrub configured header, URL-query and sensitive environment/argument values. Raw transport errors are replaced with safe categories; search validation errors do not echo the query. Catalog data and tool results remain external, untrusted content. Redaction covers known configured credentials and does not claim to detect arbitrary unknown secrets from a remote service.

## Verification

HTTP fixtures exercise a 201-tool catalog, task ranking across servers, deferred discovery/activation, stable active definitions, inactive-call rejection, role isolation, oversized schema rejection, secret-bearing metadata, query bounds and long-server namespace collisions. Existing HTTP/stdio integration, connection isolation, cancellation, no-replay and real Agent-loop coverage remain in `tests/mcp.test.ts`.
