# Context recovery — 0.10.1

## Hardening in 0.10.2

- Preserve short historical user turns (up to 512 estimated serialized tokens each) verbatim through repeated compaction. Longer historical user excerpts precede bulky tool records; their omissions remain explicit. Protected turns that alone exceed the budget are rejected without deleting them.
- `recall_context` retrieves original archived records only from the current chat/task. It supports literal search, stable archive IDs, older-page cursors and bounded Unicode excerpts. Task archives never become authoritative instructions or a substitute for independent checks. Old pre-archive history may not be retrievable.
- Compaction has a 30-second request timeout and one provider attempt before local recovery. Normal requests keep their existing retry policy.
- Empty provider streams cannot complete a task. Length/content-filter termination, malformed tool arguments and duplicate tool IDs reject the batch before execution. A stream error after text or tool deltas prevents both replay and fallback to another model.
- Router uses the effective run configuration and deduplicates model IDs. Tool-budget checks occur before the entire batch, avoiding partial writes caused by exceeding the budget midway.
- Verification: 289 tests across 21 files passed, including local HTTP fixtures for stream integrity, task-isolated archive retrieval and repeated compaction. These fixtures do not establish success against a user's live API provider.

The stream termination policy follows [OpenAI SDK helpers](https://github.com/openai/openai-node/blob/main/docs/helpers.md), which reject length/content-filter finishes before invoking tools. Original-record retrieval applies the just-in-time context approach described in [Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). This remains local Chat Completions context management, with no claim of native vendor compaction equivalence.

## Incident and actual causes

The supplied run failed in T4 when the compactor returned an empty/invalid response and in T5 when protected recent messages exceeded the 32,768-token window. Tests and audits never ran because their implementation dependency failed. The planner also required shell commands on roles that cannot execute them. These are independent issues; increasing the context setting alone is not a fix.

## Implemented recovery pipeline

1. Resolve the selected model's configured context limit and cap it by the session limit. Reserve output and safety overhead before allocating input.
2. Allocate at most one quarter of input to skill instructions. Skills that do not fit remain discoverable through exact IDs and `read_skill_resource`; large instructions are fetched when needed. Planner receives a bounded relevant skill catalog instead of all descriptions and agent instructions.
3. Measure the complete serialized dependency handoff, including file manifests and Unicode text. Mark omissions explicitly. Fresh audits do not receive predecessor verdicts.
4. Preserve the original and latest user messages. Retain tool-call/result groups atomically; a completed large write can be summarized even when recent. Internal progress reminders no longer masquerade as new user requests.
5. Make at most one compactor call per preparation. Bound the transcript before sending it, and bound the returned summary. Empty responses, unexpected tool calls and temporary summary failures use labeled extractive excerpts. Cancellation preserves the conversation. Full tool exchanges remain archived by the caller.
6. Commit compacted context only if the resulting serialized request fits and is smaller. Show whether the memory came from the model or extractive recovery, along with estimated before/after sizes.
7. A provider context rejection before visible output can trigger one retry, only when forced compaction actually reduces the request. No tool mutation is replayed by this retry.
8. Reject impossible read-only verification assignments during plan validation and ask the existing plan-repair loop to move checks to executable roles. Keep independent testing/review gates enforced.
9. Report execution root errors first and trace blocked descendants to those roots. Do not present unexecuted downstream validators as separate failed tests. Read exit status only from the tool runner header, not command output text.

## Validation

Regression coverage includes huge recent `write_file` arguments, Vietnamese/Japanese/emoji text, empty/tool-calling/oversized/unavailable summary replies, cancellation, preserved user instructions, archived history, single execution of writes, small model skill budgets, impossible role assignments, blocked dependency diagnosis and durable redacted checkpoints.

An offline replay reads copies of seven checkpoints from the reported session with a deliberately empty summarizer. It does not modify the failed project, execute its commands, or call a provider. This checks context recovery, not the generated website's correctness or live model behavior. The test environment explicitly controls terminal color so launcher `NO_COLOR` cannot break rendering fixtures.

## Engineering references and limits

- [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): compaction and just-in-time retrieval informed bounded skill disclosure and concise task handoffs.
- [OpenAI: Compaction](https://developers.openai.com/api/docs/guides/compaction): distinguishes native server-side compaction from a local transcript summary. This application's compatible Chat Completions backend uses the local mechanism; it does not claim to reproduce encrypted native compaction.

Token estimates use UTF-8 byte accounting, not each provider's exact tokenizer. Model limits must be configured accurately. Extractive recovery is explicitly incomplete and requires rereading files before relying on omitted details. A user request/system prompt that alone exceeds the hard input budget is rejected without silently deleting instructions. Crash-resume with shell side-effect replay is not implemented. Existing failed runs are not automatically rerun or marked successful.
