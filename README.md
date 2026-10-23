<div align="center">

# MeetScribe

**Private, local meeting transcription in a screen-share-invisible overlay.**

Live speaker-labeled transcript while you talk, a higher-quality final pass when you're done. Everything runs on your machine. No cloud, no API keys, no account.

[![CI](https://github.com/AmineChr54/MeetScribe/actions/workflows/ci.yml/badge.svg)](https://github.com/AmineChr54/MeetScribe/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Good first issues](https://img.shields.io/github/issues/AmineChr54/MeetScribe/good%20first%20issue?label=good%20first%20issues&color=7057ff)](https://github.com/AmineChr54/MeetScribe/labels/good%20first%20issue)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Features

- **Two streams, labeled.** System audio (WASAPI loopback) is **Them**, your microphone is **You**.
- **Live transcript** from [faster-whisper](https://github.com/SYSTRAN/faster-whisper), with VAD-based utterance splitting, Whisper-hallucination filtering and echo suppression between the two streams.
- **Stealth overlay.** Click-through, always-on-top windows that stay out of screen sharing.
- **Offline final pass.** After the meeting, re-transcribes the archived audio with a larger model (`large-v3-turbo`), batched across all CPU cores by default, marks low-confidence words, and adds paragraphs, 5-minute chapter headings and an index of uncertain spans.
- **Audio archive.** Raw per-stream audio is kept (FLAC by default) so any meeting can be re-transcribed later with better settings.
- **Durable by design.** One folder per meeting, fsync'd append-only transcript, so a crash loses seconds, not the meeting.
- **100% local.** Nothing leaves your machine after the one-time model download.

## How it works

```mermaid
flowchart LR
    A[System audio<br/>WASAPI loopback] --> V1[VAD + utterance buffer]
    B[Microphone] --> V2[VAD + utterance buffer]
    A -. raw PCM .-> AR[(Audio archive<br/>FLAC)]
    B -. raw PCM .-> AR
    V1 --> P[Whisper pool<br/>Python workers]
    V2 --> P
    P --> F[Hallucination filter<br/>+ echo suppression]
    F --> M[Meeting transcript<br/>ordered, fsync'd]
    AR --> O[Offline pass<br/>large-v3-turbo]
    O --> M
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full tour.

## Installation

> **Platform:** Windows 10/11 x64 is the supported target today. Linux and macOS support is tracked in [issues](https://github.com/AmineChr54/MeetScribe/issues?q=label%3Aplatform%3Alinux+OR+label%3Aplatform%3Amacos), and is a great place to contribute.

### 1. Install Python

MeetScribe transcribes locally with faster-whisper, which needs Python. Install **Python 3.11, 3.12 or 3.13** from [python.org](https://www.python.org/downloads/) and tick **"Add Python to PATH"**.

> Python 3.14+ does not work yet: `ctranslate2` has no wheels for it. ffmpeg is **not** required (PyAV bundles codecs).

### 2. Install MeetScribe

Download from [Releases](https://github.com/AmineChr54/MeetScribe/releases):

| File | What it is |
|---|---|
| `MeetScribe-Setup-<version>.exe` | Installer with Start Menu and desktop shortcuts |
| `MeetScribe <version>.exe` | Portable, no install |

The build is unsigned, so Windows SmartScreen warns on first run: **More info → Run anyway** ([signing is a tracked issue](https://github.com/AmineChr54/MeetScribe/issues)).

### 3. Set up transcription

1. Launch MeetScribe and open **Settings** (`Ctrl + ,`)
2. Go to **Transcription**
3. Click **Install / Repair Whisper** (tick **with CUDA** on an NVIDIA GPU)

This creates a private Python environment and downloads the model into `%APPDATA%\MeetScribe`. It needs internet once and takes a few minutes. Afterwards everything runs offline.

## Configuration

All settings live in the Settings window and are stored as JSON in Electron's `userData` folder. Defaults ship in [`src/core/config.js`](src/core/config.js).

| Area | Highlights |
|---|---|
| Audio | system loopback or named device, microphone by label |
| Transcription | model (`small` default), language (auto), glossary hotwords, GPU/CPU |
| Offline pass | enable, model (incl. German fine-tunes), fast/quality mode, optional second `diffModel` cross-check |
| Models | downloaded models with size, download / delete, learned time per 1-hour meeting |
| Archive | `flac` (default), `wav` or `none` |
| Transcripts | root folder, default `~/Documents/MeetingTranscripts` |

## Development

Requirements: Node.js 20+, Python 3.11 to 3.13.

```bash
git clone https://github.com/AmineChr54/MeetScribe.git
cd MeetScribe
npm install
npm start            # or: npm run dev  (adds --no-sandbox)
npm run check        # syntax check JS + Python, run before every PR
npm run build:win    # artifacts in dist/
npm run deploy       # build + silently install over your local install (Windows)
```

Then follow install step 3 to set up Whisper (or run `npm run setup:whisper`).

### Installing your own build and updating

`npm run deploy` builds the NSIS installer and installs it per-user to `%LOCALAPPDATA%\Programs\MeetScribe`, keeping a single Start Menu shortcut (`MeetScribe.lnk`). Run it again after any change; settings and the Whisper setup in `%APPDATA%\MeetScribe` are kept. Installed builds also check GitHub Releases for a newer version on launch; turn this off in Settings; the check contacts GitHub.

### Project layout

```
main.js, preload.js        Electron main process, IPC, context-isolated bridge
src/core/                  config defaults, settings store, logger
src/managers/              window management (overlay, click-through, stealth)
src/services/              capture, transcription, whisper pool/workers,
                           meeting files, audio archive, offline pass
src/ui/                    renderer scripts (audio engine, overlay, settings)
scripts/                   launcher, whisper setup, Python workers
docs/                      architecture and background
.claude/                   shared AI-assisted workflow (agents, commands, hooks)
```

## Contributing

**Contributors are very welcome.** Issues labeled [`good first issue`](https://github.com/AmineChr54/MeetScribe/labels/good%20first%20issue) and [`help wanted`](https://github.com/AmineChr54/MeetScribe/labels/help%20wanted) are written with context, acceptance criteria and pointers to the right files.

1. Pick an issue and comment that you're on it
2. Branch, change, run `npm run check`
3. Open a PR using the template

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The repo also ships a ready-made [Claude Code](https://claude.com/claude-code) setup (`CLAUDE.md`, subagents, slash commands) if you like AI-assisted contributions, see [AGENTS.md](AGENTS.md).

> **Privacy rule for contributors:** never commit transcripts, audio, screenshots of real meetings or API keys. Redact names in bug reports.

## Uninstalling

Use *Add or remove programs* or delete the portable exe. Delete `%APPDATA%\MeetScribe` to reclaim the Whisper environment and models.

## About and credits

MeetScribe started as a fork of [OpenCluely](https://github.com/TechyCSR/OpenCluely) by TechyCSR and has since been rebuilt around local transcription. See [docs/ABOUT.md](docs/ABOUT.md) and [NOTICE](NOTICE).

## License

Apache License 2.0, see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
