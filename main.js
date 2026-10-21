const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const {
  app,
  BrowserWindow,
  globalShortcut,
  session,
  ipcMain,
  desktopCapturer,
  dialog,
  shell,
  clipboard,
} = require("electron");

// ── Pin userData before anything reads it ──
// The disguise feature calls app.setName("Terminal ") to hide the app in Task
// Manager, and Electron derives userData from the app name. Without pinning,
// the settings file, the Whisper venv and the model cache would all move every
// time the user picks a different disguise. Must run before the first
// getPath('userData') and before setName().
try {
  app.setPath("userData", path.join(app.getPath("appData"), "MeetScribe"));
} catch (_) {
  /* falls back to Electron's default */
}

// Keep Chromium network noise out of the terminal; app logs go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const settingsStore = require("./src/core/settings.store");

// ── Global crash guard ──
// The transcription path spawns an external Python process. A spawn failure
// must degrade to a status message, never take the whole app down mid-meeting.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

const captureService = require("./src/services/capture.service");
const transcriptionService = require("./src/services/transcription.service");
const meetingService = require("./src/services/meeting.service");
const audioArchive = require("./src/services/audio-archive.service");
const offlinePass = require("./src/services/offline-pass.service");
const windowManager = require("./src/managers/window.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.appIcon = "terminal";
    this.audioDevices = { inputs: [] };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Default disguise: look like a terminal in the task list.
    if (app && typeof app.setName === "function") {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (process.platform === "darwin" && config.get("stealth.noAttachConsole")) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }
        if (this.isReady) windowManager.showAllWindows();
      } catch (error) {
        logger.error("Failed to focus existing instance", { error: error.message });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) return;
    this.starting = true;

    app.setName("Terminal ");
    process.title = "Terminal ";

    settingsStore.load();
    this.appIcon = settingsStore.get("appIcon") || "terminal";

    logger.info("Application starting", {
      version: config.get("app.version"),
      platform: process.platform,
      userData: app.getPath("userData"),
    });

    try {
      this.setupPermissions();
      this.setupDisplayMediaHandler();

      // Small delay so desktop/display detection is accurate.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await windowManager.initializeWindows({ showMainWindow: true });
      windowManager.setWindowGap(Number(settingsStore.get("windowGap")) || 10);
      this.setupGlobalShortcuts();
      this.updateAppIcon(this.appIcon);

      transcriptionService.configure();

      if (settingsStore.get("startClickThrough")) {
        windowManager.setInteractive(false);
      }

      this.starting = false;
      this.isReady = true;

      if (settingsStore.get("autoStartRecording")) {
        setTimeout(() => this.startRecording(), 1200);
      }

      logger.info("Application initialized successfully");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", { error: error.message });
      app.quit();
    }
  }

  /**
   * Windows system-audio capture. Electron routes getDisplayMedia through this
   * handler; returning audio:'loopback' hands back the WASAPI loopback of the
   * default render endpoint — i.e. whatever the meeting app is playing.
   *
   * 'loopback' (not 'loopbackWithMute'): the user must keep hearing the call.
   * useSystemPicker is passed explicitly as false — toggling it has a known
   * bug where getDisplayMedia never resolves.
   */
  setupDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 },
          });
          if (sources.length === 0) {
            logger.error("No screen source available for loopback audio");
            callback({});
            return;
          }
          callback({ video: sources[0], audio: "loopback" });
        } catch (error) {
          logger.error("Display media request failed", { error: error.message });
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) return false;
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalize = (value) =>
          process.platform === "win32" ? value.toLowerCase() : value;
        return normalize(pagePath).startsWith(normalize(appRoot + path.sep));
      } catch (_) {
        return false;
      }
    };

    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) return false;
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }
        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted,
        });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+R": () => this.toggleRecording(),
      "Alt+R": () => this.toggleRecording(),
      "CommandOrControl+Shift+S": () => this.captureMeetingScreenshot(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+T": () => windowManager.toggleTranscriptWindow(),
      "CommandOrControl+Shift+O": () => this.openMeetingFolder(),
      "CommandOrControl+Shift+M": () => this.addMarker(),
      "CommandOrControl+,": () => this.showSettings(),
      "CommandOrControl+Up": () => windowManager.moveBoundWindows(0, -40),
      "CommandOrControl+Down": () => windowManager.moveBoundWindows(0, 40),
      "CommandOrControl+Left": () => windowManager.moveBoundWindows(-40, 0),
      "CommandOrControl+Right": () => windowManager.moveBoundWindows(40, 0),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      if (!success) {
        logger.warn("Global shortcut could not be registered (already taken?)", { accelerator });
      }
    });
  }

  setupServiceEventHandlers() {
    // Lets the writer hold an instantaneous event (screenshot, marker) until
    // speech that started earlier has come back from Whisper.
    meetingService.setPendingProvider(() => transcriptionService.oldestPendingStartedAt());

    transcriptionService.on("utterance", (utterance) => {
      meetingService.appendUtterance(utterance);
    });

    transcriptionService.on("status", (status) => {
      windowManager.broadcastToAllWindows("transcription-status", {
        status,
        ...transcriptionService.getStatus(),
      });
    });

    transcriptionService.on("error", (message) => {
      windowManager.broadcastToAllWindows("transcription-error", { message });
    });

    // Lines are broadcast only once they are actually on disk, so the UI order
    // always matches the file.
    meetingService.on("line", (entry) => {
      windowManager.broadcastToAllWindows("transcript-line", entry);
    });

    meetingService.on("write-error", (message) => {
      windowManager.broadcastToAllWindows("transcription-error", {
        message: `Could not write the transcript: ${message}`,
      });
    });

    // The final pass runs for minutes after the meeting ends. Surface it, or it
    // looks like the app is idle while it is doing the most useful work it does.
    offlinePass.on("progress", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", { ...payload, running: true });
    });

    offlinePass.on("done", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", {
        state: "done",
        pct: 1,
        running: false,
        message: "Final transcript ready",
        ...payload,
      });
    });

    offlinePass.on("failed", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", {
        state: "failed",
        running: false,
        message: `Final pass failed: ${payload.error}`,
        ...payload,
      });
      windowManager.broadcastToAllWindows("transcription-error", {
        message: `Final pass failed: ${payload.error}`,
      });
    });
  }

  // ── Recording lifecycle ──

  async startRecording() {
    if (transcriptionService.isRecording) return meetingService.getStatus();

    if (!transcriptionService.isAvailable()) {
      const message =
        'Whisper is not set up yet. Open Settings (Ctrl+,) → Transcription → "Install / Repair Whisper".';
      windowManager.broadcastToAllWindows("transcription-error", { message });
      logger.warn(message);
      return null;
    }

    let status;
    try {
      status = meetingService.start();
    } catch (error) {
      const message = `Could not create the meeting folder: ${error.message}`;
      logger.error(message);
      windowManager.broadcastToAllWindows("transcription-error", { message });
      return null;
    }

    // Start archiving before capture, so the recording covers the meeting from
    // its first chunk. A failure here must not stop the meeting — a live
    // transcript with no archive still beats no transcript at all.
    if (settingsStore.get("archiveAudio")) {
      try {
        audioArchive.start(status.folder, {
          system: settingsStore.get("labelSystem") || "Them",
          mic: settingsStore.get("labelMic") || "You",
        });
      } catch (error) {
        windowManager.broadcastToAllWindows("transcription-error", {
          message: `Audio archiving is off for this meeting: ${error.message}`,
        });
      }
    }

    transcriptionService.start();
    await this.startAudioCapture();

    windowManager.handleRecordingStarted();
    windowManager.broadcastToAllWindows("meeting-started", status);
    logger.info("Recording started", { folder: status.folder });
    return status;
  }

  async stopRecording() {
    if (!transcriptionService.isRecording && !meetingService.isActive()) {
      return meetingService.getStatus();
    }

    await this.stopAudioCapture();
    // Stop transcription after capture so buffered audio still gets flushed.
    await transcriptionService.stop();
    const events = meetingService.getEvents();
    const archive = await audioArchive.stop();
    const status = await meetingService.stop();

    windowManager.handleRecordingStopped();
    windowManager.broadcastToAllWindows("meeting-stopped", status);
    logger.info("Recording stopped", { folder: status.folder });

    // The final pass runs in the background: it takes minutes, and nothing in
    // the app is waiting on it. The live transcript is already on disk.
    if (archive && settingsStore.get("offlinePassEnabled") && transcriptionService.isAvailable()) {
      this.runFinalPass({ folder: status.folder, meta: archive, events }).catch((error) =>
        logger.error("Final pass could not be started", { error: error.message })
      );
    }

    return status;
  }

  /**
   * The second pass over the archived audio. Broadcasts progress so the overlay
   * can show it, then compresses the archive once the transcript exists.
   */
  async runFinalPass({ folder, meta, events = [] }) {
    if (offlinePass.isRunning()) {
      return { ok: false, error: "A final pass is already running" };
    }

    const paths = transcriptionService.getPaths();
    const result = await offlinePass.run({ folder, meta, events, paths });

    if (result.ok) {
      await this.compressArchive(meta, paths);
    }
    return result;
  }

  /**
   * Shrink the archive once it has been transcribed. FLAC is lossless and
   * roughly halves it, which matters because the audio is kept precisely so a
   * better model can be run over it later.
   */
  async compressArchive(meta, paths) {
    const format = settingsStore.get("archiveFormat");
    if (!format || format === "wav") return;

    for (const entry of meta.streams || []) {
      if (!fs.existsSync(entry.path)) continue;

      if (format === "none") {
        try {
          fs.rmSync(entry.path, { force: true });
          logger.info("Archived audio deleted after the final pass", { file: entry.path });
        } catch (error) {
          logger.warn("Could not delete archived audio", { error: error.message });
        }
        continue;
      }

      const target = entry.path.replace(/\.wav$/i, ".flac");
      try {
        const output = await this.runPythonScript(paths.python, paths.transcodeScript, [entry.path, target], paths.env);
        const parsed = JSON.parse(output.trim().split(/\r?\n/).pop() || "{}");
        if (parsed.ok) {
          fs.rmSync(entry.path, { force: true });
          entry.path = target;
          logger.info("Archived audio compressed", {
            file: target,
            saved: `${Math.round((1 - parsed.bytes / parsed.sourceBytes) * 100)}%`,
          });
        } else {
          logger.warn("FLAC transcode failed; keeping the WAV", { error: parsed.error });
        }
      } catch (error) {
        logger.warn("FLAC transcode failed; keeping the WAV", { error: error.message });
      }
    }

    // meta.json points at the archive; keep it truthful after the rename.
    try {
      const metaPath = path.join(path.dirname(meta.streams[0].path), "meta.json");
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch (error) {
      logger.warn("Could not update archive meta.json", { error: error.message });
    }
  }

  runPythonScript(python, script, args, env) {
    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process");
      const child = spawn(python, ["-u", script, ...args], { windowsHide: true, env });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`${path.basename(script)} exited with code ${code}`));
      });
    });
  }

  /**
   * Re-run the final pass on a meeting that was already recorded — after
   * editing its glossary.txt, or with a different model. This is the loop that
   * makes the archive worth keeping.
   */
  async rerunFinalPass(folder) {
    try {
      const target = folder || meetingService.folder;
      if (!target) return { ok: false, error: "No meeting folder was given" };

      const metaPath = path.join(target, "audio", "meta.json");
      if (!fs.existsSync(metaPath)) {
        return { ok: false, error: "This meeting has no archived audio (audio/meta.json is missing)" };
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

      // Paths in meta.json are from the original recording; the folder may have
      // moved, and the WAVs may since have become FLACs.
      for (const entry of meta.streams || []) {
        const candidates = [
          entry.path,
          path.join(target, "audio", `${entry.stream}.flac`),
          path.join(target, "audio", `${entry.stream}.wav`),
        ];
        const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
        if (found) entry.path = found;
      }

      let events = [];
      const eventsPath = path.join(target, "events.json");
      if (fs.existsSync(eventsPath)) {
        try {
          events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
        } catch (error) {
          logger.warn("Could not read events.json", { error: error.message });
        }
      }

      return await this.runFinalPass({ folder: target, meta, events });
    } catch (error) {
      logger.error("Re-run of the final pass failed", { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  toggleRecording() {
    if (transcriptionService.isRecording) {
      this.stopRecording().catch((error) =>
        logger.error("Failed to stop recording", { error: error.message })
      );
    } else {
      this.startRecording().catch((error) =>
        logger.error("Failed to start recording", { error: error.message })
      );
    }
  }

  /**
   * Kick the hidden audio renderer into capturing. Invoked through
   * executeJavaScript with a synthetic user gesture — getDisplayMedia refuses
   * to run without transient activation, which a hidden window never has.
   */
  async startAudioCapture() {
    const enabled = transcriptionService.getEnabledStreams();
    try {
      const result = await windowManager.runInAudioWindow(
        `window.__startCapture(${JSON.stringify(enabled)})`
      );
      logger.info("Audio capture started", result);
      return result;
    } catch (error) {
      logger.error("Audio capture failed to start", { error: error.message });
      windowManager.broadcastToAllWindows("transcription-error", {
        message: `Could not start audio capture: ${error.message}`,
      });
      return null;
    }
  }

  async stopAudioCapture() {
    try {
      await windowManager.runInAudioWindow("window.__stopCapture()");
    } catch (error) {
      logger.warn("Audio capture stop failed", { error: error.message });
    }
  }

  // ── Screenshot ──

  async captureMeetingScreenshot() {
    try {
      // Never lose a shot because recording wasn't running.
      if (!meetingService.isActive()) meetingService.start();

      const at = new Date();
      const { imageBuffer } = await captureService.captureAndProcess();
      const saved = meetingService.saveScreenshot(imageBuffer, at);

      logger.info("Screenshot saved", { file: saved.path });
      return { ok: true, filename: saved.filename };
    } catch (error) {
      logger.error("Screenshot failed", { error: error.message });
      windowManager.broadcastToAllWindows("transcription-error", {
        message: `Screenshot failed: ${error.message}`,
      });
      return { ok: false, error: error.message };
    }
  }

  addMarker(text = "") {
    if (!meetingService.isActive()) return { ok: false, error: "No meeting is recording" };
    meetingService.appendMarker(text);
    return { ok: true };
  }

  openMeetingFolder() {
    const folder = meetingService.folder || settingsStore.get("transcriptRoot");
    try {
      fs.mkdirSync(folder, { recursive: true });
      shell.openPath(folder);
      return { ok: true, folder };
    } catch (error) {
      logger.warn("Could not open meeting folder", { folder, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  showSettings() {
    windowManager.showSettings();
    const settingsWindow = windowManager.getWindow("settings");
    if (settingsWindow) {
      setTimeout(() => {
        settingsWindow.webContents.send("load-settings", this.getSettings());
      }, 100);
    }
  }

  getSettings() {
    return {
      ...settingsStore.all(),
      audioInputs: this.audioDevices.inputs,
      whisper: transcriptionService.getStatus(),
      meeting: meetingService.getStatus(),
    };
  }

  saveSettings(patch) {
    const previous = settingsStore.all();
    const next = settingsStore.update(patch);

    if (patch.appIcon && patch.appIcon !== previous.appIcon) {
      this.updateAppIcon(patch.appIcon);
    }
    if (patch.windowGap !== undefined) {
      windowManager.setWindowGap(Number(patch.windowGap) || 10);
    }

    // Reconfigure the pipeline so model/VAD/label changes take effect without
    // a restart. Streams pick up new settings on their next start.
    transcriptionService.configure();
    // Skip the settings pane itself: it already has these values, and pushing
    // them back would rewrite fields under the user's cursor.
    windowManager.broadcastToAllWindows("load-settings", this.getSettings(), ["settings"]);
    return { ok: true, settings: next };
  }

  setupIPCHandlers() {
    // ── Meeting ──
    ipcMain.handle("meeting:start", () => this.startRecording());
    ipcMain.handle("meeting:stop", () => this.stopRecording());
    ipcMain.handle("meeting:status", () => ({
      ...meetingService.getStatus(),
      recording: transcriptionService.isRecording,
    }));
    ipcMain.handle("meeting:open-folder", () => this.openMeetingFolder());
    ipcMain.handle("meeting:screenshot", () => this.captureMeetingScreenshot());
    ipcMain.handle("meeting:add-marker", (_event, text) => this.addMarker(text));
    ipcMain.handle("meeting:final-status", () => offlinePass.getStatus());
    ipcMain.handle("meeting:rerun-final", (_event, folder) => this.rerunFinalPass(folder));

    ipcMain.handle("meeting:pick-and-rerun", async () => {
      const result = await dialog.showOpenDialog({
        title: "Pick a meeting folder to re-transcribe",
        defaultPath: settingsStore.get("transcriptRoot"),
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      // Fire and forget: this takes minutes and reports through 'final-pass'.
      this.rerunFinalPass(result.filePaths[0]).catch((error) =>
        logger.error("Re-run failed", { error: error.message })
      );
      return { ok: true, folder: result.filePaths[0] };
    });

    // ── Audio engine ──
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        transcriptionService.ingest(data.streamId, Buffer.from(data.buffer));
      }
    });

    ipcMain.on("audio-level", (_event, data) => {
      windowManager.broadcastToAllWindows("audio-level", data);
    });

    ipcMain.on("audio-error", (_event, data) => {
      logger.error("Audio capture error", data);
      windowManager.broadcastToAllWindows("transcription-error", {
        message: `${data.streamId === "system" ? "System audio" : "Microphone"}: ${data.message}`,
      });
    });

    ipcMain.on("audio-started", (_event, info) => {
      logger.info("Audio stream started", info);
    });

    ipcMain.on("audio-stopped", (_event, info) => {
      logger.debug("Audio stream stopped", info);
    });

    ipcMain.on("audio:devices-enumerated", (_event, devices) => {
      this.audioDevices = devices || { inputs: [] };
    });

    ipcMain.handle("audio:list-devices", async () => {
      try {
        const devices = await windowManager.runInAudioWindow("window.__listDevices()");
        this.audioDevices = devices || { inputs: [] };
        return this.audioDevices;
      } catch (error) {
        logger.warn("Could not enumerate audio devices", { error: error.message });
        return { inputs: [] };
      }
    });

    // ── Settings ──
    ipcMain.handle("settings:get", () => this.getSettings());
    ipcMain.handle("settings:save", (_event, patch) => this.saveSettings(patch || {}));
    ipcMain.handle("show-settings", () => {
      this.showSettings();
      return { ok: true };
    });
    ipcMain.on("close-settings", () => windowManager.hideSettings());

    ipcMain.handle("settings:pick-folder", async () => {
      const window = windowManager.getWindow("settings");
      const result = await dialog.showOpenDialog(window, {
        title: "Choose where meeting transcripts are saved",
        defaultPath: settingsStore.get("transcriptRoot"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    });

    ipcMain.handle("settings:pick-python", async () => {
      const window = windowManager.getWindow("settings");
      const result = await dialog.showOpenDialog(window, {
        title: "Select python.exe",
        properties: ["openFile"],
        filters: process.platform === "win32"
          ? [{ name: "Python", extensions: ["exe"] }]
          : [],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    });

    // ── Whisper setup ──
    ipcMain.handle("whisper:status", () => transcriptionService.getStatus());

    ipcMain.handle("whisper:install", async (event, options = {}) => {
      const sender = event.sender;
      const send = (line) => {
        try { sender.send("install-progress", line); } catch (_) { /* window gone */ }
      };
      return this.runWhisperSetup(options, send);
    });

    // ── Windows ──
    ipcMain.handle("resize-window", (_event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (_) {
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (_event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setPosition(x + deltaX, y + deltaY);
      }
      return { success: true };
    });

    ipcMain.handle("move-bound-windows", (_event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("resize-transcript-window", (_event, metrics) => {
      windowManager.resizeTranscriptWindow(metrics);
      return { success: true };
    });

    ipcMain.handle("window:toggle-transcript", () => ({
      visible: windowManager.toggleTranscriptWindow(),
    }));

    ipcMain.handle("window:toggle-interaction", () => ({
      interactive: windowManager.toggleInteraction(),
    }));

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("get-window-stats", () => windowManager.getWindowStats());
    ipcMain.handle("set-window-gap", (_event, gap) => windowManager.setWindowGap(gap));

    ipcMain.handle("close-window", (event) => {
      windowManager.windows.forEach((win) => {
        if (!win.isDestroyed() && win.webContents === event.sender) win.hide();
      });
      return { success: true };
    });

    // ── App ──
    ipcMain.handle("copy-to-clipboard", (_event, text) => {
      try {
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (error) {
        logger.error("Failed to write to clipboard", { error: error.message });
        return false;
      }
    });

    ipcMain.handle("update-app-icon", (_event, iconKey) => {
      settingsStore.update({ appIcon: iconKey });
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      app.relaunch();
      app.exit();
    });

    ipcMain.on("main-window-ready", () => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("transcription-status", {
          status: transcriptionService.isAvailable() ? "Ready" : "Whisper not set up",
          ...transcriptionService.getStatus(),
        });
      }
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit requested");
      this.quit();
    });

    ipcMain.on("quit-app", () => {
      logger.info("Quit requested");
      this.quit();
    });
  }

  /**
   * Run scripts/setup-whisper.js, streaming its output to the settings pane.
   * The script prints "OK <python path>" on success, which becomes the stored
   * interpreter path.
   */
  runWhisperSetup(options, send) {
    return new Promise((resolve) => {
      const { spawn } = require("child_process");
      const scriptPath = this._unpackedPath(path.join(__dirname, "scripts", "setup-whisper.js"));
      const args = [
        scriptPath,
        "--model",
        options.model || settingsStore.get("whisperModel") || "small",
        "--data-dir",
        app.getPath("userData"),
      ];
      if (options.gpu) args.push("--gpu");

      send(`Running setup (this can take several minutes)...`);

      // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it
      // behave as plain Node, so no separate Node install is required.
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });

      let pythonPath = null;
      const handle = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          send(line);
          const match = line.match(/^OK (.+)$/);
          if (match) pythonPath = match[1].trim();
        }
      };

      child.stdout.on("data", handle);
      child.stderr.on("data", handle);

      child.on("error", (error) => {
        send(`ERROR ${error.message}`);
        resolve({ ok: false, message: error.message });
      });

      child.on("close", (code) => {
        if (code === 0 && pythonPath) {
          settingsStore.update({ whisperPython: pythonPath });
          transcriptionService.configure();
          send("Whisper is ready.");
          resolve({ ok: true, python: pythonPath });
        } else {
          resolve({ ok: false, message: `Setup exited with code ${code}` });
        }
      });
    });
  }

  _unpackedPath(candidate) {
    const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : candidate;
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") app.quit();
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    // Close the transcript file before the process goes away so a quit during
    // a meeting still leaves a complete, closed file.
    // Patch the WAV headers before the process goes away, so a quit mid-meeting
    // still leaves a playable archive rather than a truncated one.
    audioArchive.stopSync();
    offlinePass.cancel();
    meetingService.shutdown();
    transcriptionService.shutdown();
    windowManager.destroyAllWindows();
    logger.info("Application shutting down");
  }

  quit() {
    try {
      audioArchive.stopSync();
      offlinePass.cancel();
      meetingService.shutdown();
      transcriptionService.shutdown();
      windowManager.destroyAllWindows();
      globalShortcut.unregisterAll();
      app.quit();
      setTimeout(() => process.exit(0), 2000);
    } catch (error) {
      logger.error("Error during quit", { error: error.message });
      process.exit(1);
    }
  }

  // ── Disguise (icon + process name) ──

  updateAppIcon(iconKey) {
    try {
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];
      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);
      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", { iconKey, iconPath: fullIconPath });
        return { success: false, error: "Icon file not found" };
      }

      if (process.platform === "darwin") {
        if (app.dock) {
          app.dock.setIcon(fullIconPath);
          const retry = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* no dock */ }
          };
          setTimeout(retry, 100);
          setTimeout(retry, 500);
        }
      } else {
        windowManager.windows.forEach((window) => {
          if (window && !window.isDestroyed()) window.setIcon(fullIconPath);
        });
      }

      this.updateAppName(appName, iconKey);
      this.appIcon = iconKey;
      logger.info("App icon and name updated", { iconKey, appName });
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      process.title = appName;

      if (process.platform === "darwin") {
        app.setName(appName);
        if (app.dock) {
          app.dock.setBadge("");
          setTimeout(() => {
            app.dock.setIcon(path.resolve(__dirname, `assests/icons/${iconKey}.png`));
          }, 50);
        }
      }

      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      windowManager.windows.forEach((window) => {
        if (window && !window.isDestroyed()) window.setTitle(appName.trim());
      });

      // The name doesn't always stick on the first try; re-apply a few times.
      [50, 100, 200, 500].forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") app.setName(appName);
        }, delay);
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
