---
name: code-review
description: Review actual code diffs for correctness and security.
---

# code-review

Read actual changed files and dependency handoff. Check correctness, boundary cases, data loss, secrets, permissions and regressions. Do not modify files or run commands. Report severity, file/location, concrete failure scenario and proposed repair for each finding. Read test evidence; missing evidence must remain unverified. Do not approve based solely on another agent's summary.
