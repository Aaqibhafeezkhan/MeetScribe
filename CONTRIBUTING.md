# Contributing to MeetScribe

Thanks for helping! This project is built to be easy to contribute to.

## Find something to work on

- [`good first issue`](https://github.com/AmineChr54/MeetScribe/labels/good%20first%20issue): small, well-scoped, with file pointers
- [`help wanted`](https://github.com/AmineChr54/MeetScribe/labels/help%20wanted): bigger, welcome from anyone
- Have an idea? Open a **Feature request** or start a Discussion first for large changes.

Comment on an issue to claim it. If you go quiet for two weeks it may be reassigned, no hard feelings.

## Set up in 5 minutes

Requirements: Node.js 20+, Python 3.11 to 3.13, Windows 10/11 for end-to-end audio testing (other OSes can work on non-audio code, and Linux/macOS audio is an open issue).

```bash
git clone https://github.com/<you>/MeetScribe.git
cd MeetScribe
npm install
npm run check     # must pass
npm test          # must pass
npm start
```

Set up Whisper from Settings → Transcription (or `npm run setup:whisper`). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map of the code.

## Workflow

1. Fork, then branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
2. Keep PRs focused, one concern each.
3. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(offline): ...`, `fix(vad): ...`.
4. Run `npm run check` and `npm test` before pushing.
5. Open a PR with the template. Link the issue (`Closes #123`). Describe how you tested it. Screenshots are welcome but **must not show real meeting content or names**.

## Style

- 2-space JS, 4-space Python, LF line endings (`.editorconfig` and `.gitattributes` enforce this).
- Match surrounding code. Log through `createServiceLogger`, not `console.log`.
- Don't reformat files you aren't changing.

## Privacy rules (hard rules)

Never commit or paste in issues/PRs: transcripts, meeting audio (`.wav`, `.flac`), `timeline.jsonl`, logs containing speech text, API keys or personal paths/emails. Redact before sharing. CI runs a secret scan.

## AI-assisted contributions

AI tools are fine. The repo includes a Claude Code setup (`CLAUDE.md`, `.claude/agents`, `.claude/commands`, e.g. `/fix-issue 42`). You are responsible for what you submit: understand it, test it, keep it small.

## Reporting bugs and security

Use the Bug report template (include version, Windows build, Python version, GPU/CPU, log excerpt with speech text removed). Security issues: see [SECURITY.md](SECURITY.md), do not open a public issue.

By contributing you agree your work is licensed under the [Apache License 2.0](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
