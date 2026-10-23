const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('MODELS');

/**
 * The models Settings offers. `id` is what the settings store and what
 * WhisperModel() receives; `repo` is where it lives on Hugging Face (mirrors
 * faster-whisper's own alias map in faster_whisper/utils.py). Custom ids
 * typed by the user are any CTranslate2 repo and resolve to themselves.
 *
 * `speed` is the fast-mode prior for the time estimate: decode seconds per
 * second of speech, measured on a 12-core laptop CPU (int8, 12 threads, beam 2,
 * batch 8) over 10 minutes of German speech. The two large-v3 entries are not
 * measured yet and are a rough guess (32 decoder layers against turbo's 4);
 * real passes replace every prior (speed-stats.service.js).
 */
const CATALOG = [
  { id: 'tiny', repo: 'Systran/faster-whisper-tiny', label: 'tiny', sizeMb: 75,
    note: 'Multilingual · live only: too inaccurate for a final pass', speed: 0.08, loadSec: 1, roles: ['live'] },
  { id: 'base', repo: 'Systran/faster-whisper-base', label: 'base', sizeMb: 145,
    note: 'Multilingual', speed: 0.1, loadSec: 1, roles: ['live'] },
  { id: 'small', repo: 'Systran/faster-whisper-small', label: 'small', sizeMb: 465,
    note: 'Multilingual · recommended for live', speed: 0.142, loadSec: 5, roles: ['live', 'final'] },
  { id: 'medium', repo: 'Systran/faster-whisper-medium', label: 'medium', sizeMb: 1530,
    note: 'Multilingual', speed: 0.313, loadSec: 8, roles: ['live', 'final'] },
  { id: 'large-v3-turbo', repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', label: 'large-v3-turbo', sizeMb: 1620,
    note: 'Multilingual · recommended final pass', speed: 0.248, loadSec: 10, roles: ['live', 'final'] },
  { id: 'cstr/whisper-large-v3-turbo-german-int8_float32', repo: 'cstr/whisper-large-v3-turbo-german-int8_float32',
    label: 'German turbo', sizeMb: 815, note: 'German fine-tune of large-v3-turbo (primeline)',
    speed: 0.241, loadSec: 5, roles: ['final'] },
  { id: 'large-v3', repo: 'Systran/faster-whisper-large-v3', label: 'large-v3', sizeMb: 3090,
    note: 'Multilingual · slowest, most accurate', speed: 0.7, loadSec: 15, roles: ['final'] },
  { id: 'tnfru/whisper-large-v3-german-ct2', repo: 'tnfru/whisper-large-v3-german-ct2', label: 'German large-v3',
    sizeMb: 3090, note: 'German fine-tune of large-v3 (primeline) · slow', speed: 0.7, loadSec: 15, roles: ['final'] }
];

const ALIASES = { turbo: 'large-v3-turbo', large: 'large-v3' };

function catalogEntry(id) {
  const key = ALIASES[id] || id;
  return CATALOG.find((entry) => entry.id === key || entry.repo === key) || null;
}

function repoFor(id) {
  if (!id) return null;
  const entry = catalogEntry(id);
  if (entry) return entry.repo;
  return id.includes('/') ? id : null;
}

