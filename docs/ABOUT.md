# About MeetScribe

MeetScribe is a meeting transcriber that stays out of your way and out of your data.

## Why

Most meeting tools send your audio to a cloud service, join as a visible bot, or show up on screen share. MeetScribe runs locally, listens to what your computer plays and what you say, and shows a small overlay only you can see.

## Principles

- **Local first.** Speech recognition uses faster-whisper on your hardware. There are no API keys and no telemetry.
- **Never lose the meeting.** Append-only, fsync'd transcript and a raw audio archive mean a crash or a bad live transcription is recoverable.
- **Quality after the fact.** Live text is fast and good enough to follow along; the offline pass is where accuracy is spent.
- **Honest about uncertainty.** Low-confidence words are marked, not silently guessed.

## Origin

MeetScribe began as a fork of [OpenCluely](https://github.com/TechyCSR/OpenCluely) (Apache-2.0) by TechyCSR, an AI screen-assistant overlay. The cloud LLM features were removed and the project was rebuilt around local, dual-stream transcription.

## Maintainer

Maintained by [@AmineChr54](https://github.com/AmineChr54). Contributions of all sizes are welcome, see [CONTRIBUTING.md](../CONTRIBUTING.md).
