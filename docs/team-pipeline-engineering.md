# Engineering the Teamwork pipeline

## Implementation basis

The installed planner has a deterministic dependency scheduler and specialist workers. It supports independent work at once, serializes overlapping file ownership, pauses source mutation while validators inspect stable code, and records executed command evidence. This design extends those existing contracts instead of introducing a second agent runtime.

Current references support three design choices:

1. Split a request only where work has independent boundaries. Give each worker one concrete objective, expected output, tools and file scope. Measure coordination and tool costs; more agents do not automatically improve a coding task. [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) describes the orchestrator/worker pattern, parallel branches, clear delegation boundaries, effort limits and workflow evaluation. Its numeric research results are specific to its internal research system and are not product guarantees for Vibe.
2. Keep scheduling in application code where dependency, concurrency and locking rules must be repeatable. Use model judgment for decomposition and repair hints, then validate the result against the typed DAG contract. [OpenAI Agents SDK orchestration guidance](https://openai.github.io/openai-agents-python/multi_agent/) distinguishes manager orchestration and handoffs and discusses concurrent work; [OpenAI orchestration guidance](https://developers.openai.com/api/docs/guides/agents/orchestration) cautions that splitting too early adds prompts, traces and approval surfaces.
3. Preserve state as inspectable checkpoints. Each session now writes `pipeline.json` with sequence/time, phase/status per task, criteria, required commands, bounded check output, stale-evidence flags, peak concurrency, tool count, gate and repair history. `events.jsonl` stores lifecycle events. These aid diagnosis and reconnection; they do not claim that a process restart safely replays side effects. The distinction matches [LangGraph persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence), which separates run checkpoints from cross-run stores and calls out recovery/thread continuity.

## Runtime flow

`survey → specification → test_design → implementation → verification + review + challenge → audit → acceptance`

The planner chooses a proportionate subset. Independent tasks are released as soon as dependencies and file ownership allow. A longest-remaining-dependency-chain heuristic reduces avoidable downstream idle time; it ranks by task count because model runtimes are not known before execution. Validators run together against stable files. If several gate agents fail, the scheduler waits for every active validator, collects all findings into a single bounded repair (at most two repair rounds), invalidates downstream gate evidence and reruns affected gates. A failure in transport, cancellation, checkpoint storage or unowned source does not masquerade as a code fix.

The live map reports task/phase, actual model, active and peak slots, tool calls, executed checks, repair rounds, plan diagnostics and acceptance verdict. On reconnect, the server sends the saved pipeline artifact with the task history. Task output is still a claim: gates require inspection and recorded execution evidence. Natural-language criteria need reviewer judgment.

## Scope and limits

The pipeline caps plans at 40 tasks and repairs at two rounds. File ownership prevents cooperating coder agents from overlapping expected files; shell commands are still trusted project commands and are not OS-sandboxed by those paths. A run interrupted by process shutdown is recorded when the app can handle the shutdown, but automatic exactly-once resume is not implemented: replaying a write or shell command needs an idempotency/effect ledger. `pipeline.json` is diagnostic evidence, not a distributed queue, billing meter, proof of coverage or guarantee that an external model obeyed instructions.
