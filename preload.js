const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrap an ipcRenderer listener so callers get a disposer back.
 * Renderers that re-subscribe (the transcript list, the settings panes) would
 * otherwise leak listeners with no way to detach.
 */
function on(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Meeting lifecycle ──
  startMeeting: () => ipcRenderer.invoke('meeting:start'),
  stopMeeting: () => ipcRenderer.invoke('meeting:stop'),
  getMeetingStatus: () => ipcRenderer.invoke('meeting:status'),
  openMeetingFolder: () => ipcRenderer.invoke('meeting:open-folder'),
  takeScreenshot: () => ipcRenderer.invoke('meeting:screenshot'),
  addMarker: (text) => ipcRenderer.invoke('meeting:add-marker', text),

  // ── Audio engine (called from the hidden capture renderer) ──
  sendAudioChunk: (streamId, buffer) => ipcRenderer.send('audio-chunk', { streamId, buffer }),
  sendAudioLevel: (streamId, rms) => ipcRenderer.send('audio-level', { streamId, rms }),
  reportAudioError: (streamId, name, message) =>
    ipcRenderer.send('audio-error', { streamId, name, message }),
  reportAudioStarted: (info) => ipcRenderer.send('audio-started', info),
  reportAudioStopped: (streamId) => ipcRenderer.send('audio-stopped', { streamId }),
  listAudioDevices: () => ipcRenderer.invoke('audio:list-devices'),
  setAudioDevices: (devices) => ipcRenderer.send('audio:devices-enumerated', devices),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  pickPython: () => ipcRenderer.invoke('settings:pick-python'),
  showSettings: () => ipcRenderer.invoke('show-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),

  // ── Whisper setup ──
  getWhisperStatus: () => ipcRenderer.invoke('whisper:status'),
  installWhisper: (options) => ipcRenderer.invoke('whisper:install', options),

  // ── Windows ──
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  moveBoundWindows: (deltaX, deltaY) => ipcRenderer.invoke('move-bound-windows', { deltaX, deltaY }),
  toggleTranscript: () => ipcRenderer.invoke('window:toggle-transcript'),
  toggleInteraction: () => ipcRenderer.invoke('window:toggle-interaction'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),
  setWindowGap: (gap) => ipcRenderer.invoke('set-window-gap', gap),
  resizeTranscriptForContent: (metrics) => ipcRenderer.invoke('resize-transcript-window', metrics),

  // ── App ──
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // ── Events (each returns a disposer) ──
  onTranscriptLine: (cb) => on('transcript-line', cb),
  onMeetingStarted: (cb) => on('meeting-started', cb),
  onMeetingStopped: (cb) => on('meeting-stopped', cb),
  onRecordingState: (cb) => on('recording-state', cb),
  onTranscriptionStatus: (cb) => on('transcription-status', cb),
  onTranscriptionError: (cb) => on('transcription-error', cb),
  onAudioLevel: (cb) => on('audio-level', cb),
  onAudioStartRequest: (cb) => on('audio-start-request', cb),
  onAudioStopRequest: (cb) => on('audio-stop-request', cb),
  onInteractionModeChanged: (cb) => on('interaction-mode-changed', cb),
  onLoadSettings: (cb) => on('load-settings', cb),
  onSettingsWindowShown: (cb) => on('settings-window-shown', cb),
  onInstallProgress: (cb) => on('install-progress', cb),
  onMainWindowShown: (cb) => on('main-window-shown', cb),

  notifyMainWindowReady: () => ipcRenderer.send('main-window-ready')
});
