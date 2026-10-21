#!/usr/bin/env python3
"""
Persistent faster-whisper worker.

Speaks newline-delimited JSON over stdin/stdout so the Electron main process can
keep one warm model in memory instead of paying model-load cost per utterance.

Protocol (one JSON object per line):
  ->  {"id":1,"action":"transcribe","audio_path":"...","model":"small",
       "language":"auto","model_dir":"...","device":"auto",
       "compute_type":"auto","cpu_threads":0,"beam_size":1}
  <-  {"id":1,"ok":true,"text":"...","language":"en","duration":1.2,
       "model":"small","device":"cpu","compute_type":"int8"}

  ->  {"id":2,"action":"warmup", ...}          <- same load fields
  ->  {"id":3,"action":"unload"}               releases the model
  ->  {"id":4,"action":"shutdown"}             exits

On startup it emits {"event":"ready", ...}. Errors reply with
{"id":N,"ok":false,"error":"...","traceback":"..."}.

Backend note: this uses faster-whisper (CTranslate2), not openai-whisper. It
needs no torch/numba/llvmlite and no ffmpeg binary (PyAV bundles the codecs),
which is what makes it installable on Python 3.13, and it is several times
faster on CPU with int8.
"""

import gc
import json
import sys
import time
import traceback

MODEL = None
MODEL_KEY = None  # (name, device, compute_type, model_dir, cpu_threads)

# Confidence gate for decoded segments (Whisper's own defaults).
NO_SPEECH_THRESHOLD = 0.6
LOGPROB_THRESHOLD = -1.0


def log(message):
    """Diagnostics go to stderr; stdout is reserved for the JSON protocol."""
    print(message, file=sys.stderr, flush=True)


def resolve_device(requested):
    """
    Map the requested device to one that actually works.

    'auto' prefers CUDA but must never hard-fail: a machine with an NVIDIA GPU
    but missing cuBLAS/cuDNN DLLs would otherwise kill transcription entirely.
    CPU is always a valid answer.
    """
    requested = (requested or 'auto').lower()
    if requested == 'cpu':
        return 'cpu'
    if requested in ('cuda', 'gpu'):
        return 'cuda'
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return 'cuda'
    except Exception as exc:  # noqa: BLE001 - any failure means "no usable CUDA"
        log(f'CUDA probe failed, using CPU: {exc}')
    return 'cpu'


def resolve_compute_type(requested, device):
    requested = (requested or 'auto').lower()
    if requested != 'auto':
        return requested
    return 'float16' if device == 'cuda' else 'int8'


def load_model(name, device, compute_type, model_dir, cpu_threads):
    """Load (or reuse) the model. Falls back to CPU if CUDA init fails."""
    global MODEL, MODEL_KEY

    from faster_whisper import WhisperModel

    device = resolve_device(device)
    compute_type = resolve_compute_type(compute_type, device)
    key = (name, device, compute_type, model_dir, cpu_threads)

    if MODEL is not None and MODEL_KEY == key:
        return MODEL, device, compute_type

    unload_model()

    kwargs = {'device': device, 'compute_type': compute_type}
    if model_dir:
        kwargs['download_root'] = model_dir
    if cpu_threads and int(cpu_threads) > 0:
        kwargs['cpu_threads'] = int(cpu_threads)

    started = time.time()
    try:
        MODEL = WhisperModel(name, **kwargs)
    except Exception as exc:  # noqa: BLE001
        if device != 'cpu':
            log(f'Failed to load model on {device} ({exc}); retrying on CPU')
            device = 'cpu'
            compute_type = resolve_compute_type('auto', device)
            kwargs['device'] = device
            kwargs['compute_type'] = compute_type
            MODEL = WhisperModel(name, **kwargs)
            key = (name, device, compute_type, model_dir, cpu_threads)
        else:
            raise

    MODEL_KEY = key
    log(f'Loaded {name} on {device}/{compute_type} in {time.time() - started:.1f}s')
    return MODEL, device, compute_type


