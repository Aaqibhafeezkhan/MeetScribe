/**
 * Live transcript panel.
 *
 * Renders lines pushed from the main process (which only sends them once they
 * are on disk, so what you see matches transcript.txt exactly).
 */

// Older rows leave the DOM to keep long meetings responsive. They are never
// removed from the file — that is what the folder button is for.
const MAX_ROWS = 500;

const pad = (n) => String(n).padStart(2, '0');

class TranscriptWindow {
  constructor() {
    this.list = document.getElementById('list');
    this.empty = document.getElementById('empty');
    this.recDot = document.getElementById('recDot');
    this.elapsed = document.getElementById('elapsed');
    this.jumpBtn = document.getElementById('jumpBtn');
    this.toast = document.getElementById('toast');
    this.recordBtn = document.getElementById('recordBtn');
    this.meters = {
      system: document.getElementById('meterSystem'),
      mic: document.getElementById('meterMic')
    };

    this.recording = false;
    this.startedAt = null;
    this.timer = null;
    this.stickToBottom = true;
    this.toastTimer = null;

    this.bindUI();
    this.bindEvents();
    this.refresh();
  }

  bindUI() {
    this.recordBtn.addEventListener('click', () => this.toggleRecording());
    document.getElementById('shotBtn').addEventListener('click', () => {
      window.electronAPI.takeScreenshot();
    });
    document.getElementById('folderBtn').addEventListener('click', () => {
      window.electronAPI.openMeetingFolder();
    });
    document.getElementById('settingsBtn').addEventListener('click', () => {
      window.electronAPI.showSettings();
    });
    document.getElementById('closeBtn').addEventListener('click', () => {
      window.electronAPI.toggleTranscript();
    });
    this.jumpBtn.addEventListener('click', () => this.scrollToBottom());

    // Auto-scroll follows the newest line, but stops the moment the user
    // scrolls up to read something — then offers a way back.
    this.list.addEventListener('scroll', () => {
      const distanceFromBottom =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
      this.stickToBottom = distanceFromBottom < 40;
      this.jumpBtn.classList.toggle('show', !this.stickToBottom);
    });
  }

  bindEvents() {
    window.electronAPI.onTranscriptLine((entry) => this.addLine(entry));

    window.electronAPI.onMeetingStarted((status) => {
      this.startedAt = status.startedAt;
      this.setRecording(true);
      this.clear();
    });

    window.electronAPI.onMeetingStopped(() => {
      this.setRecording(false);
    });

    window.electronAPI.onRecordingState(({ recording }) => {
      this.setRecording(recording);
    });

    window.electronAPI.onAudioLevel(({ streamId, rms }) => {
      const meter = this.meters[streamId];
      if (!meter) return;
      // Speech RMS sits well below 1.0; scale so normal speech fills the bar.
      const percent = Math.min(100, Math.round(Math.sqrt(rms) * 180));
      meter.style.width = `${percent}%`;
    });

    window.electronAPI.onTranscriptionError(({ message }) => this.showToast(message));

    window.electronAPI.onLoadSettings((settings) => this.applySettings(settings));
  }

  async refresh() {
    try {
      const [status, settings] = await Promise.all([
        window.electronAPI.getMeetingStatus(),
        window.electronAPI.getSettings()
      ]);
      this.applySettings(settings);
      if (status.active) {
        this.startedAt = status.startedAt;
        this.setRecording(!!status.recording);
      }
    } catch (_) {
      /* main process not ready yet; events will catch us up */
    }
  }

  applySettings(settings) {
    if (!settings) return;
    document.getElementById('labelThem').textContent = settings.labelSystem || 'Them';
    document.getElementById('labelYou').textContent = settings.labelMic || 'You';
    if (settings.transcriptFontSize) {
      document.documentElement.style.setProperty('--font-size', `${settings.transcriptFontSize}px`);
    }
    const hint = document.getElementById('emptyHint');
    if (hint && settings.transcriptRoot) {
      hint.textContent = `Saving to ${settings.transcriptRoot}`;
    }
  }

  toggleRecording() {
    if (this.recording) {
      window.electronAPI.stopMeeting();
    } else {
      window.electronAPI.startMeeting();
    }
  }

  setRecording(recording) {
    this.recording = recording;
    this.recDot.classList.toggle('live', recording);
    this.recordBtn.textContent = recording ? 'Stop' : 'Record';

    if (recording) {
      if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.timer = null;
      Object.values(this.meters).forEach((meter) => { meter.style.width = '0%'; });
    }
  }

  tick() {
    if (!this.startedAt) return;
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const hours = Math.floor(seconds / 3600);
    const rest = seconds % 3600;
    this.elapsed.textContent = hours > 0
      ? `${hours}:${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`
      : `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`;
  }

  clear() {
    this.list.querySelectorAll('.row').forEach((row) => row.remove());
    if (this.empty) this.empty.style.display = '';
  }

  addLine(entry) {
    if (this.empty) this.empty.style.display = 'none';

    const row = document.createElement('div');
    row.className = entry.kind === 'utterance' ? 'row' : 'row meta';

    const time = new Date(entry.startedAt);
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
    row.appendChild(ts);

    if (entry.kind === 'utterance') {
      const who = document.createElement('span');
      who.className = `who ${entry.streamId}`;
      who.textContent = entry.label;
      row.appendChild(who);
    }

    const text = document.createElement('span');
    text.className = 'txt';
    // Always textContent: transcripts are model output, never markup.
    if (entry.kind === 'screenshot') {
      text.textContent = `screenshot: ${entry.text}`;
    } else if (entry.kind === 'marker') {
      text.textContent = entry.text ? `mark: ${entry.text}` : 'mark';
    } else {
      text.textContent = entry.text;
    }
    row.appendChild(text);

    this.list.appendChild(row);

    const rows = this.list.querySelectorAll('.row');
    if (rows.length > MAX_ROWS) rows[0].remove();

    if (this.stickToBottom) this.scrollToBottom();
  }

  scrollToBottom() {
    this.list.scrollTop = this.list.scrollHeight;
    this.stickToBottom = true;
    this.jumpBtn.classList.remove('show');
  }

  showToast(message) {
    this.toast.textContent = message;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 8000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.transcriptWindow = new TranscriptWindow();
});
