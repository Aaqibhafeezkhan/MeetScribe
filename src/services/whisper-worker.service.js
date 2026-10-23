const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER-WORKER');

class WhisperWorkerService {
  constructor() {
    this.process = null;
    this.pythonPath = null;
    this.scriptPath = null;
    this.env = undefined;
    this.pending = new Map();
    this.sequence = 0;
    this.idleTimer = null;
    this.idleUnloadMs = 60000;
    this.readyInfo = null;
    this.closing = false;
  }

  configure({ pythonPath, scriptPath, idleUnloadMs = 60000, env }) {
    const changed = this.pythonPath !== pythonPath || this.scriptPath !== scriptPath;
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.idleUnloadMs = idleUnloadMs || 60000;
    // Optional PATH override so the child can find CUDA DLLs (see whisper-pool).
    this.env = env;
    if (changed) {
      this.close();
    }
  }

  isConfigured() {
    return Boolean(
      this.pythonPath &&
      this.scriptPath &&
      fs.existsSync(this.pythonPath) &&
      fs.existsSync(this.scriptPath)
    );
  }

  async transcribe(audioPath, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    const result = await this._request({
      action: 'transcribe',
      audio_path: audioPath,
      model: options.model || 'small',
      language: options.language || 'auto',
      model_dir: options.modelDir || null,
      device: options.device || 'auto',
      compute_type: options.computeType || 'auto',
      cpu_threads: options.cpuThreads || 0,
      beam_size: options.beamSize || 1,
      hotwords: options.hotwords || ''
    });
    this._scheduleIdleUnload();
    return result;
  }

  async warmup(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    // Generous timeout: a warmup may include a first-time model download.
    return this._request({
      action: 'warmup',
      model: options.model || 'small',
      model_dir: options.modelDir || null,
      device: options.device || 'auto',
      compute_type: options.computeType || 'auto',
      cpu_threads: options.cpuThreads || 0
    }, 600000);
  }

  releaseWhenIdle() {
    if (this.process) {
      this._scheduleIdleUnload();
    }
  }

  _ensureProcess() {
    if (this.process && !this.process.killed) {
      return;
    }

    this.readyInfo = null;
    this.closing = false;
    const child = spawn(this.pythonPath, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.env
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this._handleLine(line));

    // Info, not debug: the worker only writes here for things that explain a
    // slow or failed transcription (model load time, CUDA fallback to CPU).
    // The tail also goes into the exit log, since a crash leaves only a code.
    const stderrTail = [];
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        logger.info('Worker stderr', { message: message.substring(0, 1000) });
        stderrTail.push(message);
        while (stderrTail.length > 8) stderrTail.shift();
      }
    });

    // Both handlers ignore a child that has already been replaced: after a
    // restart the old process exits late, and must not null out or fail the
    // requests of its successor.
    child.on('error', (error) => {
      if (this.process !== child) return;
      logger.error('Whisper worker process error', { error: error.message });
      this._rejectAll(error);
    });

    child.on('close', (code) => {
      if (this.process !== child) return;
      const error = new Error(`Whisper worker exited with code ${code}`);
      if (!this.closing && code !== 0) {
        logger.error(error.message, {
          pending: this.pending.size,
          stderr: stderrTail.join(' | ').substring(0, 600)
        });
      }
      this.process = null;
      this.readyInfo = null;
      if (!this.closing) {
        this._rejectAll(error);
      }
      this.closing = false;
    });
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      logger.warn('Ignoring non-JSON worker output', { line: line.substring(0, 500) });
      return;
    }

    if (message.event === 'ready') {
      this.readyInfo = message;
      logger.info('Persistent Whisper worker ready', message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) {
      pending.resolve(message);
    } else {
      const error = new Error(message.error || 'Whisper worker request failed');
      error.workerTraceback = message.traceback;
      pending.reject(error);
    }
  }

  // 45s, not minutes: a 12s utterance that hasn't come back in 45s means the
  // worker is wedged, and a fast error beats a three-minute silent stall.
  _request(payload, timeoutMs = 45000) {
    this._ensureProcess();
    const id = ++this.sequence;
    const request = { ...payload, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.error('Whisper worker request timed out', { action: payload.action, timeoutMs });
        reject(new Error(`Whisper worker timed out after ${timeoutMs}ms`));
        // A wedged worker would stall every request after this one too. Kill
        // it; the next request spawns a fresh one (and reloads the model).
        logger.warn('Restarting the Whisper worker after a timeout');
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      this.process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  _scheduleIdleUnload() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.process || this.pending.size > 0) {
        return;
      }
      this._request({ action: 'unload' }, 30000)
        .then(() => logger.info('Whisper model unloaded after idle timeout'))
        .catch((error) => logger.warn('Could not unload idle Whisper model', { error: error.message }));
    }, this.idleUnloadMs);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this._clearIdleTimer();
    if (this.process && !this.process.killed) {
      try {
        this.closing = true;
        this.process.kill();
      } catch (_) {
        // Ignore shutdown races.
      }
    }
    this.process = null;
    this.readyInfo = null;
    this._rejectAll(new Error('Whisper worker closed'));
  }
}

module.exports = WhisperWorkerService;
