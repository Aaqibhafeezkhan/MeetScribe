const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');
const { spawn } = require('child_process');

const settingsStore = require('../core/settings.store');
const audioArchive = require('./audio-archive.service');
const corrections = require('./corrections');
const logger = require('../core/logger').createServiceLogger('FINAL-PASS');

// Nothing on stdout for this long means the child is wedged, not slow: it
// reports progress every ~2% of every stream.
const STALL_TIMEOUT_MS = 20 * 60 * 1000;

// Consecutive segments from one speaker closer than this become one paragraph.
const BLOCK_GAP_MS = 8000;
// A new "## HH:MM" heading is emitted once the clock has moved on this far.
const CHAPTER_INTERVAL_MS = 5 * 60 * 1000;
// Echo detection reuses the live rules, with a wider window: offline there is
// no race between the two pipelines, so the comparison can be generous.
const ECHO_WINDOW_MS = 6000;
const MIN_ECHO_TOKENS = 4;
// How many uncertain spans to list in the index at the end of the transcript.
const UNCERTAIN_INDEX_LIMIT = 40;
// Longest disagreement worth marking inline. Two models that split a sentence
// differently produce one enormous "replace" run that buries the readable text
// inside markup without locating anything. A genuine mishearing is a word or
// two; beyond that the run is misalignment, not signal.
const MAX_DIFF_RUN_WORDS = 4;

const pad = (value) => String(value).padStart(2, '0');
const clockOf = (ms) => {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
};
const hhmmOf = (ms) => {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
};

/**
 * The meeting's second pass.
 *
 * Runs after the recording stops, over the continuous audio the archive kept,
 * and produces the transcript that is actually worth handing to an LLM (or
 * reading): both streams decoded with context and a glossary, merged back into
 * one speaker-labeled timeline, with the model's own uncertainty marked inline.
 *
 * Emits:
 *   'progress' { state, pct, message }
 *   'done'     { folder, markdownPath, jsonPath }
 *   'failed'   { folder, error }
 */
