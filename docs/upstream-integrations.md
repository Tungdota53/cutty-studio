# Reviewed upstream integrations

These integrations import reviewed, immutable documents and adapt them to Vibe's existing permissions, tooling and bounded skill loader. They do not install an external agent runtime or claim certification. Hash checks detect changes to bundled files; they are not a signature or an independent security audit.

## Pinned sources

| Source | Commit | License | Included adaptation |
| --- | --- | --- | --- |
| [Agency Agents](https://github.com/msitarzewski/agency-agents/tree/d3f71c4bb8922d3eea7576237a870dd59b3cdd52) | `d3f71c4bb8922d3eea7576237a870dd59b3cdd52` | MIT | Eight role skills: frontend, backend, UX architecture, application security, test automation, verification evidence, multi-agent architecture, code review |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach/tree/a19a171fa980a0785849596492e0af4db800c82f) | `a19a171fa980a0785849596492e0af4db800c82f` | MIT | Public-web research skill adapting channel availability, actual backend probing, isolated failures and evidence provenance |
| [Orca](https://github.com/stablyai/orca/tree/1fc24d311481a85d5b4ae596898ee072389f040c) | `1fc24d311481a85d5b4ae596898ee072389f040c` | MIT | Isolated-agent workflow skill adapting supervised task ownership, worktree isolation and immutable skill provenance |

Each added skill includes a Vibe-authored `SKILL.md`, the unmodified source documents in `references`, the upstream `LICENSE.txt` and a SHA-256 `.provenance.json` manifest. Provenance exposes the adapter attribution and original source paths. Automatic selection applies role and topic matching, only loads verified bundles, and respects the existing limit of two recommended additions, eight total skills and 24,000 instruction characters. Users can disable auto-selection or choose exact IDs.

## Concrete integration boundaries

Agency documents contain useful domain workflows but also opinionated defaults and assumed tooling. Vibe adapters keep relevant practices and observed-evidence requirements, without importing an agent persona, arbitrary release metric, permission change or automatic dependency installation. A role document itself provides no scheduler, runtime, performance guarantee or security certificate.

Agent-Reach's `Channel` contract distinguishes preferred candidates from the backend actually serving requests; its doctor isolates errors and scrubs credential-bearing URLs. The adapter uses Vibe's available `read_public_url` tool and repository tools, records source provenance and reports blocked channels honestly. Importing these references does **not** enable Agent-Reach's social-account platforms, cookies, YouTube transcripts, MCP servers or CLI.

Orca's orchestration skill is a discovery stub that requires its own version-matched binary guide. Vibe therefore preserves it as reference material rather than loading it as direct Orca commands. The authored adapter uses Vibe's real DAG, permissions and workspace facilities. It does **not** install Orca, expose remote runtimes or implement Orca's skill-sharing cloud service.

## Reproduce the document import

Run `node scripts/import-upstream-skills.mjs` from the repository root. Sources and adapter text are defined in `scripts/upstream-skill-sources.mjs`; commits are fixed 40-character hashes. The importer downloads only listed documentation and MIT license files, bounds each download to 1 MB, writes no outside workspace path, and executes no upstream code. Updating a source commit is a reviewed source change; repeat license and content review before changing it.

The existing manifest script maintains earlier bundled providers. The new importer maintains manifests for these ten adapters. Tests cover source attribution, exact commits, license/reference access, role routing, context limits and tampered-reference rejection.
