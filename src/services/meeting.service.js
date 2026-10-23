const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const settingsStore = require('../core/settings.store');
const corrections = require('./corrections');
const logger = require('../core/logger').createServiceLogger('MEETING');
const { partitionPendingEntries } = require('./meeting-ordering');

const pad = (value) => String(value).padStart(2, '0');

// Never hold a line longer than this waiting for an earlier one, however
// wedged transcription gets. Durability beats perfect ordering.
const MAX_HOLD_MS = 15000;

/**
 * Owns one meeting's folder on disk and appends the transcript as it happens.
 *
 * Durability is the point: the file descriptor stays open for the whole meeting
 * and every line is fsync'd. A meeting produces a few lines a minute, so the
 * fsync cost is irrelevant next to the guarantee that a crash or power loss
 * cannot lose what was already said.
 *
 * Ordering: the system and mic pipelines finish out of order, so finished lines
 * are held for `reorderWindowMs` and emitted sorted by when speech *started*.
 * Timestamps are always correct regardless; the buffer only fixes line order.
 */
class MeetingService extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.folder = null;
    this.transcriptPath = null;
    this.fd = null;
    this.startedAt = null;
    this.lineCount = 0;
    this.shotCount = 0;
    this.pending = [];
    this.events = [];
    this.flushTimer = null;
    // Injected by main.js: returns the earliest start time still being
    // transcribed, so a screenshot taken at 14:32:05 cannot be written above
    // a sentence that started at 14:32:00 and is still in the Whisper queue.
    this.pendingProvider = null;
  }

  setPendingProvider(fn) {
    this.pendingProvider = fn;
  }

  isActive() {
    return this.active;
  }

  getStatus() {
    return {
      active: this.active,
      folder: this.folder,
      transcriptPath: this.transcriptPath,
      startedAt: this.startedAt,
      lineCount: this.lineCount,
      shotCount: this.shotCount
    };
  }

  /** Create the meeting folder and open transcript.txt for appending. */
  start() {
    if (this.active) return this.getStatus();

    const root = settingsStore.get('transcriptRoot');
    const now = new Date();

    fs.mkdirSync(root, { recursive: true });
    // Fail loudly here rather than deep inside the writer mid-meeting.
    fs.accessSync(root, fs.constants.W_OK);

    const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    let folder = path.join(root, base);
    let suffix = 2;
    while (fs.existsSync(folder)) {
      folder = path.join(root, `${base}-${suffix++}`);
    }
    fs.mkdirSync(folder, { recursive: true });

    this.folder = folder;
    this.transcriptPath = path.join(folder, 'transcript.txt');
    this.fd = fs.openSync(this.transcriptPath, 'a');
    this.startedAt = now.getTime();
    this.lineCount = 0;
    this.shotCount = 0;
    this.active = true;
    this.pending = [];
    // Screenshots and markers, kept so the final pass can weave them back into
    // a transcript it rebuilds from the audio rather than from transcript.txt.
    this.events = [];

    this._snapshotGlossary();
    this._snapshotCorrections();

    const labelSystem = settingsStore.get('labelSystem');
    const labelMic = settingsStore.get('labelMic');
    this._write(`# Meeting transcript - ${now.toLocaleString()}`);
    this._write(`# ${labelSystem} = system audio | ${labelMic} = microphone`);
    this._write('');

    logger.info('Meeting started', { folder });
    return this.getStatus();
  }

  /** Flush anything buffered and close the file. */
  async stop() {
    if (!this.active) return this.getStatus();

    this._flushPending(true);

    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    this._write('');
    this._write(`# Ended ${new Date().toLocaleString()} (duration ${minutes}m ${seconds}s, ${this.lineCount} lines)`);

    const status = this.getStatus();
    status.durationMs = durationMs;

    // Markers and screenshots outlive the process, so re-running the final pass
    // months later can still weave them back into the rebuilt transcript.
    try {
      fs.writeFileSync(
        path.join(this.folder, 'events.json'),
        JSON.stringify(this.getEvents(), null, 2),
        'utf8'
      );
    } catch (error) {
      logger.warn('Could not write events.json', { error: error.message });
    }

    this._closeFd();
    this.active = false;
    logger.info('Meeting stopped', { folder: this.folder, durationMs, lines: this.lineCount });
    return status;
  }

  /**
   * Queue an utterance. Emits 'line' once it actually reaches the file, so the
   * UI shows lines in the same order the transcript has them.
   */
  appendUtterance(utterance) {
    if (!this.active) return;

    this._enqueue({
      kind: 'utterance',
      streamId: utterance.streamId,
      label: utterance.label,
      text: utterance.text,
      startedAt: utterance.startedAt
    });
  }

  /** Filename for the next screenshot in this meeting. */
  nextScreenshotName(at = new Date()) {
    const index = String(this.shotCount + 1).padStart(2, '0');
    return `shot-${index}_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}.png`;
  }

  /** Write a screenshot PNG into the meeting folder and mark it in the transcript. */
  saveScreenshot(imageBuffer, at = new Date()) {
    if (!this.active) this.start();

    const filename = this.nextScreenshotName(at);
    const target = path.join(this.folder, filename);
    this._withRetry(() => fs.writeFileSync(target, imageBuffer));
    this.shotCount++;

    this._enqueue({ kind: 'screenshot', text: filename, startedAt: at.getTime() });
    return { filename, path: target };
  }

  /** A manual marker the user drops with a hotkey. */
  appendMarker(text = '') {
    if (!this.active) return null;
    const entry = {
      kind: 'marker',
      text: String(text || '').trim(),
      startedAt: Date.now()
    };
    this._enqueue(entry);
    return entry;
  }

  /** Screenshots and markers, in the order they happened. */
  getEvents() {
    return (this.events || []).slice();
  }

  /**
   * Copy the glossary into the meeting folder at the moment recording starts.
   *
   * Two reasons it lives here rather than only in settings: a re-run months
   * later then biases with the vocabulary of *that* meeting, and the file can
   * be edited by hand before re-running the final pass — which is the whole
   * point of having a per-project glossary at all.
   */
  _snapshotGlossary() {
    const glossary = String(settingsStore.get('glossary') || '').trim();
    const header = [
      '# Glossary for this meeting: names, products, file names, jargon.',
      '# One term per line, or several separated by commas.',
      '# Lines starting with "#" are notes and are ignored.',
      '# A line starting with ">" is prose context handed to the model, e.g.',
      '#   > Ein Meeting ueber die Acme-Migration.',
      '# Edit this file and re-run the final pass to re-transcribe with it.',
      ''
    ].join('\r\n');
    try {
      fs.writeFileSync(path.join(this.folder, 'glossary.txt'), header + glossary + '\r\n', 'utf8');
    } catch (error) {
      logger.warn('Could not write glossary.txt', { error: error.message });
    }
  }

  /**
   * Copy the global corrections file next to the glossary, for the same
   * reasons: a later re-run uses what was known then, and the file can be
   * edited by hand first. Without a global file an empty one is written so the
   * format is discoverable.
   */
  _snapshotCorrections() {
    const target = path.join(this.folder, corrections.FILE_NAME);
    try {
      const source = settingsStore.userDataFile(corrections.FILE_NAME);
      if (fs.existsSync(source)) fs.copyFileSync(source, target);
      else fs.writeFileSync(target, '{\r\n}\r\n', 'utf8');
    } catch (error) {
      logger.warn('Could not write corrections.json', { error: error.message });
    }
  }

  _enqueue(entry) {
    if (entry.kind === 'screenshot' || entry.kind === 'marker') {
      if (!this.events) this.events = [];
      this.events.push({ kind: entry.kind, text: entry.text, startedAt: entry.startedAt });
    }

    const reorderMs = Number(settingsStore.get('reorderWindowMs')) || 0;
    if (reorderMs <= 0) {
      // Reordering explicitly disabled: write in completion order.
      this._emitEntry(entry);
      return;
    }

    entry.queuedAt = Date.now();
    this.pending.push(entry);
    this._flushPending(false);
  }

  _scheduleFlush(reorderMs) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flushPending(false);
    }, Math.max(50, reorderMs));
  }

  /**
   * Write everything whose position in the file is already decided.
   *
   * An entry is safe to write once it has sat in the buffer for the reorder
   * window, so a sibling stream that finished a moment later can still slot in
   * ahead of it.
   *
   * Screenshots and markers carry a second condition: no speech that started
   * earlier may still be in the pipeline. They are instantaneous while speech
   * takes seconds to say and more to transcribe, so without this a shot taken
   * at 14:32:05 lands above the sentence that began at 14:32:00. The condition
   * deliberately does not apply to utterances — a caption that waits on the
   * other stream's in-progress sentence is a caption that arrives too late to
   * read. A speech line that lands after its neighbours keeps its true
   * timestamp; only its position jitters.
   *
   * MAX_HOLD_MS is the escape hatch: a wedged worker must never stop the
   * transcript from reaching disk.
   */
  _flushPending(all) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;

    const reorderMs = Number(settingsStore.get('reorderWindowMs')) || 0;
    const now = Date.now();

    let oldestPending = null;
    if (!all && this.pendingProvider) {
      try {
        oldestPending = this.pendingProvider();
      } catch (error) {
        logger.debug('Pending provider failed', { error: error.message });
      }
    }

    const { ready, remaining } = partitionPendingEntries(this.pending, {
      all,
      now,
      reorderMs,
      oldestPending,
      maxHoldMs: MAX_HOLD_MS
    });
    this.pending = remaining;

    for (const entry of ready) this._emitEntry(entry);
    if (this.pending.length > 0) this._scheduleFlush(reorderMs);
  }

  _emitEntry(entry) {
    this._write(this._formatLine(entry));
    this.lineCount++;
    this.emit('line', entry);
  }

  _formatLine(entry) {
    const time = new Date(entry.startedAt);
    const stamp = `[${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}]`;

    if (entry.kind === 'screenshot') return `${stamp} --- screenshot: ${entry.text} ---`;
    if (entry.kind === 'marker') {
      return entry.text ? `${stamp} --- mark: ${entry.text} ---` : `${stamp} --- mark ---`;
    }
    return `${stamp} ${entry.label}: ${entry.text}`;
  }

  _write(line) {
    if (this.fd === null) return;
    this._withRetry(() => {
      // CRLF so the file reads correctly in Notepad.
      fs.writeSync(this.fd, `${line}\r\n`);
      fs.fsyncSync(this.fd);
    });
  }

  /**
   * Documents is very often OneDrive-redirected, where a sync can briefly lock
   * the file and throw EBUSY. One short retry clears it.
   */
  _withRetry(operation) {
    try {
      operation();
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') {
        logger.error('Transcript write failed', { error: error.message, code: error.code });
        this.emit('write-error', error.message);
        return;
      }
      setTimeout(() => {
        try {
          operation();
        } catch (retryError) {
          logger.error('Transcript write failed after retry', { error: retryError.message });
          this.emit('write-error', retryError.message);
        }
      }, 120);
    }
  }

  _closeFd() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch (error) {
      logger.warn('Failed to close transcript file', { error: error.message });
    }
    this.fd = null;
  }

  /** Last-resort flush for app shutdown paths. */
  shutdown() {
    if (!this.active) return;
    try {
      this._flushPending(true);
    } catch (_) { /* ignore */ }
    this._closeFd();
    this.active = false;
  }
}

module.exports = new MeetingService();
