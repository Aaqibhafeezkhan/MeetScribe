#!/usr/bin/env python3
"""
Offline "final pass" transcriber.

The live worker (whisper_worker.py) trades accuracy for latency: a small model,
greedy decoding, and one independent decode per VAD-trimmed utterance with no
memory of what came before. That is the right shape for a scrolling overlay and
the wrong shape for the transcript you actually keep.

This script is the other half. It runs once, after the meeting, over the whole
archived stream in one continuous decode:

  - a bigger model (large-v3-turbo or a German fine-tune)
  - beam search instead of greedy
  - condition_on_previous_text=True, so terminology decided in minute 3 is still
    known in minute 40
  - a glossary injected as hotwords, which is what actually fixes proper nouns
  - word-level timestamps and probabilities, so the transcript can mark its own
    uncertain spots

Enabling context is what makes repetition loops possible, so the temperature
ladder plus compression_ratio_threshold is mandatory here, not optional: when a
decode goes degenerate the compression ratio spikes and the window is retried
hotter. That is the safety net the live path deliberately does without.

Protocol: takes one argument, the path to a JSON job file. Progress is reported
as newline-delimited JSON on stdout; the (large) result is written to the job's
output path rather than piped, so a long meeting cannot wedge on a pipe buffer.

  <-  {"event":"loaded","model":"...","device":"cpu","compute_type":"int8"}
  <-  {"event":"progress","stream":"system","pct":0.42,"pass":"primary"}
  <-  {"event":"done","path":"...\\result.json"}
  <-  {"event":"error","error":"...","traceback":"..."}
"""

import json
import os
import sys
import time
import traceback

# Report progress at most this often, so a fast stream cannot flood the pipe.
PROGRESS_STEP = 0.02

# Whisper's context is 448 tokens. faster-whisper gives the hotwords and the
# previous text up to 223 tokens each, so a long glossary plus conditioning
# fills it and leaves nothing to decode ("The maximum decoding length must be
# > 0"). These budgets keep hotwords + previous text + SOT clear of 448, and a
# short list is also far less likely to be read out as speech.
HOTWORD_TOKEN_BUDGET = 96
PROMPT_TOKEN_BUDGET = 64

# Speech chunks decoded together in fast mode. 8 keeps a 12-core CPU busy
# without the memory of a large batch.
BATCH_SIZE = 8


def emit(payload):
    print(json.dumps(payload), flush=True)


def log(message):
    print(message, file=sys.stderr, flush=True)


def resolve_device(requested):
    requested = (requested or 'auto').lower()
    if requested == 'cpu':
        return 'cpu'
    if requested in ('cuda', 'gpu'):
        return 'cuda'
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return 'cuda'
    except Exception as exc:  # noqa: BLE001
        log('CUDA probe failed, using CPU: {}'.format(exc))
    return 'cpu'


def resolve_compute_type(requested, device):
    requested = (requested or 'auto').lower()
    if requested != 'auto':
        return requested
    return 'float16' if device == 'cuda' else 'int8'


def load_model(job, name):
    from faster_whisper import WhisperModel

    device = resolve_device(job.get('device'))
    compute_type = resolve_compute_type(job.get('compute_type'), device)

    kwargs = {'device': device, 'compute_type': compute_type}
    if job.get('model_dir'):
        kwargs['download_root'] = job['model_dir']
    cpu_threads = int(job.get('cpu_threads') or 0)
    if cpu_threads > 0:
        kwargs['cpu_threads'] = cpu_threads

    started = time.time()
    try:
        model = WhisperModel(name, **kwargs)
    except Exception as exc:  # noqa: BLE001
        if device != 'cpu':
            log('Failed to load {} on {} ({}); retrying on CPU'.format(name, device, exc))
            device = 'cpu'
            compute_type = resolve_compute_type('auto', device)
            kwargs['device'] = device
            kwargs['compute_type'] = compute_type
            model = WhisperModel(name, **kwargs)
        else:
            raise

    log('Loaded {} on {}/{} in {:.1f}s'.format(name, device, compute_type, time.time() - started))
    emit({'event': 'loaded', 'model': name, 'device': device, 'compute_type': compute_type})
    return model, device, compute_type


