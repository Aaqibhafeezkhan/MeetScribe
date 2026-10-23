const fs = require('fs');
const settingsStore = require('../core/settings.store');
const logger = require('../core/logger').createServiceLogger('SPEED');

// In userData. Numbers only: no folders, no text.
const FILE_NAME = 'model-speed.json';
// Samples kept per model + mode. Old ones age out, so a driver update or a new
// laptop shows up in the estimate within a few dozen meetings.
const MAX_SAMPLES = 50;
// How much each prior counts, in seconds of the quantity it describes. A prior
// worth half an hour of speech gives way to real use after one or two
// meetings, and still keeps a single odd meeting from swinging the estimate.
const SPEED_PRIOR_WEIGHT_SEC = 1800;
const SPEECH_PRIOR_WEIGHT_SEC = 3600;
// Speech per meeting-hour, both streams together, before any real data.
// Calibrated so large-v3-turbo's prior matches real meetings (a final pass of
// 0.27-0.31x the meeting length): real speech is denser than the benchmark
// clip and VAD pads every chunk, so this exceeds a clock hour. Refined by every
// pass.
const PRIOR_SPEECH_PER_HOUR_SEC = 4200;
// Measured: quality mode is ~5x slower per speech-second than fast mode.
const QUALITY_SLOWDOWN = 5.3;
// CTranslate2 scales sublinearly with threads; used only to translate samples
// taken at a different thread count.
const THREAD_EXPONENT = 0.6;

/**
 * Learns how long a final pass takes, so the estimate in Settings starts from a
 * benchmark and converges on this machine and these meetings.
 *
 * Split in two, because they vary independently:
 *   speed          decode seconds per second of speech, per model + mode
 *   speechPerHour  seconds of speech per meeting-hour, for every model
 * so one meeting on a new model already benefits from every earlier meeting.
 */
class SpeedStats {
  constructor() {
    this.data = null;
  }

  _file() {
    return settingsStore.userDataFile(FILE_NAME);
  }

  _load() {
    if (this.data) return this.data;
    this.data = { version: 1, speed: {}, meetings: [] };
    try {
      const file = this._file();
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.speed && Array.isArray(parsed.meetings)) this.data = parsed;
      }
    } catch (error) {
      logger.warn('Could not read model speed stats', { error: error.message });
    }
    return this.data;
  }

  _save() {
    try {
      fs.writeFileSync(this._file(), JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.warn('Could not save model speed stats', { error: error.message });
    }
  }

  /**
   * One finished pass. `streams` is [{ speechSec, decodeSec }] for the primary
   * model only; the diff model is not part of the estimate.
   */
  record({ model, mode, threads, streams, meetingSec, loadSec }) {
    const speechSec = streams.reduce((sum, s) => sum + (Number(s.speechSec) || 0), 0);
    const decodeSec = streams.reduce((sum, s) => sum + (Number(s.decodeSec) || 0), 0);
    if (!model || !(meetingSec > 0)) return;

    const data = this._load();
    const key = model + '|' + (mode || 'fast');
    const samples = data.speed[key] || (data.speed[key] = []);
    // A meeting with no speech says nothing about decode speed.
    if (speechSec > 5) {
      samples.push({ speechSec, decodeSec, threads: Number(threads) || 0, loadSec: Number(loadSec) || 0 });
      while (samples.length > MAX_SAMPLES) samples.shift();
    }
    data.meetings.push({ speechSec, meetingSec });
    while (data.meetings.length > MAX_SAMPLES) data.meetings.shift();
    this._save();
    logger.info('Recorded final pass speed', {
      model, mode, speechSec: Math.round(speechSec), decodeSec: Math.round(decodeSec), meetingSec: Math.round(meetingSec)
    });
  }

  /** Learned seconds of speech per meeting-hour, blended with the prior. */
  speechPerHour() {
    const { meetings } = this._load();
    let speech = PRIOR_SPEECH_PER_HOUR_SEC * (SPEECH_PRIOR_WEIGHT_SEC / 3600);
    let meeting = SPEECH_PRIOR_WEIGHT_SEC;
    for (const entry of meetings) {
      speech += entry.speechSec;
      meeting += entry.meetingSec;
    }
    return { value: (speech / meeting) * 3600, meetings: meetings.length };
  }

  /**
   * Estimated minutes for a 1 h meeting.
   * @param {string} model
   * @param {object} prior  { speed, loadSec } from the model catalog (fast mode)
   * @param {string} mode   'fast' | 'quality'
   * @param {number} threads
   */
  estimate(model, prior, mode, threads) {
    const data = this._load();
    const modeFactor = mode === 'quality' ? QUALITY_SLOWDOWN : 1;
    const own = data.speed[model + '|' + mode] || [];
    // No samples in this mode: borrow the other mode's, converted.
    const otherMode = mode === 'quality' ? 'fast' : 'quality';
    const other = own.length ? [] : (data.speed[model + '|' + otherMode] || []);
    const convert = own.length ? 1 : (mode === 'quality' ? QUALITY_SLOWDOWN : 1 / QUALITY_SLOWDOWN);
    const samples = own.length ? own : other;

    let weighted = prior.speed * modeFactor * SPEED_PRIOR_WEIGHT_SEC;
    let weight = SPEED_PRIOR_WEIGHT_SEC;
    let load = prior.loadSec || 10;
    let loadCount = 1;
    for (const sample of samples) {
      const threadScale = sample.threads && threads ? Math.pow(sample.threads / threads, THREAD_EXPONENT) : 1;
      weighted += (sample.decodeSec * threadScale * convert);
      weight += sample.speechSec;
      if (sample.loadSec) {
        load += sample.loadSec;
        loadCount++;
      }
    }
    const speed = weighted / weight;
    const speech = this.speechPerHour();
    const minutes = (speed * speech.value + load / loadCount) / 60;
    return { minutes, meetings: samples.length, learned: samples.length > 0 || speech.meetings > 0 };
  }
}

module.exports = new SpeedStats();
module.exports.SpeedStats = SpeedStats;
