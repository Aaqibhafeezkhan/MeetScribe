const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const config = require('./config');
const logger = require('./logger').createServiceLogger('SETTINGS');

/**
 * User settings, persisted as JSON in userData.
 *
 * This replaces the old .env persistence. Settings now include user-picked
 * Windows paths (backslashes, spaces, drive colons), which dotenv's quoting
 * rules mangle; JSON has no quoting semantics to get wrong. There are no API
 * keys left in this app, so .env has nothing else to hold.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated settings file that bricks the next launch.
 */
class SettingsStore {
  constructor() {
    this.filePath = null;
    this.values = null;
  }

  /** Shipped defaults — the shape of the settings object. */
  defaults() {
    return {
      transcriptRoot: config.get('transcript.root'),
      reorderWindowMs: config.get('transcript.reorderWindowMs'),
      labelSystem: config.get('transcript.labels.system'),
      labelMic: config.get('transcript.labels.mic'),

      systemEnabled: config.get('audio.systemEnabled'),
      micEnabled: config.get('audio.micEnabled'),
      systemSource: config.get('audio.systemSource'),
      systemDeviceLabel: config.get('audio.systemDeviceLabel'),
      micDeviceLabel: config.get('audio.micDeviceLabel'),
      echoSuppress: config.get('audio.echoSuppress'),
      echoSimilarity: config.get('audio.echoSimilarity'),

      glossary: config.get('whisper.glossary'),

      archiveAudio: config.get('offline.archiveAudio'),
      archiveFormat: config.get('offline.archiveFormat'),
      offlinePassEnabled: config.get('offline.passEnabled'),
      offlineModel: config.get('offline.model'),
      offlineDiffModel: config.get('offline.diffModel'),
      offlineBeamSize: config.get('offline.beamSize'),
      offlineComputeType: config.get('offline.computeType'),
      offlineCpuThreads: config.get('offline.cpuThreads'),
      offlineWordConfidence: config.get('offline.wordConfidence'),

      whisperPython: config.get('whisper.pythonPath'),
      whisperModel: config.get('whisper.model'),
      whisperLanguage: config.get('whisper.language'),
      whisperDevice: config.get('whisper.device'),
      whisperComputeType: config.get('whisper.computeType'),
      whisperCpuThreads: config.get('whisper.cpuThreads'),
      whisperBeamSize: config.get('whisper.beamSize'),
      whisperWorkerCount: config.get('whisper.workerCount'),
      whisperIdleUnloadMs: config.get('whisper.idleUnloadMs'),

      vadEnabled: config.get('whisper.vadEnabled'),
      silenceHangoverMs: config.get('whisper.silenceHangoverMs'),
      minUtteranceMs: config.get('whisper.minUtteranceMs'),
      maxUtteranceMs: config.get('whisper.maxUtteranceMs'),
      preRollMs: config.get('whisper.preRollMs'),
      vadEnergyFloor: config.get('whisper.vadEnergyFloor'),

      appIcon: 'terminal',
      windowGap: config.get('ui.windowGap'),
      transcriptFontSize: config.get('ui.transcriptFontSize'),
      overlayOpacity: config.get('ui.overlayOpacity'),
      startClickThrough: config.get('ui.startClickThrough'),
      autoStartRecording: config.get('ui.autoStartRecording')
    };
  }

  _resolvePath() {
    if (this.filePath) return this.filePath;
    try {
      this.filePath = path.join(app.getPath('userData'), 'settings.json');
    } catch (_) {
      // app not ready yet (should not happen — load() is called after ready)
      this.filePath = path.join(config.get('app.dataDir'), 'settings.json');
    }
    return this.filePath;
  }

  load() {
    const file = this._resolvePath();
    const defaults = this.defaults();
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Merge over defaults so settings added in a later version appear
        // with their default rather than as undefined.
        this.values = { ...defaults, ...parsed };
      } else {
        this.values = defaults;
        this.save(this.values);
      }
    } catch (error) {
      logger.warn('Could not read settings; falling back to defaults', {
        file,
        error: error.message
      });
      this.values = defaults;
    }
    return this.values;
  }

  all() {
    if (!this.values) this.load();
    return { ...this.values };
  }

  get(key) {
    if (!this.values) this.load();
    return this.values[key];
  }

  /** Merge a partial update and persist. Returns the full settings object. */
  update(patch) {
    if (!this.values) this.load();
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue;
      if (!(key in next)) continue; // ignore unknown keys from the renderer
      next[key] = value;
    }
    this.values = next;
    this.save(next);
    return { ...next };
  }

  save(values) {
    const file = this._resolvePath();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(values, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      logger.error('Failed to persist settings', { file, error: error.message });
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = new SettingsStore();
