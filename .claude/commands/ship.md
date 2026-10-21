---
description: Check, commit, push the current branch and open a PR
allowed-tools: Bash(git:*), Bash(npm run check), Bash(gh pr create:*), Bash(gh pr view:*)
---

Ship the current branch.

1. Refuse if on `main`. Show `git status` and `git diff --stat`.
2. Run `npm run check`; stop on failure.
3. Scan the diff for privacy leaks: transcripts, audio, personal emails, absolute local paths, secrets. Stop if found.
4. Commit in logical Conventional Commits (split unrelated changes).
5. `git push -u origin HEAD`, then `gh pr create` with the PR template filled in (what/why, how tested, checklist).
6. Print the PR URL.
