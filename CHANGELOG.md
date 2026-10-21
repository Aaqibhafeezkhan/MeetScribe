# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
