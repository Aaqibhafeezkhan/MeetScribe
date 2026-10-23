# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Unit tests for the hallucination filter, transcript reordering and echo suppression (`npm test`, run in CI).

## [1.4.0] - 2026-10-23

### Added
- Settings → Final pass → **Models on this PC**: every Whisper model with its download status and size, Download and Delete buttons, and which one is in use. Dropdowns mark downloaded models with ✓ (#61).
- German final-pass models: German turbo (`cstr/whisper-large-v3-turbo-german-int8_float32`) and German large-v3 (`tnfru/whisper-large-v3-german-ct2`) (#61).
- Estimated final-pass time per 1-hour meeting for each model. It starts from a benchmark and learns from every pass: model speed per second of speech, plus how much speech your meetings contain (#61).

### Fixed
- The custom-model hint suggested a Transformers repo that faster-whisper cannot load (#61).

## [1.3.0] - 2026-10-23

### Added
- Final pass speed setting: **Fast** (default) decodes VAD-cut speech chunks in batches on one thread per physical core; **Quality** keeps the sequential, conditioned decode (#51).
- Final passes are queued instead of dropped when one is already running, shown as "n queued", run at below-normal priority, and resume after a restart (#48, #49).
- Logging of slow and failed transcriptions with queue wait, decode time and audio length, and of final-pass speed against meeting length (#53).

### Changed
- Final pass beam size defaults to 2 (was 5) and CPU threads to one per physical core (faster-whisper's own default is 4).
- The live pass no longer uses the glossary; the final pass uses only the first ~96 tokens of terms (#47).

### Fixed
- Final pass failing with "The maximum decoding length must be > 0" when a glossary was set (#44).
- Glossary terms written into transcripts where nobody said them (#47).
- Last utterances lost when recording stops while segments are still queued (#50).
- A wedged live Whisper worker is restarted after a timeout instead of stalling every following segment (#52).
- Quitting during a final pass is logged as cancelled, not as an unreadable-audio crash (#49).

## [1.2.0] - 2026-10-21

### Added
- Offline final pass: post-meeting re-transcription with `large-v3-turbo`, confidence marking, chapters and uncertainty index.
- Per-stream raw audio archive with FLAC transcoding.
- Corrections map: `corrections.json` (user data folder, plus a per-meeting copy) replaces known mishearings in the final transcript, marked as `{correct}`.
- Repo foundation: contributor docs, issue/PR templates, CI, shared Claude Code workflow.
- `npm run deploy`: builds the installer and installs it silently over the per-user install, keeping one `MeetScribe.lnk` Start Menu shortcut.
- Auto-update from GitHub Releases for installed builds (Settings toggle, on by default). Release workflow now publishes `latest.yml` and blockmaps.
- New app icon (signal dot) for the executable, installer and windows (#18).

### Changed
- License metadata unified to Apache-2.0; repository links point to this repo.

## [1.1.1]

### Changed
- Local faster-whisper pipeline hardening; version bump.

## [1.0.0]

### Added
- Initial MeetScribe release: live dual-stream transcription overlay, stealth windows, local Whisper setup from Settings.
