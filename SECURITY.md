# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting:
**Security tab → [Report a vulnerability](https://github.com/AmineChr54/MeetScribe/security/advisories/new)**.

Include what you found, steps to reproduce, and the affected version. You will get an acknowledgement within about 7 days.

## Scope notes

- MeetScribe is local-only: no server, no API keys, no telemetry. Relevant areas are the Electron IPC surface (`preload.js`, `main.js`), file handling in the transcript and archive folders, and the Python worker process protocol.
- Meeting audio and transcripts are sensitive. Never attach them to reports; describe the problem instead.