def count_tokens(model, text):
    return len(model.hf_tokenizer.encode(' ' + text, add_special_tokens=False).ids)


def budget_glossary(model, job):
    """Trim hotwords to whole terms and the context prompt to whole words,
    each within its token budget. Returns (kept, total) term counts."""
    terms = [term.strip() for term in (job.get('hotwords') or '').split(',') if term.strip()]
    kept = []
    for term in terms:
        if count_tokens(model, ', '.join(kept + [term])) > HOTWORD_TOKEN_BUDGET:
            break
        kept.append(term)
    job['hotwords'] = ', '.join(kept)

    words = (job.get('initial_prompt') or '').split()
    while words and count_tokens(model, ' '.join(words)) > PROMPT_TOKEN_BUDGET:
        words.pop()
    job['initial_prompt'] = ' '.join(words)

    if terms:
        log('Glossary: kept {} of {} terms'.format(len(kept), len(terms)))
    return len(kept), len(terms)


def decode_stream(model, job, entry, pass_name, result):
    """A glossary must never cost the whole pass: if decoding with it fails,
    decode that stream again without it and say so in the result."""
    try:
        return transcribe_stream(model, job, entry, pass_name)
    except Exception as exc:  # noqa: BLE001
        if not (job.get('hotwords') or job.get('initial_prompt')):
            raise
        log('{} [{}]: decode failed with the glossary ({}); retrying without it'.format(
            entry['stream'], pass_name, exc))
        result['glossaryDropped'].append(entry['stream'])
        return transcribe_stream(model, dict(job, hotwords='', initial_prompt=''), entry, pass_name)


def transcribe_stream(model, job, entry, pass_name):
    """Decode one archived stream end to end and collect word-level output."""
    language = job.get('language') or 'auto'
    hotwords = (job.get('hotwords') or '').strip() or None
    initial_prompt = (job.get('initial_prompt') or '').strip() or None
    want_words = bool(job.get('word_timestamps', True))

    common = dict(
        language=None if language in ('auto', '', None) else language,
        beam_size=int(job.get('beam_size') or 2),
        # Loop-breaker: a window that decodes into repetition is retried hotter.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        # Silero, not the live path's RMS gate: a trained speech classifier does
        # not open on keyboard clicks or close on a soft German consonant.
        vad_filter=True,
        vad_parameters={
            'min_silence_duration_ms': 500,
            'speech_pad_ms': 400,
        },
        word_timestamps=want_words,
        hotwords=hotwords,
        initial_prompt=initial_prompt,
    )

    # Timed from before transcribe(): fast mode runs its VAD inside the call,
    # and that is part of what a pass costs.
    started = time.time()
    if job.get('mode') == 'quality':
        segments, info = model.transcribe(
            entry['path'],
            # Each window is decoded knowing what the previous one decided, which
            # keeps a term stable across a meeting instead of re-guessing it.
            condition_on_previous_text=True,
            # Needs word timestamps; drops text the model invents over silence.
            hallucination_silence_threshold=2.0 if want_words else None,
            **common
        )
    else:
        # VAD cuts the stream into speech chunks of up to 30 s and several are
        # decoded at once. Silence is never decoded and the cores stay busy,
        # which is most of the speed-up. Chunks are independent, so a misheard
        # term cannot snowball into the windows after it.
        from faster_whisper import BatchedInferencePipeline
        segments, info = BatchedInferencePipeline(model).transcribe(
            entry['path'],
            batch_size=int(job.get('batch_size') or BATCH_SIZE),
            **common
        )

    duration = getattr(info, 'duration', None) or max(1.0, entry.get('durationMs', 1000) / 1000.0)
    collected = []
    last_pct = -1.0

    for segment in segments:
        words = []
        if want_words and getattr(segment, 'words', None):
            for word in segment.words:
                words.append({
                    'start': round(word.start, 3),
                    'end': round(word.end, 3),
                    'word': word.word,
                    'probability': round(float(word.probability), 4),
                })

        collected.append({
            'start': round(segment.start, 3),
            'end': round(segment.end, 3),
            'text': segment.text.strip(),
            'avg_logprob': round(float(getattr(segment, 'avg_logprob', 0.0) or 0.0), 4),
            'no_speech_prob': round(float(getattr(segment, 'no_speech_prob', 0.0) or 0.0), 4),
            'compression_ratio': round(float(getattr(segment, 'compression_ratio', 0.0) or 0.0), 4),
            'words': words,
        })

        pct = min(1.0, segment.end / duration)
        if pct - last_pct >= PROGRESS_STEP:
            last_pct = pct
            emit({
                'event': 'progress',
                'stream': entry['stream'],
                'pass': pass_name,
                'pct': round(pct, 4),
            })

    emit({'event': 'progress', 'stream': entry['stream'], 'pass': pass_name, 'pct': 1.0})
    decode_sec = time.time() - started
    # Speech, not stream length, is what the decode time scales with; the app
    # learns its time estimates from these two numbers.
    speech_sec = getattr(info, 'duration_after_vad', None)
    if speech_sec is None:
        speech_sec = duration
    log('{} [{}]: {} segments in {:.1f}s ({:.0f}s of speech)'.format(
        entry['stream'], pass_name, len(collected), decode_sec, speech_sec))

    return {
        'stream': entry['stream'],
        'label': entry.get('label') or entry['stream'],
        'startedAt': entry.get('startedAt'),
        'language': getattr(info, 'language', None),
        'duration': duration,
        'speechSec': round(float(speech_sec), 2),
        'decodeSec': round(decode_sec, 2),
        'segments': collected,
    }


