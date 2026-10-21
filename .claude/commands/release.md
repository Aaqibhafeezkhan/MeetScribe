---
description: Prepare a release - bump versions, changelog, tag
argument-hint: <version e.g. 1.2.0>
allowed-tools: Bash(git:*), Bash(npm run check), Read, Edit
---

Prepare release $ARGUMENTS.

1. Require a clean tree on `main` and `npm run check` passing.
2. Bump `version` in `package.json` **and** `src/core/config.js` to $ARGUMENTS.
3. Move `[Unreleased]` entries in `CHANGELOG.md` under `[$ARGUMENTS] - <today>` and add a fresh `[Unreleased]`.
4. Commit `chore(release): v$ARGUMENTS` on a `chore/release-$ARGUMENTS` branch and open a PR.
5. Do NOT tag or push tags. After merge, tell me to run `git tag v$ARGUMENTS && git push origin v$ARGUMENTS`, which triggers the release workflow.
