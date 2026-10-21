const fs = require('fs');
const path = require('path');
const WhisperWorkerService = require('./whisper-worker.service');
const logger = require('../core/logger').createServiceLogger('WHISPER-POOL');

// Beyond this the queue is unhealthy: shed the least important work rather than
// let latency grow without bound.
const MAX_QUEUE_DEPTH = 6;

/**
 * Serializes transcription requests from both audio streams onto a small pool
 * of persistent Python workers.
 *
 * One worker is the default. Two workers double model memory (≈400MB RSS each
 * on CPU int8, ≈1GB VRAM each on CUDA) and make two thread pools contend for
 * the same cores, which is slower than one serialized pool on a single machine.
 * A 5s utterance transcribes in well under a second, so a queued second stream
 * is imperceptible in a scrolling transcript. `workerCount` is configurable for
 * machines with GPU headroom.
 */
class WhisperPool {
  constructor() {
    this.workers = [];
    this.options = null;
    this.queue = [];
    this.lastLatencyMs = null;
    this.lastDevice = null;
    this.lastError = null;
  }

  /**
   * @param {object} options
   * @param {string} options.pythonPath  interpreter inside the whisper venv
   * @param {string} options.scriptPath  scripts/whisper_worker.py
   * @param {string} options.modelDir    where models are cached
   */
  configure(options) {
    const size = Math.max(1, Math.min(4, Number(options.workerCount) || 1));
    const changed =
      !this.options ||
      this.options.pythonPath !== options.pythonPath ||
      this.options.scriptPath !== options.scriptPath ||
      this.workers.length !== size;

    this.options = { ...options, workerCount: size };

    if (changed) {
      this.close();
      this.workers = Array.from({ length: size }, () => ({
        worker: new WhisperWorkerService(),
        busy: false
      }));
    }

    for (const slot of this.workers) {
      slot.worker.configure({
        pythonPath: options.pythonPath,
        scriptPath: options.scriptPath,
        idleUnloadMs: options.idleUnloadMs,
        env: this._buildEnv(options.pythonPath)
      });
    }
  }

  isConfigured() {
    return this.workers.length > 0 && this.workers[0].worker.isConfigured();
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      workers: this.workers.length,
      queueDepth: this.queue.length,
      busy: this.workers.filter((slot) => slot.busy).length,
      lastLatencyMs: this.lastLatencyMs,
      device: this.lastDevice,
      model: this.options && this.options.model,
      lastError: this.lastError
    };
  }

  /**
   * ctranslate2 >= 4.5 stopped bundling cuBLAS/cuDNN; the pip packages install
   * the DLLs under `site-packages/nvidia/<pkg>/bin`, which is not on PATH.
   * Without this the CUDA path fails with "Could not locate cudnn_ops64_9.dll".
   */
  /** The final pass runs its own Python process and needs the same PATH. */
  buildEnv(pythonPath) {
    return this._buildEnv(pythonPath);
  }

  _buildEnv(pythonPath) {
    // huggingface_hub links snapshot files to its blob store, and creating a
    // symlink on Windows needs Developer Mode or admin rights. Without this a
    // model download dies at the very last step with "WinError 1314: A required
    // privilege is not held by the client" — after fetching the entire file,
    // leaving a directory that looks complete but is missing config.json.
    // Setting it makes the hub copy instead of link.
    const env = { ...process.env, HF_HUB_DISABLE_SYMLINKS: '1' };
    if (process.platform !== 'win32' || !pythonPath) return env;
    try {
      const sitePackages = path.join(path.dirname(pythonPath), '..', 'Lib', 'site-packages', 'nvidia');
      if (!fs.existsSync(sitePackages)) return env;
      const binDirs = fs
        .readdirSync(sitePackages)
        .map((name) => path.join(sitePackages, name, 'bin'))
        .filter((dir) => fs.existsSync(dir));
      if (binDirs.length === 0) return env;
      env.PATH = `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH}`;
      return env;
    } catch (error) {
      logger.debug('Could not build CUDA env', { error: error.message });
      return env;
    }
  }

  async warmup() {
    if (!this.isConfigured()) return null;
    const slot = this.workers[0];
    return slot.worker.warmup(this._loadOptions());
  }

  _loadOptions() {
    const o = this.options || {};
    return {
      model: o.model || 'small',
      modelDir: o.modelDir || null,
      device: o.device || 'auto',
      computeType: o.computeType || 'auto',
      cpuThreads: o.cpuThreads || 0,
      // Must be forwarded: without it the worker falls back to auto-detect and
      // happily "detects" a random language on near-silent segments, producing
      // confident nonsense in a language nobody in the meeting is speaking.
      language: o.language || 'auto',
      beamSize: o.beamSize || 1,
      hotwords: o.hotwords || ''
    };
  }

  /**
   * Queue an utterance for transcription.
   * @param {string} wavPath
   * @param {object} meta  { streamId }
   */
  transcribe(wavPath, meta = {}) {
    if (!this.isConfigured()) {
      return Promise.reject(new Error('Whisper is not set up yet. Open Settings and run "Install / Repair Whisper".'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ wavPath, meta, resolve, reject, queuedAt: Date.now() });
      this._shed();
      this._drain();
    });
  }

  /**
   * Backpressure. When the queue is too deep, drop the oldest *mic* job first:
   * what the other participants said is the content worth keeping, and the
   * user knows what they themselves said.
   */
  _shed() {
    while (this.queue.length > MAX_QUEUE_DEPTH) {
      let index = this.queue.findIndex((job) => job.meta.streamId === 'mic');
      if (index === -1) index = 0;
      const [dropped] = this.queue.splice(index, 1);
      logger.warn('Transcription queue overloaded; dropping segment', {
        stream: dropped.meta.streamId,
        queueDepth: this.queue.length
      });
      try { fs.rmSync(dropped.wavPath, { force: true }); } catch (_) { /* ignore */ }
      dropped.resolve({ text: '', dropped: true });
    }
  }

  _drain() {
    if (this.queue.length === 0) return;

    const slot = this.workers.find((candidate) => !candidate.busy);
    if (!slot) return;

    const job = this.queue.shift();
    slot.busy = true;

    slot.worker
      .transcribe(job.wavPath, this._loadOptions())
      .then((result) => {
        this.lastLatencyMs = result && result.elapsed ? Math.round(result.elapsed * 1000) : null;
        this.lastDevice = (result && result.device) || this.lastDevice;
        this.lastError = null;
        job.resolve(result);
      })
      .catch((error) => {
        this.lastError = error.message;
        job.reject(error);
      })
      .finally(() => {
        slot.busy = false;
        this._drain();
      });
  }

  close() {
    for (const job of this.queue) {
      job.reject(new Error('Transcription pool closed'));
    }
    this.queue = [];
    for (const slot of this.workers) {
      try { slot.worker.close(); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = new WhisperPool();
