# Session workbench

Open **Công cụ phiên** in the toolbar. This panel operates on the currently selected chat or Teamwork session.

Pins and workspace files supply explicit user context; protected content stays in subsequent model requests and compaction cannot silently remove it. Attachment content is snapshotted, bounded and redacted. Remove and reattach a source after changing its file. Token counts are estimates.

File writes and edits create local before/after checkpoints independently of Git. Commands capture bounded eligible files, and coder tasks restrict snapshots to assigned files. Inspect a checkpoint, select files, then restore. Restore checks every selected file against recorded content before applying changes; later user changes cause a conflict instead of being overwritten. Secrets, generated files, symlinks and unreadable files are excluded; coverage warnings appear in the panel. An interrupted shell operation without a trustworthy post-state requires manual inspection.

The resume button becomes available for interrupted durable runs. Chat tool batches record their pending state before side effects and completed outputs afterward. Recovery reconstructs results, marks uncertain effects and rejects replay of matching mutations. Teamwork stores its plan, tasks, evidence and source fingerprints; it skips completed tasks only while their recorded source remains valid. Sessions created before durable journaling cannot automatically resume.

Budgets apply to each agent/task and include context summarization. Zero is unlimited. Cost calculations require user-configured rates for the exact model; unknown cost is displayed explicitly. Caps stop the next request after observed usage reaches the limit, so a response already in flight can exceed the cap. Provider charges from failed streams may be unavailable.

MCP catalog search shows tools without injecting every schema into model input. Agents start with a task-ranked subset distributed across servers, then search and activate additional permitted tools within their schema budget. Read-only metadata is a server declaration; it is not a process sandbox.

**Preview** opens a workspace HTML entry with local CSS, JavaScript and web assets in a separate nonce-scoped loopback server and sandboxed iframe. Web-file changes trigger refresh; manual refresh is also available. Console output, JavaScript errors and rejected promises appear below the page. Preview blocks internal files, unsupported types, credentials, outbound connections and form submission. It currently supports static/build output rather than a Vite/Next.js development server.
