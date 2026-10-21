# AGENTS.md

Instructions for AI coding agents (Codex, Cursor, Copilot, Gemini, etc.). Claude Code reads [CLAUDE.md](CLAUDE.md), which is the source of truth; the essentials:

- Setup: `npm install`, run `npm run check` before every commit (no test suite yet).
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Electron main (`main.js`), preload bridge, services in `src/services/`, Python workers in `scripts/`.
- Style: match surrounding code, LF endings, log with `createServiceLogger`.
- Python workers speak JSON lines on stdout: never print anything else.
- Version is in `package.json` and `src/core/config.js`.
- **Privacy:** never read or commit transcripts, audio, personal emails, local paths or secrets.
- Branch from `main` (`feat/`, `fix/`, `docs/`), Conventional Commits, PR template, link the issue.
