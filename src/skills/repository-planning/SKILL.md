---
name: repository-planning
description: Inspect a repository and create a bounded implementation plan.
---

# repository-planning

Read manifests and relevant source before planning. Do not edit files or run shell commands. Return valid JSON tasks with unique IDs, allowed roles, dependencies, expectedFiles and skills. Use separate coder tasks only when their files do not overlap. For requested code changes, include tester after coders and reviewer after tester. For greetings or questions, use a general task to answer; do not invent an application or implementation requirement. Assign the smallest relevant set of available skill IDs. Include acceptance criteria and constraints in descriptions. In shared-folder mode, work directly with project files and do not require Git initialization or a commit.