class OfflinePassService extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.child = null;
    this.currentFolder = null;
  }

  isRunning() {
    return this.running;
  }

  getStatus() {
    return { running: this.running, folder: this.currentFolder };
  }

  cancel() {
    if (this.child) {
      try { this.child.kill(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * @param {object} options
   * @param {string} options.folder    the meeting folder
   * @param {object} options.meta      audio/meta.json (streams, start times)
   * @param {array}  options.events    screenshots and markers from the meeting
   * @param {object} options.paths     { python, script, modelDir, env }
   */
  async run({ folder, meta, events = [], paths }) {
    if (this.running) throw new Error('A final pass is already running');
    if (!meta || !Array.isArray(meta.streams) || meta.streams.length === 0) {
      throw new Error('This meeting has no archived audio to re-transcribe');
    }
    if (!paths.python || !fs.existsSync(paths.python)) {
      throw new Error('The Whisper Python environment was not found');
    }
    if (!fs.existsSync(paths.script)) {
      throw new Error('whisper_offline.py was not found');
    }

    this.running = true;
    this.currentFolder = folder;
    const settings = settingsStore.all();
    const glossary = this._loadGlossary(folder, settings);
    const matcher = corrections.buildMatcher(
      corrections.loadRules(folder, settingsStore.userDataFile(corrections.FILE_NAME))
    );

    // Streams are transcribed one after the other, so the work is their sum.
    const audioMs = meta.streams.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0);
    // The streams run in parallel during the meeting, so its length is the longest.
    const meetingMs = meta.streams.reduce((max, entry) => Math.max(max, Number(entry.durationMs) || 0), 0);
    const passStartedAt = Date.now();
    const timing = () => {
      const elapsedMs = Date.now() - passStartedAt;
      return {
        model: settings.offlineModel || 'large-v3-turbo',
        audioMs,
        meetingMs,
        elapsedMs,
        // Pass time over meeting length: 0.25 means a 1 h meeting took 15 min.
        realtimeFactor: meetingMs ? Number((elapsedMs / meetingMs).toFixed(2)) : undefined
      };
    };

    try {
      this._progress('starting', 0, 'Loading the transcription model…');
      const result = await this._spawnPass({ folder, meta, paths, settings, glossary });
      this._progress('merging', 0.97, 'Merging speakers and writing the transcript…');

      const written = this._render({ folder, meta, result, events, settings, glossary, matcher });
      this._progress('done', 1, 'Final transcript ready');
      this.emit('done', { folder, ...written });
      logger.info('Final pass complete', { folder, markdown: written.markdownPath, ...timing() });
      return { ok: true, folder, ...written };
    } catch (error) {
      logger.error('Final pass failed', { folder, error: error.message, ...timing() });
      this.emit('failed', { folder, error: error.message });
      return { ok: false, folder, error: error.message };
    } finally {
      this.running = false;
      this.child = null;
      this.currentFolder = null;
    }
  }

  // ── Running the Python side ──

  _spawnPass({ folder, meta, paths, settings, glossary }) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetscribe-final-'));
    const jobPath = path.join(workDir, 'job.json');
    const outPath = path.join(workDir, 'result.json');

    // Repair anything an older build (or a crash) left malformed before handing
    // it to FFmpeg, which reacts to a bad header by dying rather than complaining.
    for (const entry of meta.streams) {
      if (/\.wav$/i.test(entry.path) && fs.existsSync(entry.path)) {
        audioArchive.repairWav(entry.path);
      }
    }

    const job = {
      audio: meta.streams.map((entry) => ({
        stream: entry.stream,
        label: entry.label,
        path: entry.path,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs
      })),
      output: outPath,
      model: settings.offlineModel || 'large-v3-turbo',
      diff_model: settings.offlineDiffModel || '',
      model_dir: paths.modelDir,
      device: settings.offlineDevice || settings.whisperDevice || 'auto',
      compute_type: settings.offlineComputeType || 'auto',
      cpu_threads: Number(settings.offlineCpuThreads) || 0,
      language: settings.whisperLanguage || 'auto',
      beam_size: Number(settings.offlineBeamSize) || 5,
      hotwords: glossary.hotwords,
      initial_prompt: glossary.contextPrompt,
      word_timestamps: true
    };

    fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8');

    // Two streams, and each may run twice when a diff model is configured.
    const totalPasses = meta.streams.length * (job.diff_model ? 2 : 1);
    const passProgress = new Map();

    return new Promise((resolve, reject) => {
      const child = spawn(paths.python, ['-u', paths.script, jobPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: paths.env
      });
      this.child = child;

      let settled = false;
      let failure = null;
      let stall = null;

      const resetStall = () => {
        if (stall) clearTimeout(stall);
        stall = setTimeout(() => {
          logger.error('Final pass stalled; killing the worker');
          try { child.kill(); } catch (_) { /* ignore */ }
        }, STALL_TIMEOUT_MS);
      };
      resetStall();

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        resetStall();
        let message;
        try {
          message = JSON.parse(line);
        } catch (_) {
          return;
        }

        if (message.event === 'loaded') {
          logger.info('Final pass model loaded', { model: message.model, device: message.device });
          this._progress('transcribing', 0.02, 'Transcribing with ' + message.model + ' on ' + message.device + '…');
        } else if (message.event === 'progress') {
          passProgress.set(message.stream + ':' + message.pass, message.pct);
          let sum = 0;
          for (const value of passProgress.values()) sum += value;
          // Cap at 0.95: the merge and the write still have to happen.
          const pct = Math.min(0.95, 0.02 + (sum / totalPasses) * 0.93);
          this._progress('transcribing', pct, 'Transcribing… ' + Math.round(pct * 100) + '%');
        } else if (message.event === 'error') {
          failure = new Error(message.error || 'The final pass failed');
          if (message.traceback) logger.error('Final pass traceback', { traceback: message.traceback.slice(-2000) });
        }
      });

      // Keep the tail of stderr. A Python crash (FFmpeg segfaulting on a bad
      // audio header, a missing CUDA DLL) produces nothing on stdout and only
      // a bare exit code, which is not something anyone can act on. The last
      // few lines are usually the whole diagnosis.
      const stderrTail = [];
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (!text) return;
        logger.debug('Final pass stderr', { message: text.substring(0, 1000) });
        stderrTail.push(text);
        while (stderrTail.length > 8) stderrTail.shift();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (stall) clearTimeout(stall);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (stall) clearTimeout(stall);

        if (failure) return reject(failure);
        if (code !== 0) {
          const detail = stderrTail.join(' | ').substring(0, 600);
          // 0xC0000005 on Windows, SIGSEGV elsewhere: the interpreter died
          // rather than raised, so there is no traceback to report.
          const crashed = code === 3221225477 || code === 139 || code === null;
          const reason = crashed
            ? 'the transcription process crashed (this usually means an unreadable audio file)'
            : 'the transcription process exited with code ' + code;
          logger.error('Final pass worker died', { code, stderr: detail });
          return reject(new Error(reason + (detail ? ' — ' + detail : '')));
        }

        try {
          const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
          resolve(parsed);
        } catch (error) {
          reject(new Error('Could not read the final pass output: ' + error.message));
        } finally {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        }
      });
    });
  }

  // ── Glossary ──

  /**
   * The glossary is snapshotted into the meeting folder at recording start, so
   * a re-run months later biases with the vocabulary of *that* meeting — and so
   * it can be edited by hand before re-running, which is the whole workflow.
   */
  _loadGlossary(folder, settings) {
    let raw = '';
    const file = path.join(folder, 'glossary.txt');
    try {
      if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      logger.warn('Could not read glossary.txt', { error: error.message });
    }
    if (!raw.trim()) raw = String(settings.glossary || '');

    const terms = [];
    let contextPrompt = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // "#" is a note for whoever edits the file and never reaches the model —
      // including the instructions this file is created with. ">" is prose
      // context that does reach it, as initial_prompt.
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('>')) {
        contextPrompt += (contextPrompt ? ' ' : '') + trimmed.replace(/^>+\s*/, '');
        continue;
      }
      for (const term of trimmed.split(',')) {
        const clean = term.trim();
        if (clean) terms.push(clean);
      }
    }

    // faster-whisper truncates an over-long hotword list at half the context
    // window; keeping it short also keeps it from behaving like invented speech.
    const capped = terms.slice(0, 120);
    return {
      terms: capped,
      hotwords: capped.join(', '),
      contextPrompt: contextPrompt.trim()
    };
  }

  // ── Merge and render ──

  _render({ folder, meta, result, events, settings, glossary, matcher }) {
    const threshold = Number(settings.offlineWordConfidence) || 0.5;
    const diffByStream = new Map();
    for (const stream of result.diffStreams || []) diffByStream.set(stream.stream, stream);

    // 1. Flatten every segment of every stream onto one absolute timeline.
    let entries = [];
    for (const stream of result.streams) {
      const base = Number(stream.startedAt) || meta.startedAt;
      const diffStream = diffByStream.get(stream.stream);
      for (const segment of stream.segments) {
        if (!segment.text) continue;
        const startedAt = base + Math.round(segment.start * 1000);
        const endedAt = base + Math.round(segment.end * 1000);
        entries.push({
          kind: 'speech',
          streamId: stream.stream,
          label: stream.label,
          startedAt,
          endedAt,
          text: segment.text,
          avgLogprob: segment.avg_logprob,
          words: segment.words || [],
          diffWords: diffStream ? this._diffWordsInRange(diffStream, segment.start, segment.end) : []
        });
      }
    }

    // 2. Drop mic lines that are just the meeting audio coming back in.
    if (settings.echoSuppress) entries = this._suppressEcho(entries, settings);

    // 3. Weave in screenshots and markers, then order everything by when it happened.
    for (const event of events || []) {
      entries.push({
        kind: event.kind,
        startedAt: event.startedAt,
        endedAt: event.startedAt,
        text: event.text || ''
      });
    }
    entries.sort((a, b) => a.startedAt - b.startedAt);

    // 4. Render each line, collecting the uncertain spans as we go.
    const uncertain = [];
    const fixCounts = new Map();
    for (const entry of entries) {
      if (entry.kind !== 'speech') continue;
      // Known mistakes are fixed last, on the rendered text, so the confidence
      // and disagreement markup is already in place and the fix is marked on top.
      const fixed = corrections.applyCorrections(this._renderSpeech(entry, threshold, uncertain), matcher, fixCounts);
      entry.rendered = fixed.text;
    }
    const appliedFixes = Array.from(fixCounts, ([heard, count]) => ({ heard, correct: matcher.byKey.get(heard), count }));

    const markdown = this._buildMarkdown({
      meta, result, entries, settings, glossary, uncertain, threshold, appliedFixes, hasCorrections: Boolean(matcher)
    });
    const markdownPath = path.join(folder, 'transcript.final.md');
    fs.writeFileSync(markdownPath, markdown, 'utf8');

    const jsonPath = path.join(folder, 'transcript.final.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      version: 1,
      meeting: {
        folder,
        startedAt: meta.startedAt,
        stoppedAt: meta.stoppedAt
      },
      asr: {
        model: result.model,
        diffModel: result.diffModel,
        device: result.device,
        computeType: result.computeType,
        beamSize: result.beamSize,
        language: result.language,
        glossary: glossary.terms
      },
      entries: entries.map((entry) => ({
        kind: entry.kind,
        label: entry.label,
        streamId: entry.streamId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        clock: clockOf(entry.startedAt),
        text: entry.kind === 'speech' ? entry.text : entry.text,
        marked: entry.rendered || null,
        avgLogprob: entry.avgLogprob,
        words: entry.words
      })),
      corrections: appliedFixes,
      uncertain
    }, null, 2), 'utf8');

    return { markdownPath, jsonPath, lines: entries.length, uncertain: uncertain.length };
  }

  /**
   * Offline echo suppression. Same containment metric as the live path, but
   * without the grace-period race: every system line is already known, so a mic
   * line can be compared against all of them at once.
   */
  _suppressEcho(entries, settings) {
    const threshold = Number(settings.echoSimilarity) || 0.8;
    const systemLines = entries
      .filter((entry) => entry.streamId === 'system')
      .map((entry) => ({ startedAt: entry.startedAt, tokens: this._tokenize(entry.text) }));

    return entries.filter((entry) => {
      if (entry.streamId !== 'mic') return true;
      const tokens = this._tokenize(entry.text);
      if (tokens.size < MIN_ECHO_TOKENS) return true;
      for (const line of systemLines) {
        if (line.tokens.size < MIN_ECHO_TOKENS) continue;
        if (Math.abs(line.startedAt - entry.startedAt) > ECHO_WINDOW_MS) continue;
        if (this._containment(tokens, line.tokens) >= threshold) return false;
      }
      return true;
    });
  }

  _tokenize(text) {
    return new Set(
      String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
    );
  }

  _containment(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    return intersection / Math.min(a.size, b.size);
  }

  /** Words the second model produced inside one primary segment's time range. */
  _diffWordsInRange(diffStream, start, end) {
    const words = [];
    for (const segment of diffStream.segments) {
      if (segment.end < start - 0.5 || segment.start > end + 0.5) continue;
      for (const word of segment.words || []) {
        if (word.end >= start - 0.25 && word.start <= end + 0.25) words.push(word);
      }
    }
    return words;
  }

  /**
   * Turn one segment into marked-up text.
   *
   *   ~wort~     the model itself was unsure of this word
   *   <a|b>      the two models read this span differently
   *
   * Both exist for the same reason: an LLM cleaning this up afterwards should
   * know where to concentrate. Uniform text invites uniform suspicion, which is
   * how correct terminology gets "fixed" into something wrong.
   */
  _renderSpeech(entry, threshold, uncertain) {
    const words = entry.words || [];
    if (words.length === 0) return entry.text;

    // Whisper emits each word with its own leading space, or without one where
    // it belongs to the previous token. That distinction is the difference
    // between "Acme-Datei" and "Acme -Datei", so it has to survive
    // the round trip through the markup.
    const primary = words
      .map((word) => ({ ...word, clean: word.word.trim(), space: /^\s/.test(word.word) }))
      .filter((word) => word.clean);
    if (primary.length === 0) return entry.text;

    let pieces;
    if (entry.diffWords && entry.diffWords.length > 0) {
      const secondary = entry.diffWords
        .map((word) => ({ clean: word.word.trim(), space: /^\s/.test(word.word) }))
        .filter((word) => word.clean);
      pieces = this._applyDiff(primary, secondary, threshold, entry, uncertain);
    } else {
      pieces = primary.map((word) => this._markWord(word, threshold, entry, uncertain));
    }

    return this._joinPieces(pieces);
  }

  _joinPieces(pieces) {
    let out = '';
    for (const piece of pieces) {
      if (out && piece.space) out += ' ';
      out += piece.text;
    }
    return out.trim();
  }

  _markWord(word, threshold, entry, uncertain) {
    if (word.probability >= threshold) return { text: word.clean, space: word.space };
    uncertain.push({
      kind: 'low-confidence',
      at: clockOf(entry.startedAt + Math.round((word.start - (entry.words[0] || word).start) * 1000)),
      startedAt: entry.startedAt,
      label: entry.label,
      word: word.clean,
      probability: word.probability,
      context: entry.text
    });
    return { text: '~' + word.clean + '~', space: word.space };
  }

  /**
   * Word-level LCS diff between the two models, run per segment rather than
   * over the whole meeting: a segment is ~30 words, so the quadratic table
   * stays tiny, and time already anchors the two sequences to each other.
   */
  _applyDiff(primary, secondaryWords, threshold, entry, uncertain) {
    const norm = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const a = primary.map((word) => norm(word.clean));
    const b = secondaryWords.map((word) => norm(word.clean));

    const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    const pieces = [];
    let i = 0;
    let j = 0;
    let pendingA = [];
    let pendingB = [];

    const flush = () => {
      if (pendingA.length === 0 && pendingB.length === 0) return;
      const tooLong = pendingA.length > MAX_DIFF_RUN_WORDS || pendingB.length > MAX_DIFF_RUN_WORDS;
      const left = this._joinPieces(pendingA.map((word) => ({ text: word.clean, space: word.space })));
      const right = this._joinPieces(pendingB.map((word) => ({ text: word.clean, space: word.space })));
      if (left && right && !tooLong && norm(left) !== norm(right)) {
        pieces.push({ text: '<' + left + '|' + right + '>', space: pendingA[0] ? pendingA[0].space : true });
        uncertain.push({
          kind: 'model-disagreement',
          at: clockOf(entry.startedAt),
          startedAt: entry.startedAt,
          label: entry.label,
          primary: left,
          secondary: right,
          context: entry.text
        });
      } else if (left) {
        for (const word of pendingA) pieces.push(this._markWord(word, threshold, entry, uncertain));
      }
      pendingA = [];
      pendingB = [];
    };

    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        flush();
        pieces.push(this._markWord(primary[i], threshold, entry, uncertain));
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        pendingA.push(primary[i++]);
      } else {
        pendingB.push(secondaryWords[j++]);
      }
    }
    while (i < a.length) pendingA.push(primary[i++]);
    while (j < b.length) pendingB.push(secondaryWords[j++]);
    flush();

    return pieces;
  }

  _buildMarkdown({ meta, result, entries, settings, glossary, uncertain, threshold, appliedFixes, hasCorrections }) {
    const started = new Date(meta.startedAt);
    const stopped = new Date(meta.stoppedAt || meta.startedAt);
    const out = [];

    out.push('# Meeting ' + started.toLocaleDateString() + ' · ' + hhmmOf(meta.startedAt) + '–' + hhmmOf(stopped.getTime()));
    out.push('');
    const speakers = meta.streams
      .map((entry) => entry.label + ' (' + (entry.stream === 'mic' ? 'microphone' : 'system audio') + ')')
      .join(' · ');
    out.push('- **Speakers:** ' + speakers);
    out.push('- **ASR:** ' + result.model + ' · beam ' + result.beamSize + ' · ' +
      (result.language || 'auto') + ' · ' + result.device + '/' + result.computeType);
    if (result.diffModel) out.push('- **Cross-checked against:** ' + result.diffModel);
    if (glossary.terms.length > 0) out.push('- **Glossary:** ' + glossary.terms.join(', '));
    if (glossary.contextPrompt) out.push('- **Context given to the model:** ' + glossary.contextPrompt);
    out.push('- **Markup:** `~wort~` = the model was unsure (p < ' + threshold + ')' +
      (result.diffModel ? ' · `<a|b>` = the two models disagreed' : '') +
      (hasCorrections ? ' · `{wort}` = replaced from the corrections list' : ''));
    if (appliedFixes.length > 0) {
      out.push('- **Corrections applied:** ' +
        appliedFixes.map((fix) => fix.heard + ' → ' + fix.correct + ' (' + fix.count + '×)').join(', '));
    }
    out.push('');
    out.push('> Produced by the final pass over the archived audio, with context across the whole');
    out.push('> meeting and a glossary. The live `transcript.txt` in this folder is the low-latency');
    out.push('> preview and will differ — where the two disagree, this file is the better one.');
    out.push('');
    out.push('---');
    out.push('');

    let lastChapter = 0;
    let lastLabel = null;
    let lastEndedAt = 0;
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      out.push('**' + lastLabel + ':** ' + paragraph.join(' '));
      out.push('');
      paragraph = [];
    };

    for (const entry of entries) {
      if (entry.startedAt - lastChapter >= CHAPTER_INTERVAL_MS) {
        flushParagraph();
        lastLabel = null;
        lastChapter = entry.startedAt;
        out.push('## ' + hhmmOf(entry.startedAt));
        out.push('');
      }

      if (entry.kind === 'screenshot') {
        flushParagraph();
        lastLabel = null;
        out.push('*[' + clockOf(entry.startedAt) + '] screenshot: `' + entry.text + '`*');
        out.push('');
        continue;
      }
      if (entry.kind === 'marker') {
        flushParagraph();
        lastLabel = null;
        out.push('*[' + clockOf(entry.startedAt) + '] mark' + (entry.text ? ': ' + entry.text : '') + '*');
        out.push('');
        continue;
      }

      const sameSpeaker = entry.label === lastLabel;
      const closeEnough = entry.startedAt - lastEndedAt <= BLOCK_GAP_MS;
      if (!sameSpeaker || !closeEnough) {
        flushParagraph();
        lastLabel = entry.label;
      }
      paragraph.push(entry.rendered);
      lastEndedAt = entry.endedAt;
    }
    flushParagraph();

    if (uncertain.length > 0) {
      out.push('---');
      out.push('');
      out.push('## Uncertain spans');
      out.push('');
      out.push('The ' + Math.min(uncertain.length, UNCERTAIN_INDEX_LIMIT) + ' least confident places in this transcript, worst first.');
      out.push('Start here when correcting; the rest of the text is comparatively safe.');
      out.push('');
      out.push('| Time | Speaker | Read as | Alternative / confidence |');
      out.push('|---|---|---|---|');

      const ranked = uncertain
        .slice()
        .sort((a, b) => {
          const scoreA = a.kind === 'model-disagreement' ? -1 : a.probability;
          const scoreB = b.kind === 'model-disagreement' ? -1 : b.probability;
          return scoreA - scoreB;
        })
        .slice(0, UNCERTAIN_INDEX_LIMIT);

      for (const item of ranked) {
        const escape = (value) => String(value || '').replace(/\|/g, '\\|');
        if (item.kind === 'model-disagreement') {
          out.push('| ' + item.at + ' | ' + escape(item.label) + ' | ' + escape(item.primary) +
            ' | second model heard "' + escape(item.secondary) + '" |');
        } else {
          out.push('| ' + item.at + ' | ' + escape(item.label) + ' | ' + escape(item.word) +
            ' | p = ' + item.probability.toFixed(2) + ' |');
        }
      }
      out.push('');
    }

    return out.join('\r\n');
  }

  _progress(state, pct, message) {
    this.emit('progress', { state, pct, message });
  }
}

module.exports = new OfflinePassService();
