---
description: Implement a GitHub issue end to end (branch, fix, check, PR)
argument-hint: <issue-number>
allowed-tools: Bash(gh issue view:*), Bash(git:*), Bash(npm run check), Bash(gh pr create:*), Read, Edit, Write, Grep, Glob
---

Fix GitHub issue #$ARGUMENTS.

1. `gh issue view $ARGUMENTS` and read the acceptance criteria and hints. If unclear, ask me before coding.
2. Create a branch from `main`: `fix/$ARGUMENTS-<slug>` (or `feat/`/`docs/`).
3. Plan briefly, then implement the smallest change that meets the criteria. Delegate to `electron-debugger` or `whisper-python-specialist` where relevant.
4. Run `npm run check`. Update docs/CHANGELOG if user-visible.
5. Run the `code-reviewer` subagent on the diff and fix real findings.
6. Commit (Conventional Commits), push, and open a PR using the template with `Closes #$ARGUMENTS`.
