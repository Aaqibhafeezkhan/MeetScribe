# MeetScribe

Meeting transcription overlay — live speaker-labeled transcript, invisible to screen sharing.

## Installation

### 1. Install Python

MeetScribe transcribes locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), which needs Python on your machine. **Do this first** — the app cannot set itself up without it.

Download **Python 3.11, 3.12, or 3.13** from [python.org](https://www.python.org/downloads/) and tick **"Add Python to PATH"** during the install.

> Python 3.14+ does not work — `ctranslate2` has no wheels for it yet.

### 2. Install MeetScribe

Grab a build from the [Releases](https://github.com/AmineChr54/MeetScribe/releases) page:

| File | What it does |
|---|---|
| `MeetScribe-Setup-1.0.0.exe` | Installer. Adds Start Menu and desktop shortcuts. |
| `MeetScribe 1.0.0.exe` | Portable. No install — just run it. |

Windows SmartScreen will warn on first run because the build is unsigned. Click **More info → Run anyway**.

### 3. Set up transcription

Launch MeetScribe, then:

1. Open **Settings** (`Ctrl + ,`)
2. Go to **Transcription**
3. Click **Install / Repair Whisper** — tick **with CUDA** first if you have an NVIDIA GPU

This creates a private Python environment and downloads the speech model into `%APPDATA%\MeetScribe`. It takes a few minutes and needs an internet connection. Progress streams into the log pane below the button.

When the status line reads ready, you're done. Everything after this runs offline.

## Running from source

```bash
git clone https://github.com/AmineChr54/MeetScribe.git
cd MeetScribe
npm install
npm start
```

Then follow **step 3** above to set up Whisper.

To produce your own build:

```bash
npm run build:win
```

Artifacts land in `dist/`.

## Uninstalling

Use *Add or remove programs*, or just delete the portable exe. The Whisper environment and models stay in `%APPDATA%\MeetScribe` — delete that folder to reclaim the disk space.

## License

MIT — see [LICENSE](LICENSE).
