const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('ARCHIVE');

// 16kHz mono PCM16 => 2 bytes/sample => 32 bytes per millisecond.
const BYTES_PER_MS = 32;
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// How often a (wallclock, byteOffset) checkpoint is appended to timeline.jsonl.
const CHECKPOINT_INTERVAL_MS = 5000;

// A capture device that stops delivering leaves a hole in the file that no
// timestamp can account for. Pad the deficit with silence so the byte offset
// keeps tracking wall-clock, but only once it is large enough to be a genuine
// stall rather than IPC jitter.
const GAP_TOLERANCE_MS = 1500;
// One stall must never balloon the file: 60s of silence is plenty to re-anchor.
const MAX_GAP_PAD_MS = 60000;

/**
 * Continuous per-stream recording of the raw capture audio.
 *
 * This taps the PCM *before* voice-activity detection, on purpose. Archiving
 * the VAD segments instead would produce a file made of voiced fragments glued
 * together, and every timestamp the second pass derives from it would be offset
 * from wall-clock by however much silence was dropped — breaking both the
 * two-stream merge and alignment with screenshots.
 *
 * Files land in <meeting>/audio/:
 *   system.wav / mic.wav   continuous 16kHz mono PCM16 for the whole meeting
 *   timeline.jsonl         (wallclock, byteOffset) checkpoints and gap records
 *   meta.json              stream start times and labels, so a later re-run of
 *                          the final pass can reconstruct absolute times
 */
class AudioArchiveService {
  constructor() {
    this.active = false;
    this.folder = null;
    this.audioDir = null;
    this.streams = new Map(); // streamId -> writer state
    this.timelineFd = null;
    this.startedAt = null;
    this.labels = {};
  }

  isActive() {
    return this.active;
  }

  /**
   * Begin archiving into <meetingFolder>/audio. Writers are created lazily on
   * the first chunk, so a disabled stream leaves no empty file behind.
   */
  start(meetingFolder, labels = {}) {
    if (this.active) this.stopSync();

    this.folder = meetingFolder;
    this.audioDir = path.join(meetingFolder, 'audio');
    this.labels = labels;
    this.startedAt = Date.now();
    this.streams = new Map();

    try {
      fs.mkdirSync(this.audioDir, { recursive: true });
      this.timelineFd = fs.openSync(path.join(this.audioDir, 'timeline.jsonl'), 'a');
      this.active = true;
      this._timeline({ event: 'start', t: this.startedAt });
      logger.info('Audio archive started', { dir: this.audioDir });
    } catch (error) {
      this.active = false;
      logger.error('Could not start the audio archive', { error: error.message });
      throw error;
    }
  }

  /** Append one chunk of 16kHz mono PCM16. */
  write(streamId, buffer) {
    if (!this.active || !buffer || !buffer.length) return;

    let state = this.streams.get(streamId);
    if (!state) {
      state = this._openStream(streamId);
      if (!state) return;
    }

    const now = Date.now();
    this._padGapIfStalled(state, buffer.length, now);

    state.writer.write(buffer);
    state.bytes += buffer.length;
    state.lastChunkAt = now;

    if (now - state.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      state.lastCheckpointAt = now;
      this._timeline({ event: 'mark', stream: streamId, t: now, bytes: state.bytes });
    }
  }

  _openStream(streamId) {
    try {
      const wavPath = path.join(this.audioDir, streamId + '.wav');
      const writer = fs.createWriteStream(wavPath);
      writer.on('error', (error) => {
        logger.error('Archive write failed', { stream: streamId, error: error.message });
      });
      // Placeholder sizes; patched with the real lengths on stop.
      writer.write(this._wavHeader(0));

      const now = Date.now();
      const state = {
        streamId,
        path: wavPath,
        writer,
        bytes: 0,
        startedAt: now,
        lastChunkAt: now,
        lastCheckpointAt: now,
        gapMs: 0
      };
      this.streams.set(streamId, state);
      this._timeline({ event: 'open', stream: streamId, t: now, bytes: 0 });
      return state;
    } catch (error) {
      logger.error('Could not open archive file', { stream: streamId, error: error.message });
      return null;
    }
  }

