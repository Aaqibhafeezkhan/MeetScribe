const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { app } = require('electron');

const TranscriptionStream = require('./transcription-stream');
const whisperPool = require('./whisper-pool.service');
const settingsStore = require('../core/settings.store');
const logger = require('../core/logger').createServiceLogger('TRANSCRIPTION');

// How far back to look when deciding whether a "You" line is really the
// meeting audio bleeding into the microphone.
const ECHO_WINDOW_MS = 6000;
const ECHO_HISTORY_MS = 10000;
// Delay before ruling on a mic line, so the matching system line has a chance
// to finish transcribing first.
const ECHO_GRACE_MS = 1500;
// Below this many words, an overlap is more likely coincidence than echo.
const MIN_ECHO_TOKENS = 4;

/**
 * Owns both audio pipelines and the Whisper worker pool.
 *
 * Emits:
 *   'utterance' { streamId, label, text, startedAt, durationMs }
 *   'status'    string
 *   'error'     string
 */
class TranscriptionService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.streams = new Map();
    this.recentSystemLines = [];
    // Mic lines transcribed but waiting out the echo grace period. They count
    // as "in flight" for ordering purposes just like a queued utterance does.
    this.deferredStarts = new Set();
  }

  /** Build/refresh the two streams and the worker pool from current settings. */
  configure() {
    const settings = settingsStore.all();

    whisperPool.configure({
      pythonPath: this._resolvePythonPath(settings),
      scriptPath: this._resolveScriptPath(),
      modelDir: this._resolveModelDir(),
      model: settings.whisperModel,
      language: settings.whisperLanguage,
      device: settings.whisperDevice,
      computeType: settings.whisperComputeType,
      cpuThreads: settings.whisperCpuThreads,
      beamSize: settings.whisperBeamSize,
      workerCount: settings.whisperWorkerCount,
      idleUnloadMs: settings.whisperIdleUnloadMs
    });

    const vad = {
      vadEnabled: settings.vadEnabled,
      silenceHangoverMs: Number(settings.silenceHangoverMs),
      minUtteranceMs: Number(settings.minUtteranceMs),
      maxUtteranceMs: Number(settings.maxUtteranceMs),
      preRollMs: Number(settings.preRollMs),
      vadEnergyFloor: Number(settings.vadEnergyFloor)
    };

    const definitions = [
      { id: 'system', label: settings.labelSystem || 'Them' },
      { id: 'mic', label: settings.labelMic || 'You' }
    ];

    for (const { id, label } of definitions) {
      const existing = this.streams.get(id);
      if (existing) {
        existing.updateSettings({ vad, label });
        continue;
      }
      const stream = new TranscriptionStream({
        id,
        label,
        vad,
        transcriber: {
          transcribe: (wavPath, meta) => whisperPool.transcribe(wavPath, meta)
        }
      });
      stream.on('utterance', (utterance) => this._handleUtterance(utterance));
      stream.on('error', (error) => this.emit('error', error.message));
      this.streams.set(id, stream);
    }
  }

  isAvailable() {
    // Configure lazily so a caller that asks before startup finished still
    // gets a truthful answer instead of a spurious "not set up".
    if (this.streams.size === 0) this.configure();
    return whisperPool.isConfigured();
  }

  /**
   * Which streams should be capturing, based on settings. The audio engine
   * reads this to decide what to open.
   */
  getEnabledStreams() {
    const settings = settingsStore.all();
    return {
      system: !!settings.systemEnabled,
      mic: !!settings.micEnabled,
      systemSource: settings.systemSource,
      systemDeviceLabel: settings.systemDeviceLabel || '',
      micDeviceLabel: settings.micDeviceLabel || ''
    };
  }

  start() {
    if (this.isRecording) return this.getStatus();
    this.configure();

    if (!this.isAvailable()) {
      const message = 'Whisper is not set up. Open Settings → Transcription → Install / Repair Whisper.';
      logger.warn(message);
      this.emit('error', message);
      return this.getStatus();
    }

    const enabled = this.getEnabledStreams();
    this.recentSystemLines = [];
    this.deferredStarts.clear();

    for (const [id, stream] of this.streams) {
      if (enabled[id]) stream.start();
    }

    this.isRecording = true;
    this.emit('status', 'Listening…');

    // Load the model now rather than on the first utterance, so the first line
    // of the meeting isn't delayed by a cold start.
    whisperPool
      .warmup()
      .then((result) => {
        logger.info('Whisper warm', result);
        this.emit('status', `Ready · ${result.model} · ${result.compute_type} · ${result.device}`);
      })
      .catch((error) => {
        logger.warn('Whisper warmup failed', { error: error.message });
        this.emit('error', `Whisper warmup failed: ${error.message}`);
      });

    return this.getStatus();
  }

  async stop() {
    if (!this.isRecording) return this.getStatus();
    this.isRecording = false;

    await Promise.all(Array.from(this.streams.values()).map((stream) => stream.stop()));
    this.emit('status', 'Stopped');
    return this.getStatus();
  }

  /** Feed PCM16 @ 16kHz mono from the audio engine. */
  ingest(streamId, buffer) {
    if (!this.isRecording) return;
    const stream = this.streams.get(streamId);
    if (stream) stream.ingest(buffer);
  }

  getStatus() {
    return {
      recording: this.isRecording,
      available: this.isAvailable(),
      ...whisperPool.getStatus()
    };
  }

  /**
   * Drop microphone lines that are just the meeting audio coming back through
   * the speakers. The mic's echoCancellation handles most of it; this catches
   * what slips through by comparing against what "Them" said moments ago.
   *
   * The metric is containment (overlap coefficient), not Jaccard: the mic's VAD
   * often merges an echoed phrase with surrounding room noise into one longer
   * segment, which drags Jaccard well below any usable threshold even though
   * the meeting audio is entirely present inside it.
   */
  _isEcho(utterance) {
    const settings = settingsStore.all();
    if (!settings.echoSuppress) return false;
    if (utterance.streamId !== 'mic') return false;

    const threshold = Number(settings.echoSimilarity) || 0.8;
    const tokens = this._tokenize(utterance.text);
    // Short lines ("yes", "okay, sure") overlap by chance; requiring a few
    // words keeps genuine short replies from being swallowed.
    if (tokens.size < MIN_ECHO_TOKENS) return false;

    for (const entry of this.recentSystemLines) {
      if (entry.tokens.size < MIN_ECHO_TOKENS) continue;
      if (Math.abs(entry.startedAt - utterance.startedAt) > ECHO_WINDOW_MS) continue;
      if (this._containment(tokens, entry.tokens) >= threshold) return true;
    }
    return false;
  }

  _tokenize(text) {
    return new Set(
      String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  /** How much of the smaller set is contained in the larger one (0..1). */
  _containment(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    return intersection / Math.min(a.size, b.size);
  }

  _handleUtterance(utterance) {
    if (utterance.streamId === 'system') {
      this._rememberSystemLine(utterance);
      this.emit('utterance', utterance);
      return;
    }

    const settings = settingsStore.all();
    if (!settings.echoSuppress) {
      this.emit('utterance', utterance);
      return;
    }

    // The echoed copy can finish transcribing before the original does — the
    // two streams run through the same queue in arrival order, not speech
    // order. Give the system line a short grace period to land before ruling
    // on the mic line, otherwise the comparison has nothing to compare against.
    this.deferredStarts.add(utterance.startedAt);
    setTimeout(() => {
      this.deferredStarts.delete(utterance.startedAt);
      if (this._isEcho(utterance)) {
        logger.debug('Suppressed microphone echo', { text: utterance.text });
        return;
      }
      this.emit('utterance', utterance);
    }, ECHO_GRACE_MS);
  }

  _rememberSystemLine(utterance) {
    const now = Date.now();
    this.recentSystemLines.push({
      startedAt: utterance.startedAt,
      tokens: this._tokenize(utterance.text)
    });
    this.recentSystemLines = this.recentSystemLines.filter(
      (entry) => now - entry.startedAt < ECHO_HISTORY_MS
    );
  }

  /**
   * Earliest start time among utterances still being transcribed, or null.
   * The transcript writer uses this to avoid emitting an instantaneous event
   * (screenshot, marker) ahead of speech that began before it.
   */
  oldestPendingStartedAt() {
    let oldest = null;
    const consider = (candidate) => {
      if (candidate !== null && candidate !== undefined && (oldest === null || candidate < oldest)) {
        oldest = candidate;
      }
    };
    for (const stream of this.streams.values()) consider(stream.oldestPendingStartedAt());
    for (const startedAt of this.deferredStarts) consider(startedAt);
    return oldest;
  }

  // ── Path resolution ──

  _resolvePythonPath(settings) {
    if (settings.whisperPython && fs.existsSync(settings.whisperPython)) {
      return settings.whisperPython;
    }
    const venv = path.join(this._dataDir(), '.venv-whisper');
    const candidate = process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'python.exe')
      : path.join(venv, 'bin', 'python');
    return fs.existsSync(candidate) ? candidate : '';
  }

  _resolveScriptPath() {
    // In a packaged build the script is unpacked next to app.asar.
    const packed = path.join(__dirname, '..', '..', 'scripts', 'whisper_worker.py');
    const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : packed;
  }

  _resolveModelDir() {
    return path.join(this._dataDir(), '.whisper-models');
  }

  _dataDir() {
    try {
      return app.getPath('userData');
    } catch (_) {
      return path.join(process.env.APPDATA || require('os').homedir(), 'MeetScribe');
    }
  }

  shutdown() {
    this.stop().catch(() => {});
    whisperPool.close();
  }
}

module.exports = new TranscriptionService();