def main():
    if len(sys.argv) < 2:
        emit({'event': 'error', 'error': 'usage: whisper_offline.py <job.json>'})
        return 2

    with open(sys.argv[1], 'r', encoding='utf-8') as handle:
        job = json.load(handle)

    entries = [entry for entry in job.get('audio', []) if os.path.exists(entry.get('path', ''))]
    if not entries:
        emit({'event': 'error', 'error': 'No archived audio files were found for this meeting'})
        return 1

    result = {
        'version': 1,
        'model': job.get('model'),
        'diffModel': job.get('diff_model') or None,
        'language': job.get('language'),
        'beamSize': job.get('beam_size'),
        'mode': job.get('mode') or 'fast',
        'streams': [],
        'diffStreams': [],
        'glossaryDropped': [],
    }

    load_started = time.time()
    model, device, compute_type = load_model(job, job.get('model') or 'large-v3-turbo')
    result['loadSec'] = round(time.time() - load_started, 2)
    result['cpuThreads'] = int(job.get('cpu_threads') or 0)
    result['device'] = device
    result['computeType'] = compute_type
    # Every Whisper checkpoint shares the multilingual tokenizer, so one budget
    # holds for the diff model too.
    result['glossaryKept'], result['glossaryTotal'] = budget_glossary(model, job)
    result['hotwords'] = job['hotwords']

    for entry in entries:
        result['streams'].append(decode_stream(model, job, entry, 'primary', result))

    # Optional second opinion. Two independently-trained models agreeing is a
    # decent proxy for "correct"; where they disagree marks a span worth a human
    # (or an LLM) looking at, without either model having to know it was wrong.
    diff_model_name = (job.get('diff_model') or '').strip()
    if diff_model_name:
        del model
        import gc
        gc.collect()
        diff_model, _, _ = load_model(job, diff_model_name)
        for entry in entries:
            result['diffStreams'].append(decode_stream(diff_model, job, entry, 'diff', result))

    out_path = job['output']
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False)

    emit({'event': 'done', 'path': out_path})
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        emit({'event': 'error', 'error': str(exc), 'traceback': traceback.format_exc()})
        sys.exit(1)