  /**
   * Keep byte offset and wall-clock in step across a capture stall. Without
   * this, a device that goes quiet for ten seconds simply splices the audio and
   * every timestamp after the stall is ten seconds early.
   */
  _padGapIfStalled(state, incomingBytes, now) {
    const expectedBytes = (now - state.startedAt) * BYTES_PER_MS;
    const deficitBytes = expectedBytes - (state.bytes + incomingBytes);
    if (deficitBytes < GAP_TOLERANCE_MS * BYTES_PER_MS) return;

    const padBytes = Math.min(deficitBytes, MAX_GAP_PAD_MS * BYTES_PER_MS);
    // Round to a whole sample so the stream never desynchronises mid-sample.
    const aligned = padBytes - (padBytes % 2);
    if (aligned <= 0) return;

    state.writer.write(Buffer.alloc(aligned));
    state.bytes += aligned;
    state.gapMs += Math.round(aligned / BYTES_PER_MS);
    this._timeline({
      event: 'gap',
      stream: state.streamId,
      t: now,
      bytes: state.bytes,
      paddedMs: Math.round(aligned / BYTES_PER_MS)
    });
    logger.warn('Padded a capture stall in the archive', {
      stream: state.streamId,
      ms: Math.round(aligned / BYTES_PER_MS)
    });
  }

