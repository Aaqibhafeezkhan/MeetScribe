const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../core/logger').createServiceLogger('STREAM');

// Words a pure sign-off can be built from. A line made only of these, opening
// with a thanks or a goodbye, carries no meeting content.
const CLOSING_VOCABULARY = new Set([
  'thank', 'thanks', 'you', 'so', 'very', 'much', 'all', 'again', 'guys',
  'everyone', 'for', 'your', 'time', 'watching', 'listening', 'joining',
  'today', 'bye', 'goodbye', 'and', 'the', 'to', 'us'
]);

/**
 * One audio stream's worth of voice-activity detection and segmentation.
 *
 * MeetScribe runs two of these concurrently — system/loopback audio ("Them")
 * and the microphone ("You") — so every piece of VAD state lives on the
 * instance rather than on a shared singleton.
 *
 * The state machine accumulates 16kHz mono PCM16 while someone is speaking and
 * flushes the segment on a natural pause, which keeps transcription aligned
 * with utterance boundaries instead of cutting sentences on a blind timer.
 *
 * Emits:
 *   'utterance' { streamId, label, text, startedAt, durationMs }
 *   'error'     Error
 */
class TranscriptionStream extends EventEmitter {
  /**
   * @param {object}   options
   * @param {string}   options.id          'system' | 'mic'
   * @param {string}   options.label       display name written to the transcript
   * @param {object}   options.vad         VAD tunables (see core/config.js)
   * @param {object}   options.transcriber object with transcribe(wavPath, opts)
   */
  constructor({ id, label, vad, transcriber }) {
    super();
    this.id = id;
    this.label = label;
    this.vad = vad;
    this.transcriber = transcriber;

    this.isActive = false;
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.segmentStartedAt = 0;
    // Start times of segments currently being transcribed, so the transcript
    // writer can hold instantaneous events until earlier speech has landed.
    this.pendingStarts = new Set();
    this.segmentTimer = null;
    this.tempDir = null;
    this.tempSequence = 0;

    this._resetVadState();
  }

  updateSettings({ vad, label } = {}) {
    if (vad) this.vad = vad;
    if (label) this.label = label;
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this._resetVadState();
    this._startWatchdog();
    logger.debug('Stream started', { stream: this.id });
  }

