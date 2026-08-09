const path = require('path');
const os = require('os');

/**
 * Static defaults for MeetScribe.
 *
 * Anything the user can change lives in settings.store.js (a JSON file in
 * userData); this module holds the shipped defaults and values that are not
 * user-facing. `settings.store` seeds itself from these defaults on first run.
 */
class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.MeetScribe');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'MeetScribe',
        version: '1.0.0',
        processTitle: 'MeetScribe',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },

      window: {
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      transcript: {
        // Where meeting folders are created. One folder per meeting.
        root: path.join(os.homedir(), 'Documents', 'MeetingTranscripts'),
        // The two pipelines finish out of order. Utterances are timestamped by
        // when speech *started*, so times are always right, but line order can
        // jitter. Hold finished lines this long and emit them sorted by start
        // time. 0 disables buffering (maximum durability, jittery ordering).
        reorderWindowMs: 1200,
        labels: { system: 'Them', mic: 'You' }
      },

      audio: {
        systemEnabled: true,
        micEnabled: true,
        // Persist the mic by label, not deviceId: Chromium deviceIds are
        // unstable/empty for file:// origins.
        micDeviceLabel: '',
        // 'loopback' uses Electron's WASAPI loopback (Windows). 'device' reads
        // a named input instead (Stereo Mix, VB-CABLE) for setups where
        // loopback is unavailable.
        systemSource: 'loopback',
        systemDeviceLabel: '',
        // The mic's own echoCancellation catches most speaker bleed; this drops
        // the leftovers by comparing a "You" line against recent "Them" lines.
        echoSuppress: true,
        echoSimilarity: 0.8
      },

      whisper: {
        model: 'small',
        language: 'auto',
        device: 'auto',
        computeType: 'auto',
        cpuThreads: 0,
        beamSize: 1,
        workerCount: 1,
        idleUnloadMs: 60000,
        pythonPath: '',

        // ── Voice-activity detection ──
        // Audio accumulates while someone is speaking and flushes on a natural
        // pause, so segments align with utterance boundaries instead of being
        // cut on a blind timer mid-word.
        vadEnabled: true,
        // Trailing silence (ms) that ends an utterance and triggers a flush.
        silenceHangoverMs: 700,
        // Minimum accumulated speech (ms) before a pause counts as an utterance
        // — guards against coughs/clicks producing empty flushes.
        minUtteranceMs: 350,
        // Hard cap (ms): force-flush a long monologue even without a pause.
        // Also the longest a line can take to appear, so keep it modest.
        maxUtteranceMs: 12000,
        // Audio (ms) kept before speech onset so the first syllable survives.
        preRollMs: 300,
        // Absolute RMS floor (normalized 0..1). Below this is always silence,
        // regardless of the adaptive noise floor.
        vadEnergyFloor: 0.008
      },

      ui: {
        windowGap: 10,
        transcriptFontSize: 13,
        overlayOpacity: 1,
        startClickThrough: false,
        autoStartRecording: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => (obj[key] = obj[key] || {}), this.config);
    target[lastKey] = value;
  }
}

module.exports = new ConfigManager();
