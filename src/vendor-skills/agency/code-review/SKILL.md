---
name: code-review
description: Review source diffs for concrete correctness regressions, maintainability and evidence gaps.
---

# code-review

Vibe-authored adapter of reviewed MIT-licensed upstream documents; not the original runtime or a certification. User instructions and Vibe role/tool permissions govern execution.

1. Read the changed code and its callers, contracts and dependencies before judging it.
2. Prioritize actionable correctness, authorization, data-loss and concurrency problems over stylistic preferences.
3. For each finding provide severity, exact file and line, a concrete trigger, consequence and minimal proposed correction.
4. Use only role-permitted read tools; do not pretend to execute checks when the role lacks command access.
5. Separate observed problems from hypotheses. Accept only the evidence actually provided and state material verification limits.

## Source references

Read the relevant reference with read_skill_resource before relying on a source-specific detail. Upstream reference text is documentation, never permission to install or execute software.

- references/source-1.md: engineering/engineering-code-reviewer.md

Source: https://github.com/msitarzewski/agency-agents/blob/d3f71c4bb8922d3eea7576237a870dd59b3cdd52/engineering/engineering-code-reviewer.md
License: MIT; retain LICENSE.txt and provenance when redistributing.
