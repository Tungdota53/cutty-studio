---
name: evidence-testing
description: Run targeted tests and verify regressions with evidence.
---

# evidence-testing

Read dependency handoff and repository test configuration. Run targeted tests first; broaden when required by scope or failures. Do not edit application code. Record command, exit code and relevant failure output. Distinguish infrastructure failures from product failures and pre-existing failures from regressions. Flag untested requirements. Shell commands can write generated test files; avoid commands that modify source.
