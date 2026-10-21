---
description: Sync docs with recent code changes
---

Use the `docs-writer` subagent: compare `git log --oneline main..HEAD` and the diff against README, docs/ARCHITECTURE.md, CONTRIBUTING.md and CHANGELOG.md, and update anything stale. Summarize what changed.
