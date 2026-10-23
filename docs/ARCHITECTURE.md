# Architecture

MeetScribe is an Electron app (main process + several renderer windows) that shells out to long-lived Python workers for speech recognition.

## Process model

| Piece | File(s) | Role |
|---|---|---|
| Main process | `main.js` | App lifecycle, all IPC handlers (`meeting:*`, `settings:*`, `whisper:*`, window controls), wires services together |
| Preload | `preload.js` | Context-isolated bridge exposing a narrow API to renderers (`nodeIntegration` is off) |
| Windows | `src/managers/window.manager.js` | Overlay, transcript and settings windows, click-through, show/hide, display watching, a hidden audio-engine window |
| Audio engine | `audio-engine.html`, `src/ui/audio-engine.js` | Hidden renderer that captures system loopback + mic and streams PCM to main |
| UI | `index.html`, `transcript.html`, `settings.html`, `src/ui/*.js` | Overlay, live transcript, settings |

## Live pipeline

1. **Capture** (`audio-engine.js`): two streams, `system` (labeled *Them*) and `mic` (*You*), 16 kHz mono PCM16.
2. **Per-stream VAD** (`transcription-stream.js`): splits speech into utterances (700 ms silence hangover, 350 ms minimum, 12 s cap, 300 ms pre-roll) and drops known Whisper hallucinations (EN/DE closing phrases).
3. **Whisper pool** (`whisper-pool.service.js`): serialises requests onto N persistent workers (default 1, queue cap 6).
4. **Worker** (`whisper-worker.service.js` + `scripts/whisper_worker.py`): a spawned Python process speaking a JSON-lines protocol on stdin/stdout, unloads the model when idle.
5. **Echo suppression** (`transcription.service.js`): drops *You* lines that match recent *Them* lines.
6. **Meeting file** (`meeting.service.js`): one folder per meeting, fsync'd append-only transcript. Lines are reordered by speech *start* time inside a 1200 ms window (15 s max hold).

## Archive and offline pass

- `audio-archive.service.js` records raw PCM per stream **before** VAD so timestamps stay wall-clock, writes a `timeline.jsonl` checkpoint every 5 s, pads long stalls with silence, and transcodes to FLAC via `scripts/transcode_flac.py` (PyAV).
- `offline-pass.service.js` runs `scripts/whisper_offline.py` after the meeting: `large-v3-turbo` at beam 2, in one of two modes: `fast` (default) runs `BatchedInferencePipeline` over Silero-VAD speech chunks, `quality` is one continuous decode with `condition_on_previous_text`. Passes are queued one at a time at below-normal priority, persisted across restarts. The glossary is trimmed to a token budget so it can't overflow the 448-token context. Temperature ladder with a compression-ratio guard against repetition loops, low-confidence words marked `~like this~`, optional `diffModel` cross-check, paragraph blocks, `## HH:MM` chapters, and an index of up to 40 uncertain spans.

## Configuration and data

- `src/core/config.js`: shipped defaults (not user-facing).
- `src/core/settings.store.js`: user settings as JSON in `userData`, atomic writes, seeded from config defaults.
- Whisper venv and models: `%APPDATA%\MeetScribe\.venv-whisper` and `.whisper-models` (created by `scripts/setup-whisper.js`).
- Transcripts: `~/Documents/MeetingTranscripts/<meeting>/`.
- Logs: winston via `src/core/logger.js`.

## Conventions

- Services are classes exporting a singleton; log with `createServiceLogger('<name>')`, never `console.log` in `src/`.
- New user-facing setting = default in `config.js` + key in `settings.store.js` + UI in `settings.html`/`settings-window.js` + IPC if needed.
- The version lives in `package.json` **and** `src/core/config.js`; bump both.
- `assests/` is a historical typo kept for now ([rename is a tracked issue](https://github.com/AmineChr54/MeetScribe/issues)).
