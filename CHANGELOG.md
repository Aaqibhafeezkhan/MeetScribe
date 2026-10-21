# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Offline final pass: post-meeting re-transcription with `large-v3-turbo`, confidence marking, chapters and uncertainty index.
- Per-stream raw audio archive with FLAC transcoding.
- Repo foundation: contributor docs, issue/PR templates, CI, shared Claude Code workflow.

### Changed
- License metadata unified to Apache-2.0; repository links point to this repo.

## [1.1.1]

### Changed
- Local faster-whisper pipeline hardening; version bump.

## [1.0.0]

### Added
- Initial MeetScribe release: live dual-stream transcription overlay, stealth windows, local Whisper setup from Settings.