  /**
   * Close the writers, patch the WAV headers, write meta.json.
   * Returns the archive descriptor the final pass runs on, or null.
   */
  async stop() {
    if (!this.active) return null;
    this.active = false;

    const streams = [];
    for (const state of this.streams.values()) {
      await new Promise((resolve) => state.writer.end(resolve));
      this._patchWavHeader(state.path, state.bytes);
      streams.push({
        stream: state.streamId,
        label: this.labels[state.streamId] || state.streamId,
        path: state.path,
        bytes: state.bytes,
        durationMs: Math.round(state.bytes / BYTES_PER_MS),
        startedAt: state.startedAt,
        paddedMs: state.gapMs
      });
    }

    this._timeline({ event: 'stop', t: Date.now() });
    this._closeTimeline();

    const meta = {
      version: 1,
      meetingFolder: this.folder,
      startedAt: this.startedAt,
      stoppedAt: Date.now(),
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      streams
    };

    if (streams.length === 0) {
      // Nothing was captured — do not leave an empty audio folder implying otherwise.
      try { fs.rmSync(this.audioDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      logger.warn('Audio archive stopped with no captured audio');
      return null;
    }

    try {
      fs.writeFileSync(path.join(this.audioDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (error) {
      logger.error('Could not write archive meta.json', { error: error.message });
    }

    logger.info('Audio archive stopped', {
      streams: streams.map((s) => s.stream + ':' + Math.round(s.durationMs / 1000) + 's').join(' ')
    });
    return meta;
  }

  /** Best-effort close for crash/quit paths, where awaiting is not an option. */
  stopSync() {
    if (!this.active) return;
    this.active = false;
    for (const state of this.streams.values()) {
      try {
        state.writer.end();
        this._patchWavHeader(state.path, state.bytes);
      } catch (_) { /* ignore */ }
    }
    this._closeTimeline();
  }

  /**
   * A WAV written incrementally cannot know its own length up front. The sizes
   * go in as zero and are patched here. If the app dies before this runs the
   * PCM is still intact and the header can be rebuilt from the file size.
   */
  _patchWavHeader(wavPath, dataBytes) {
    try {
      const fd = fs.openSync(wavPath, 'r+');
      const sizes = Buffer.alloc(4);
      sizes.writeUInt32LE(36 + dataBytes, 0);
      fs.writeSync(fd, sizes, 0, 4, 4);
      sizes.writeUInt32LE(dataBytes, 0);
      fs.writeSync(fd, sizes, 0, 4, 40);
      fs.closeSync(fd);
    } catch (error) {
      logger.error('Could not patch WAV header', { file: wavPath, error: error.message });
    }
  }

  /**
   * Repair an archived WAV in place.
   *
   * Covers two cases, both of which leave the PCM itself perfectly intact:
   *  - a header field written wrong by an earlier build (a zero bitsPerSample
   *    makes FFmpeg segfault rather than report an error), and
   *  - sizes left at zero because the app died before the writer closed.
   *
   * Returns the list of fields it had to fix.
   */
  repairWav(wavPath) {
    let fd = null;
    try {
      const size = fs.statSync(wavPath).size;
      if (size < 44) return [];

      fd = fs.openSync(wavPath, 'r+');
      const header = Buffer.alloc(44);
      fs.readSync(fd, header, 0, 44, 0);

      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
        return [];
      }

      const dataBytes = size - 44;
      const expectedBlockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
      const expectedByteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
      const fixed = [];

      const patch = (offset, bytes, value, name) => {
        const buffer = Buffer.alloc(bytes);
        if (bytes === 2) buffer.writeUInt16LE(value, 0);
        else buffer.writeUInt32LE(value, 0);
        fs.writeSync(fd, buffer, 0, bytes, offset);
        fixed.push(name);
      };

      if (header.readUInt16LE(34) !== BITS_PER_SAMPLE) patch(34, 2, BITS_PER_SAMPLE, 'bitsPerSample');
      if (header.readUInt16LE(32) !== expectedBlockAlign) patch(32, 2, expectedBlockAlign, 'blockAlign');
      if (header.readUInt32LE(28) !== expectedByteRate) patch(28, 4, expectedByteRate, 'byteRate');
      if (header.readUInt32LE(40) !== dataBytes) patch(40, 4, dataBytes, 'dataSize');
      if (header.readUInt32LE(4) !== dataBytes + 36) patch(4, 4, dataBytes + 36, 'riffSize');

      if (fixed.length > 0) {
        logger.warn('Repaired an archived WAV header', { file: wavPath, fields: fixed.join(', ') });
      }
      return fixed;
    } catch (error) {
      logger.warn('Could not repair WAV header', { file: wavPath, error: error.message });
      return [];
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      }
    }
  }

  _wavHeader(dataBytes) {
    const header = Buffer.alloc(44);
    const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
    const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataBytes, 40);

    // A malformed field here does not fail here — it fails much later, inside
    // FFmpeg, as a segfault in the final pass with no usable error. Check the
    // header while there is still a stack trace worth reading.
    this._assertValidHeader(header);
    return header;
  }

  _assertValidHeader(header) {
    const checks = [
      ['RIFF', header.toString('ascii', 0, 4) === 'RIFF'],
      ['WAVE', header.toString('ascii', 8, 12) === 'WAVE'],
      ['fmt ', header.toString('ascii', 12, 16) === 'fmt '],
      ['fmtSize', header.readUInt32LE(16) === 16],
      ['pcm', header.readUInt16LE(20) === 1],
      ['channels', header.readUInt16LE(22) === CHANNELS],
      ['sampleRate', header.readUInt32LE(24) === SAMPLE_RATE],
      ['byteRate', header.readUInt32LE(28) === SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)],
      ['blockAlign', header.readUInt16LE(32) === CHANNELS * (BITS_PER_SAMPLE / 8)],
      ['bitsPerSample', header.readUInt16LE(34) === BITS_PER_SAMPLE],
      ['data', header.toString('ascii', 36, 40) === 'data']
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (bad.length > 0) {
      throw new Error(`Refusing to write a malformed WAV header (bad: ${bad.join(', ')})`);
    }
  }

  _timeline(entry) {
    if (this.timelineFd === null) return;
    try {
      fs.writeSync(this.timelineFd, JSON.stringify(entry) + '\n');
    } catch (_) { /* a lost checkpoint must never stop a recording */ }
  }

  _closeTimeline() {
    if (this.timelineFd === null) return;
    try { fs.closeSync(this.timelineFd); } catch (_) { /* ignore */ }
    this.timelineFd = null;
  }
}

module.exports = new AudioArchiveService();