function dirFor(modelDir, repo) {
  return path.join(modelDir, 'models--' + repo.replace(/\//g, '--'));
}

function sizeOf(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else {
      try { total += fs.statSync(full).size; } catch (_) { /* vanished mid-walk */ }
    }
  }
  return total;
}

/**
 * Complete means faster-whisper can load it offline: a snapshot holding the
 * weights and config, and no half-written blob from an interrupted download.
 */
function isComplete(dir) {
  try {
    const blobs = path.join(dir, 'blobs');
    if (fs.existsSync(blobs) && fs.readdirSync(blobs).some((name) => name.endsWith('.incomplete'))) return false;
    const snapshots = path.join(dir, 'snapshots');
    return fs.readdirSync(snapshots).some((rev) =>
      fs.existsSync(path.join(snapshots, rev, 'model.bin')) && fs.existsSync(path.join(snapshots, rev, 'config.json'))
    );
  } catch (_) {
    return false;
  }
}

class ModelStore extends EventEmitter {
  constructor() {
    super();
    this.downloading = null;
  }

  /**
   * Every catalog model plus anything else found in the cache.
   * @param {string} modelDir
   * @param {object} inUse  { live, final, diff } model ids from settings
   */
  list(modelDir, inUse = {}) {
    const rows = CATALOG.map((entry) => ({ ...entry, custom: false }));
    try {
      for (const name of fs.readdirSync(modelDir)) {
        if (!name.startsWith('models--')) continue;
        const repo = name.slice('models--'.length).replace('--', '/');
        if (!rows.some((row) => row.repo === repo)) {
          rows.push({ id: repo, repo, label: repo, sizeMb: 0, note: 'Custom model', speed: 0.2, loadSec: 8,
            roles: ['live', 'final'], custom: true });
        }
      }
    } catch (_) {
      // No cache yet: nothing downloaded.
    }

    return rows.map((row) => {
      const dir = dirFor(modelDir, row.repo);
      const exists = fs.existsSync(dir);
      const downloading = this.downloading && this.downloading.repo === row.repo;
      return {
        ...row,
        downloaded: exists && !downloading && isComplete(dir),
        downloading: Boolean(downloading),
        progress: downloading ? this.downloading.progress : 0,
        bytes: exists ? sizeOf(dir) : 0,
        inUse: ['live', 'final', 'diff'].filter((role) => inUse[role] && repoFor(inUse[role]) === row.repo)
      };
    });
  }

  /**
   * Fetch a model into the cache without loading it, through faster-whisper's
   * own downloader so the layout is exactly what WhisperModel() looks for.
   * @param {string} id
   * @param {object} paths  { python, modelDir, env } from transcriptionService.getPaths()
   */
  download(id, paths) {
    const repo = repoFor(id);
    // Preconditions throw synchronously, so the caller can answer the click at
    // once; the download itself reports through 'progress' events.
    if (!repo) throw new Error('Unknown model: ' + id);
    if (this.downloading) throw new Error('Another model is downloading');
    if (!paths.python || !fs.existsSync(paths.python)) {
      throw new Error('The Whisper Python environment was not found');
    }

    const entry = catalogEntry(id);
    const expected = ((entry && entry.sizeMb) || 0) * 1e6;
    const dir = dirFor(paths.modelDir, repo);
    fs.mkdirSync(paths.modelDir, { recursive: true });
    this.downloading = { repo, progress: 0 };
    this.emit('progress', { id, repo, state: 'downloading', progress: 0 });
    logger.info('Downloading model', { repo });
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(paths.python, ['-c',
        'import sys\nfrom faster_whisper import download_model\ndownload_model(sys.argv[1], cache_dir=sys.argv[2])',
        repo, paths.modelDir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: paths.env });

      const stderrTail = [];
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (!text) return;
        stderrTail.push(text);
        while (stderrTail.length > 6) stderrTail.shift();
      });

      // The downloader prints a progress bar for a terminal; the size on disk
      // against the catalog size is simpler and good enough for a bar.
      const poll = setInterval(() => {
        if (!expected) return;
        const progress = Math.min(0.99, sizeOf(dir) / expected);
        this.downloading.progress = progress;
        this.emit('progress', { id, repo, state: 'downloading', progress });
      }, 2000);

      const finish = (error) => {
        clearInterval(poll);
        this.downloading = null;
        if (error) {
          logger.error('Model download failed', { repo, error: error.message });
          this.emit('progress', { id, repo, state: 'failed', error: error.message });
          return reject(error);
        }
        logger.info('Model downloaded', { repo, seconds: Math.round((Date.now() - started) / 1000), bytes: sizeOf(dir) });
        this.emit('progress', { id, repo, state: 'done', progress: 1 });
        resolve({ ok: true, repo });
      };

      child.on('error', finish);
      child.on('close', (code) => {
        if (code === 0 && isComplete(dir)) return finish(null);
        const detail = stderrTail.join(' | ').slice(-400);
        finish(new Error('Download failed' + (code ? ' (exit ' + code + ')' : '') + (detail ? ': ' + detail : '')));
      });
    });
  }

  /**
   * @param {string} id
   * @param {string} modelDir
   * @param {object} busy  { recording, liveModel, finalRunning, finalModel, diffModel }
   */
  remove(id, modelDir, busy = {}) {
    const repo = repoFor(id);
    if (!repo) throw new Error('Unknown model: ' + id);
    if (this.downloading && this.downloading.repo === repo) throw new Error('This model is downloading');
    if (busy.recording && repoFor(busy.liveModel) === repo) {
      throw new Error('The live transcript is using this model; stop recording first');
    }
    if (busy.finalRunning && [busy.finalModel, busy.diffModel].some((m) => repoFor(m) === repo)) {
      throw new Error('A final pass is using this model; wait for it to finish');
    }

    const dir = dirFor(modelDir, repo);
    if (!fs.existsSync(dir)) return { ok: true, freed: 0 };
    const freed = sizeOf(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      const busyFile = error.code === 'EBUSY' || error.code === 'EPERM';
      logger.warn('Could not delete model', { repo, code: error.code });
      throw new Error(busyFile ? 'The model is still loaded; try again once the app is idle' : error.message);
    }
    logger.info('Deleted model', { repo, bytes: freed });
    return { ok: true, freed };
  }
}

module.exports = new ModelStore();
module.exports.CATALOG = CATALOG;
module.exports.catalogEntry = catalogEntry;
module.exports.repoFor = repoFor;
module.exports.ModelStore = ModelStore;
