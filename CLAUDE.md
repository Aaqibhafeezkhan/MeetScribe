# CLAUDE.md

MeetScribe: Electron app that transcribes meetings locally (faster-whisper via Python workers) in a screen-share-invisible overlay. Two streams: system audio = "Them", mic = "You". After the meeting an offline pass re-transcribes archived audio with a bigger model. No cloud, no API keys. Windows-first. Apache-2.0.

Read `docs/ARCHITECTURE.md` before touching the pipeline.

## Commands

```bash
npm install
npm start               # launcher (unsets ELECTRON_RUN_AS_NODE); npm run dev adds --no-sandbox
npm run check           # node --check all JS + parse all scripts/*.py. MUST pass before commit
npm test                # unit tests (node:test, tests/*.test.js). MUST pass before commit
npm run setup:whisper   # create venv + download model (or Settings > Transcription)
npm run build:win       # electron-builder, output in dist/
```

Unit tests cover pure logic only (no Electron, no audio); use synthetic text. There is no linter yet. `npm run check` + `npm test` are the gate. For behavior changes, say how you verified by hand.

## Map

- `main.js`: lifecycle + all `ipcMain.handle` channels. `preload.js`: the only renderer bridge (contextIsolation on, nodeIntegration off).
- `src/core/`: `config.js` (shipped defaults), `settings.store.js` (user JSON in userData), `logger.js`.
- `src/services/`: `transcription.service.js` (orchestrator, echo suppression), `transcription-stream.js` (VAD, utterances, hallucination filter), `whisper-pool.service.js` + `whisper-worker.service.js` (Python workers, JSON-lines over stdio), `meeting.service.js` (ordered, fsync'd transcript), `audio-archive.service.js`, `offline-pass.service.js`, `capture.service.js`.
- `src/managers/window.manager.js`: windows, click-through, stealth. `src/ui/`: renderer scripts.
- `scripts/`: `start.js`, `setup-whisper.js`, `whisper_worker.py` (live), `whisper_offline.py` (final pass), `transcode_flac.py`, `check.js`.

## Conventions and gotchas

- Match surrounding code. 2-space JS, 4-space Python, LF endings. Log via `createServiceLogger`, not `console.log`, in `src/`.
- New user setting = default in `config.js` + key in `settings.store.js` + UI in `settings.html`/`settings-window.js` (+ IPC in `main.js`/`preload.js`).
- Version lives in **both** `package.json` and `src/core/config.js`. Bump together (`/release`).
- New Python scripts used at runtime must be added to `build.asarUnpack` in `package.json`.
- Python 3.11 to 3.13 only (ctranslate2 has no 3.14 wheels). No ffmpeg dependency (PyAV).
- `assests/` is a typo kept on purpose until the rename issue lands; the build references it.
- Never set `ELECTRON_RUN_AS_NODE`; always launch through `scripts/start.js`.
- Audio timestamps are wall-clock and taken **before** VAD. Do not move archive taps after VAD.
- Worker protocol is JSON lines on stdout: never `print()` anything else from Python workers.

## Privacy rules (hard)

- Never read, print, commit or paste meeting transcripts, audio (`.wav`/`.flac`), `timeline.jsonl`, or `~/Documents/MeetingTranscripts`. Hooks block this; do not work around them.
- Never commit personal emails, local absolute paths, or secrets. Use the GitHub noreply email for commits. Never use work addresses.
- Screenshots/examples must use fake content.
- **Nothing from the owner's work or private life may appear anywhere public** (issues, PRs, commits, comments, docs, code, tests, fixtures): no employer or client names, no names of their other or internal projects, products, tools or colleagues, no real glossary terms, and no details from real meetings. When the user pastes such context, use it only to understand the task, then rewrite it with invented stand-ins (e.g. "Acme", "AcmeTrakr") before anything is posted or committed. If unsure whether something is private, treat it as private. Do not list the forbidden names in the repo either; this rule must stay generic.

## Git workflow

- Branches: `feat/`, `fix/`, `docs/`, `chore/` from `main`. Never push to `main` directly.
- Conventional Commits. Small logical commits. Run `npm run check` first.
- PRs use `.github/PULL_REQUEST_TEMPLATE.md`; link issues with `Closes #n`.
- Commit with the GitHub noreply email (`git config user.email`), never a work or personal address.

## Agentic workflow

- Plan first for anything touching more than 2 files or the audio pipeline.
- Subagents in `.claude/agents/`: `code-reviewer`, `electron-debugger`, `whisper-python-specialist`, `docs-writer`, `issue-triager`. Delegate matching work.
- Slash commands in `.claude/commands/`: `/fix-issue <n>`, `/ship`, `/release <version>`, `/triage`, `/update-docs`.
- Hooks (`.claude/settings.json`): syntax check after JS/Python edits; guard blocking secrets and meeting data.
- Prefer issues labeled `good first issue` / `help wanted` as work units; each has acceptance criteria.