  /** Stop capturing. Any audio already buffered is transcribed, not discarded. */
  async stop() {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.segmentBytes > 0 && this.vadSpeechMs >= this.vad.minUtteranceMs) {
      try {
        await this._flush();
      } catch (error) {
        logger.error('Final flush failed', { stream: this.id, error: error.message });
      }
    }

    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this._resetVadState();
    this._cleanupTempDir();
    logger.debug('Stream stopped', { stream: this.id });
  }

  /** Reset the VAD state machine. */
  _resetVadState() {
    this.vadSpeaking = false;    // currently inside an utterance
    this.vadSpeechMs = 0;        // accumulated voiced audio in this segment
    this.vadSilenceMs = 0;       // trailing silence since the last voiced chunk
    this.vadNoiseFloor = 0;      // adaptive EMA of background energy
    this.vadNoiseInit = false;   // has the noise floor been seeded
    this.vadPreRoll = [];        // ring of recent pre-speech chunks
    this.vadPreRollMs = 0;       // duration held in the pre-roll ring
    this.vadLastChunkAt = 0;     // timestamp of the last ingested chunk
  }

  /**
   * Silence is normally detected from incoming chunks (which keep flowing at
   * low energy), but if the capture pipeline stalls mid-utterance we still want
   * to flush what we have. This also enforces the max-utterance cap as a
   * backstop when chunk timing is irregular.
   */
  _startWatchdog() {
    if (this.segmentTimer) clearInterval(this.segmentTimer);
    this.segmentTimer = setInterval(() => {
      if (!this.isActive) return;

      if (!this.vad.vadEnabled) {
        if (this.segmentBytes && this.vadSpeechMs >= this.vad.maxUtteranceMs) {
          this._endUtteranceFlush();
        }
        return;
      }

      const sinceLastChunk = this.vadLastChunkAt ? Date.now() - this.vadLastChunkAt : 0;
      const stalled = this.vadSpeaking && sinceLastChunk > 1500;
      const tooLong = this.vadSpeaking && this.vadSpeechMs >= this.vad.maxUtteranceMs;
      if (stalled || tooLong) {
        this._endUtteranceFlush();
      }
    }, 500);
  }

  /** RMS energy (normalized 0..1) of a 16-bit little-endian PCM buffer. */
  _chunkRmsEnergy(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  /** 16kHz mono 16-bit => 2 bytes/sample => 32 bytes/ms. */
  _chunkDurationMs(buffer) {
    return buffer.length / 32;
  }

  /**
   * Feed one chunk of 16kHz mono PCM16. Runs the VAD state machine: accumulate
   * while speech is present, flush once a natural pause is detected.
   */
  ingest(buffer) {
    if (!this.isActive || !buffer || !buffer.length) return;

    if (!this.vad.vadEnabled) {
      if (!this.vadSpeaking) this.segmentStartedAt = Date.now();
      this.segmentBuffers.push(buffer);
      this.segmentBytes += buffer.length;
      this.vadSpeaking = true;
      this.vadSpeechMs += this._chunkDurationMs(buffer);
      this.vadLastChunkAt = Date.now();
      return;
    }

    this.vadLastChunkAt = Date.now();
    const chunkMs = this._chunkDurationMs(buffer);
    const energy = this._chunkRmsEnergy(buffer);
    const floor = this.vad.vadEnergyFloor;

    // Seed / adapt the background noise floor while not actively speaking so
    // the threshold tracks the room rather than a hard-coded constant. Seed
    // conservatively: if the very first chunk is already loud (someone was
    // mid-sentence when we started), clamp to the configured floor so a high
    // seed can't push the enter-threshold out of reach and stall VAD forever.
    if (!this.vadNoiseInit) {
      this.vadNoiseFloor = Math.min(energy, floor);
      this.vadNoiseInit = true;
    }

    // Hysteresis: it takes more energy to *start* an utterance than to keep one
    // going, so a brief dip mid-sentence doesn't end it prematurely.
    const enterThreshold = Math.max(floor, this.vadNoiseFloor * 2.5);
    const exitThreshold = Math.max(floor * 0.7, this.vadNoiseFloor * 1.6);
    const isVoiced = this.vadSpeaking ? energy >= exitThreshold : energy >= enterThreshold;

    if (!this.vadSpeaking) {
      if (isVoiced) {
        // Speech onset: prepend the pre-roll so the first syllable survives,
        // and timestamp the utterance to where the pre-roll begins — that is
        // when the person actually started talking.
        this.vadSpeaking = true;
        this.vadSpeechMs = 0;
        this.vadSilenceMs = 0;
        this.segmentStartedAt = Date.now() - this.vadPreRollMs;
        for (const pre of this.vadPreRoll) {
          this.segmentBuffers.push(pre);
          this.segmentBytes += pre.length;
        }
        this.vadPreRoll = [];
        this.vadPreRollMs = 0;
        this.segmentBuffers.push(buffer);
        this.segmentBytes += buffer.length;
        this.vadSpeechMs += chunkMs;
      } else {
        // Background: adapt the noise floor and keep a short pre-roll ring.
        this.vadNoiseFloor = this.vadNoiseFloor * 0.95 + energy * 0.05;
        this.vadPreRoll.push(buffer);
        this.vadPreRollMs += chunkMs;
        while (this.vadPreRollMs > this.vad.preRollMs && this.vadPreRoll.length > 1) {
          const dropped = this.vadPreRoll.shift();
          this.vadPreRollMs -= this._chunkDurationMs(dropped);
        }
      }
      return;
    }

    // Already speaking: keep capturing (including trailing silence so word
    // endings aren't clipped) and watch for a pause that ends the utterance.
    this.segmentBuffers.push(buffer);
    this.segmentBytes += buffer.length;
    if (isVoiced) {
      this.vadSpeechMs += chunkMs;
      this.vadSilenceMs = 0;
    } else {
      this.vadSilenceMs += chunkMs;
    }

    const pausedLongEnough = this.vadSilenceMs >= this.vad.silenceHangoverMs;
    const haveRealSpeech = this.vadSpeechMs >= this.vad.minUtteranceMs;
    const tooLong = this.vadSpeechMs >= this.vad.maxUtteranceMs;

    if ((pausedLongEnough && haveRealSpeech) || tooLong) {
      this._endUtteranceFlush();
    } else if (pausedLongEnough && !haveRealSpeech) {
      // Just noise (cough/click) with no real speech — discard rather than
      // waste a transcription and risk a hallucinated line.
      this.segmentBuffers = [];
      this.segmentBytes = 0;
      this.vadSpeaking = false;
      this.vadSpeechMs = 0;
      this.vadSilenceMs = 0;
    }
  }

  _endUtteranceFlush() {
    this.vadSpeaking = false;
    this.vadSpeechMs = 0;
    this.vadSilenceMs = 0;
    this.vadPreRoll = [];
    this.vadPreRollMs = 0;
    this._flush().catch((error) => {
      logger.error('Segment transcription failed', { stream: this.id, error: error.message });
      this.emit('error', error);
    });
  }

  async _flush() {
    if (this.segmentBytes === 0) return;

    const audio = Buffer.concat(this.segmentBuffers, this.segmentBytes);
    const startedAt = this.segmentStartedAt || Date.now();
    const durationMs = Math.round(audio.length / 32);
    this.segmentBuffers = [];
    this.segmentBytes = 0;

    const wavPath = this._writeTempWav(audio);
    this.pendingStarts.add(startedAt);

    try {
      const result = await this.transcriber.transcribe(wavPath, { streamId: this.id });
      const raw = result && result.text ? String(result.text) : '';
      const text = this._sanitize(raw);

      if (!text) {
        logger.debug('Dropped empty/hallucinated segment', { stream: this.id, text: raw.trim() });
        return;
      }

      this.emit('utterance', {
        streamId: this.id,
        label: this.label,
        text,
        startedAt,
        durationMs,
        latencyMs: result && result.elapsed ? Math.round(result.elapsed * 1000) : null
      });
    } finally {
      this.pendingStarts.delete(startedAt);
      try { fs.rmSync(wavPath, { force: true }); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Earliest start time of speech that has not reached the transcript yet —
   * either still being spoken into the buffer, or queued in Whisper. Null when
   * the stream is caught up.
   */
  oldestPendingStartedAt() {
    let oldest = null;
    for (const startedAt of this.pendingStarts) {
      if (oldest === null || startedAt < oldest) oldest = startedAt;
    }
    // A segment still open counts too: someone who started talking at 14:32:00
    // is mid-sentence when a screenshot is taken at 14:32:05.
    if (this.segmentBytes > 0 && this.segmentStartedAt) {
      if (oldest === null || this.segmentStartedAt < oldest) oldest = this.segmentStartedAt;
    }
    return oldest;
  }

  _writeTempWav(pcm) {
    if (!this.tempDir) {
      // Per-stream directory so the two pipelines can never collide on a name.
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `meetscribe-${this.id}-`));
    }
    const wavPath = path.join(this.tempDir, `seg-${++this.tempSequence}.wav`);
    fs.writeFileSync(wavPath, this._createWavBuffer(pcm));
    return wavPath;
  }

  _createWavBuffer(rawPcmBuffer) {
    const header = Buffer.alloc(44);
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawPcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(rawPcmBuffer.length, 40);

    return Buffer.concat([header, rawPcmBuffer]);
  }

  /**
   * Whisper models misbehave in two ways on marginal audio, and both reach the
   * file if unchecked:
   *
   *  - stock phrases from caption-heavy training data ("Thanks for watching")
   *    when handed something that isn't speech, and
   *  - repetition loops, where a decoded phrase re-primes itself and the model
   *    emits it dozens of times. Room echo picked up by the microphone is the
   *    reliable trigger: a 12-second segment comes back as "I'm sorry." ×28.
   *
   * Returns the text to write, or null to drop the segment.
   */
  _sanitize(rawText) {
    // Whisper annotates non-speech as "[Music]", "(applause)", "♪ ♪". Those are
    // observations about the audio, not things anyone said.
    const text = String(rawText || '')
      .replace(/[[(][^\])]*[\])]/g, ' ')
      .replace(/[♪♫]/g, ' ')
      .trim();
    if (!text) return null;

    const phrases = text.match(/[^.!?,;]+[.!?,;]*/g) || [text];
    const kept = [];
    let previousKey = null;
    for (const phrase of phrases) {
      const key = phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (!key || key === previousKey) continue;
      kept.push(phrase.trim());
      previousKey = key;
    }

    // A long segment that boils down to a single repeated phrase carried no
    // information — it was the loop, not something someone said.
    if (phrases.length >= 4 && kept.length <= 1) return null;

    const cleaned = kept.join(' ').replace(/\s+/g, ' ').trim();
    const tokens = cleaned.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    // Catches word-level loops ("you you you you …") that survive phrase dedupe.
    if (tokens.length >= 12 && new Set(tokens).size / tokens.length < 0.25) return null;

    return this._isStockPhrase(cleaned) ? null : cleaned;
  }

  _isStockPhrase(text) {
    const normalized = text.toLowerCase().replace(/[\s.,!?¡¿"'`]+/g, ' ').trim();
    if (!normalized) return true;
    const HALLUCINATIONS = new Set([
      'thank you',
      'thank you for watching',
      'thanks for watching',
      'thank you so much for watching',
      'please subscribe',
      'like and subscribe',
      'you',
      'bye',
      'bye bye',
      'okay',
      'ok',
      'so',
      'the end',
      'subtitles by the amara org community',
      // Sound tags the model writes as plain words rather than in brackets.
      'music', 'applause', 'laughter', 'silence', 'inaudible', 'blank audio',
      // Sentence fragments, typically a word of the meeting audio caught by the
      // microphone between echo-cancellation passes. They carry no content and
      // are too short for echo suppression's word-overlap test to catch.
      'the', 'a', 'an', 'and', 'but', 'or', 'of', 'to', 'in', 'is', 'it',
      'i', 'that', 'uh', 'um', 'mm', 'hmm', 'ah', 'eh', 'huh'
    ]);
    if (HALLUCINATIONS.has(normalized)) return true;

    // The exact-match list can't keep up with the sign-off family — Whisper
    // improvises endlessly around it ("Thank you very much for your time.
    // Thank you very much."). Treat a line as stock when it thanks or signs off
    // and contains nothing else: every word comes from the closing vocabulary,
    // so there is no meeting content to lose. A genuine "Thanks, that answers
    // my question" keeps its content words and survives.
    const words = normalized.split(' ').filter(Boolean);
    const opensWithThanks = /^(thank|thanks|bye|goodbye)$/.test(words[0] || '');
    return opensWithThanks && words.every((word) => CLOSING_VOCABULARY.has(word));
  }

  _cleanupTempDir() {
    if (!this.tempDir) return;
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn('Failed to remove temp directory', { dir: this.tempDir, error: error.message });
    }
    this.tempDir = null;
  }
}

module.exports = TranscriptionStream;
