/**
 * The overlay command pill.
 *
 * Deliberately thin: it starts/stops recording and opens the other surfaces.
 * Audio capture lives in the hidden audio-engine window so that hiding this
 * overlay (Ctrl+Shift+V) cannot disturb a recording.
 */

const pad = (n) => String(n).padStart(2, '0');

class MainWindowUI {
  constructor() {
    this.dot = document.getElementById('dot');
    this.recordLabel = document.getElementById('recordLabel');
    this.elapsed = document.getElementById('elapsed');
    this.status = document.getElementById('status');
    this.warn = document.getElementById('warn');

    this.recording = false;
    this.startedAt = null;
    this.timer = null;

    this.bindUI();
    this.bindEvents();
    this.resizeToContent();

    window.electronAPI.notifyMainWindowReady();
    this.refresh();
  }

  bindUI() {
    document.getElementById('recordBtn').addEventListener('click', () => this.toggleRecording());
    document.getElementById('shotBtn').addEventListener('click', () => window.electronAPI.takeScreenshot());
    document.getElementById('transcriptBtn').addEventListener('click', () => window.electronAPI.toggleTranscript());
    document.getElementById('folderBtn').addEventListener('click', () => window.electronAPI.openMeetingFolder());
    document.getElementById('settingsBtn').addEventListener('click', () => window.electronAPI.showSettings());
    this.status.addEventListener('click', () => window.electronAPI.toggleInteraction());
    this.warn.addEventListener('click', () => window.electronAPI.showSettings());
  }

  bindEvents() {
    window.electronAPI.onMeetingStarted((status) => {
      this.startedAt = status.startedAt;
      this.setRecording(true);
      this.setWarning('');
    });

    window.electronAPI.onMeetingStopped(() => this.setRecording(false));
    window.electronAPI.onRecordingState(({ recording }) => this.setRecording(recording));

    window.electronAPI.onInteractionModeChanged((interactive) => {
      this.status.classList.toggle('passthrough', !interactive);
      this.status.title = interactive
        ? 'Interactive — click to enable click-through (Alt+A)'
        : 'Click-through — click to make interactive (Alt+A)';
    });

    window.electronAPI.onTranscriptionError(({ message }) => this.setWarning(message));

    window.electronAPI.onTranscriptionStatus((status) => {
      if (status && status.available === false) {
        this.setWarning('Whisper not set up — open Settings');
      } else if (status && status.available) {
        this.setWarning('');
      }
    });
  }

  async refresh() {
    try {
      const status = await window.electronAPI.getMeetingStatus();
      if (status.active) {
        this.startedAt = status.startedAt;
        this.setRecording(!!status.recording);
      }
      const whisper = await window.electronAPI.getWhisperStatus();
      if (whisper && !whisper.configured) {
        this.setWarning('Whisper not set up — open Settings');
      }
    } catch (_) {
      /* main process still starting */
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
    this.dot.classList.toggle('live', recording);
    this.recordLabel.textContent = recording ? 'Stop' : 'Record';

    if (recording) {
      if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resizeToContent();
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

  setWarning(message) {
    this.warn.textContent = message || '';
    this.warn.classList.toggle('show', !!message);
    this.resizeToContent();
  }

  /**
   * The window is frameless and transparent, so any window area larger than
   * the pill shows up as an invisible click-blocking rectangle. Keep the
   * window exactly the size of the DOM.
   */
  resizeToContent() {
    requestAnimationFrame(() => {
      const bar = document.getElementById('bar');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      window.electronAPI.resizeWindow(Math.ceil(rect.width) + 2, Math.ceil(rect.height) + 2);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.mainWindowUI = new MainWindowUI();
});
