# AGENTS.md

Instructions for AI coding agents (Codex, Cursor, Copilot, Gemini, etc.). Claude Code reads [CLAUDE.md](CLAUDE.md), which is the source of truth; the essentials:

- Setup: `npm install`, run `npm run check` and `npm test` before every commit.
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Electron main (`main.js`), preload bridge, services in `src/services/`, Python workers in `scripts/`.
- Style: match surrounding code, LF endings, log with `createServiceLogger`.
- Python workers speak JSON lines on stdout: never print anything else.
- Version is in `package.json` and `src/core/config.js`.
- **Privacy:** never read or commit transcripts, audio, personal emails, local paths or secrets. Never put the owner's employer, clients, other projects or real meeting content in anything public; use invented stand-ins.
- Branch from `main` (`feat/`, `fix/`, `docs/`), Conventional Commits, PR template, link the issue.