def unload_model():
    global MODEL, MODEL_KEY
    if MODEL is not None:
        MODEL = None
        MODEL_KEY = None
        gc.collect()


def handle_transcribe(request):
    model, device, compute_type = load_model(
        request.get('model') or 'small',
        request.get('device') or 'auto',
        request.get('compute_type') or 'auto',
        request.get('model_dir'),
        request.get('cpu_threads') or 0,
    )

    audio_path = request.get('audio_path')
    if not audio_path:
        raise ValueError('audio_path is required')

    language = request.get('language') or 'auto'
    # Domain vocabulary. Biasing the decoder towards these tokens is the only
    # thing that reliably lands a proper noun the model has never seen; model
    # size fixes almost everything else but cannot invent a word it lacks.
    hotwords = (request.get('hotwords') or '').strip() or None
    started = time.time()

    segments, info = model.transcribe(
        audio_path,
        language=None if language in ('auto', '', None) else language,
        beam_size=int(request.get('beam_size') or 1),
        hotwords=hotwords,
        # The JS side already ran VAD and handed us a trimmed utterance;
        # faster-whisper's own Silero VAD would double-trim and add latency.
        vad_filter=False,
        # Each utterance is independent — carrying prior text across segments
        # is a known source of runaway hallucination on short clips.
        condition_on_previous_text=False,
        temperature=0.0,
    )

    # Room noise and echo tails decode into fluent sentences nobody said. The
    # giveaway is a high no-speech probability or a poor average log
    # probability (Whisper's own default thresholds).
    #
    # The gate is all-or-nothing across the utterance rather than per segment:
    # the JS side hands over one VAD-trimmed phrase, and its leading segment
    # routinely scores badly on the first word or two. Dropping segments
    # individually silently truncates real speech — "The quarterly numbers look
    # strong across every region" arrives as "long across every region".
    pieces = []
    confident = False
    for segment in segments:
        no_speech = getattr(segment, 'no_speech_prob', 0.0) or 0.0
        avg_logprob = getattr(segment, 'avg_logprob', 0.0) or 0.0
        if no_speech <= NO_SPEECH_THRESHOLD and avg_logprob >= LOGPROB_THRESHOLD:
            confident = True
        piece = segment.text.strip()
        if piece:
            pieces.append(piece)

    text = ' '.join(pieces).strip() if confident else ''

    return {
        'ok': True,
        'text': text,
        'confident': confident,
        'language': getattr(info, 'language', None),
        'duration': getattr(info, 'duration', None),
        'elapsed': round(time.time() - started, 3),
        'model': request.get('model') or 'small',
        'device': device,
        'compute_type': compute_type,
    }


def handle_warmup(request):
    _, device, compute_type = load_model(
        request.get('model') or 'small',
        request.get('device') or 'auto',
        request.get('compute_type') or 'auto',
        request.get('model_dir'),
        request.get('cpu_threads') or 0,
    )
    return {
        'ok': True,
        'model': request.get('model') or 'small',
        'device': device,
        'compute_type': compute_type,
        'gpu': device == 'cuda',
    }


def main():
    print(json.dumps({'event': 'ready', 'python': sys.version.split()[0]}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            log(f'Ignoring non-JSON input: {line[:200]}')
            continue

        request_id = request.get('id')
        action = request.get('action')

        try:
            if action == 'transcribe':
                response = handle_transcribe(request)
            elif action == 'warmup':
                response = handle_warmup(request)
            elif action == 'unload':
                unload_model()
                response = {'ok': True, 'unloaded': True}
            elif action == 'shutdown':
                print(json.dumps({'id': request_id, 'ok': True}), flush=True)
                unload_model()
                return
            else:
                raise ValueError(f'Unknown action: {action}')
            response['id'] = request_id
        except Exception as exc:  # noqa: BLE001 - report, never die
            response = {
                'id': request_id,
                'ok': False,
                'error': str(exc),
                'traceback': traceback.format_exc(),
            }

        print(json.dumps(response), flush=True)


if __name__ == '__main__':
    main()
