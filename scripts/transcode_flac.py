#!/usr/bin/env python3
"""
Lossless WAV -> FLAC for the meeting audio archive.

Roughly halves the archive (16kHz mono PCM16 is ~115 MB/hour/stream) with no
quality loss, which matters because the whole point of keeping the audio is
being able to re-run the final pass on it months later.

No new dependency: PyAV already comes in with faster-whisper — it is what lets
the app decode audio without an ffmpeg binary on PATH — so the same library that
reads the archive can write it.

Usage: transcode_flac.py <in.wav> <out.flac>
Prints one JSON object describing the result.
"""

import json
import os
import sys


def transcode(src, dst):
    import av

    with av.open(src) as container:
        in_stream = container.streams.audio[0]
        sample_rate = in_stream.codec_context.sample_rate

        with av.open(dst, mode='w') as output:
            # s16 keeps this bit-exact: the source is already 16-bit integer PCM,
            # so FLAC stores exactly the samples that were captured.
            out_stream = output.add_stream('flac', rate=sample_rate)
            out_stream.format = 's16'
            out_stream.layout = 'mono'

            for frame in container.decode(audio=0):
                frame.pts = None
                for packet in out_stream.encode(frame):
                    output.mux(packet)

            for packet in out_stream.encode(None):
                output.mux(packet)

    return os.path.getsize(dst)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': 'usage: transcode_flac.py <in.wav> <out.flac>'}))
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    try:
        size = transcode(src, dst)
        print(json.dumps({
            'ok': True,
            'path': dst,
            'bytes': size,
            'sourceBytes': os.path.getsize(src),
        }))
        return 0
    except Exception as exc:  # noqa: BLE001
        # A failed transcode must never cost the archive: the caller keeps the
        # WAV whenever this reports failure.
        try:
            if os.path.exists(dst):
                os.remove(dst)
        except OSError:
            pass
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
