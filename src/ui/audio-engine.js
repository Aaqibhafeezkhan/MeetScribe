/**
 * Audio engine renderer.
 *
 * Runs in a hidden 1x1 window and owns both capture pipelines:
 *   - "system": Windows loopback of the default playback device (the meeting)
 *   - "mic":    the user's microphone
 *
 * Both are resampled to 16 kHz mono PCM16 by the Web Audio graph itself and
 * pushed to the main process, which feeds them to VAD + Whisper.
 *
 * Entry points are attached to `window` because the main process invokes them
 * via webContents.executeJavaScript(..., userGesture=true) — getDisplayMedia
 * requires transient user activation that a hidden window can never produce
 * on its own.
 */

// AudioWorklet source. Kept as a string and loaded from a Blob URL because
// addModule() rejects file:// paths as cross-origin in Chromium.
const PCM_TAP_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Batch ~64ms per message. Raw 128-frame render quanta would mean ~125
    // IPC messages per second per stream for no benefit; VAD works on
    // coarser granularity than that.
    this.batchFrames = (options.processorOptions && options.processorOptions.batchFrames) || 1024;
    this.buffer = new Float32Array(this.batchFrames);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.batchFrames) {
        const pcm = new Int16Array(this.batchFrames);
        let sumSquares = 0;
        for (let j = 0; j < this.batchFrames; j++) {
          const sample = Math.max(-1, Math.min(1, this.buffer[j]));
          sumSquares += sample * sample;
          pcm[j] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage(
          { pcm: pcm.buffer, rms: Math.sqrt(sumSquares / this.batchFrames) },
          [pcm.buffer]
        );
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

const SAMPLE_RATE = 16000;
const LEVEL_INTERVAL_MS = 100;

const taps = new Map(); // streamId -> tap handle
let workletUrl = null;

function log(...args) {
  console.log('[audio-engine]', ...args);
}

/**
 * Build the shared capture graph for one MediaStream.
 *
 * The 16 kHz AudioContext and channelCount:1 / channelCountMode:'explicit' do
 * all the signal work: Chromium resamples 48 kHz -> 16 kHz and applies the
 * spec's stereo -> mono downmix. No hand-rolled DSP.
 */
async function createTap(streamId, mediaStream, extraTracks = []) {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const source = audioContext.createMediaStreamSource(mediaStream);

  let node;
  let path;

  try {
    if (!workletUrl) {
      const blob = new Blob([PCM_TAP_SOURCE], { type: 'application/javascript' });
      workletUrl = URL.createObjectURL(blob);
    }
    await audioContext.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(audioContext, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { batchFrames: 1024 }
    });
    path = 'worklet';

    let lastLevelAt = 0;
    node.port.onmessage = (event) => {
      const { pcm, rms } = event.data;
      window.electronAPI.sendAudioChunk(streamId, pcm);
      const now = Date.now();
      if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
        lastLevelAt = now;
        window.electronAPI.sendAudioLevel(streamId, rms);
      }
    };

    source.connect(node);
  } catch (error) {
    // ScriptProcessor is deprecated and runs on the main thread, but it works
    // everywhere. Losing the worklet must not mean losing the recording.
    log(`AudioWorklet unavailable for ${streamId}; falling back to ScriptProcessor`, error);
    node = audioContext.createScriptProcessor(4096, 1, 1);
    path = 'scriptprocessor';

    let lastLevelAt = 0;
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        sumSquares += sample * sample;
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      window.electronAPI.sendAudioChunk(streamId, pcm.buffer);
      const now = Date.now();
      if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
        lastLevelAt = now;
        window.electronAPI.sendAudioLevel(streamId, Math.sqrt(sumSquares / input.length));
      }
    };

    source.connect(node);
    // ScriptProcessorNode only fires while connected to a destination.
    node.connect(audioContext.destination);
  }

  const audioTrack = mediaStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.addEventListener('ended', () => {
      window.electronAPI.reportAudioError(streamId, 'TrackEnded', 'The audio device stopped delivering audio');
      stopTap(streamId);
    });
  }

  taps.set(streamId, { audioContext, source, node, mediaStream, extraTracks, path });

  const settings = audioTrack ? audioTrack.getSettings() : {};
  const info = {
    streamId,
    path,
    sampleRate: audioContext.sampleRate,
    channels: 1,
    deviceLabel: audioTrack ? audioTrack.label : '',
    sourceSampleRate: settings.sampleRate || null
  };
  window.electronAPI.reportAudioStarted(info);
  log('capture started', info);
  return info;
}

function stopTap(streamId) {
  const tap = taps.get(streamId);
  if (!tap) return;
  taps.delete(streamId);

  try {
    if (tap.node) {
      tap.node.disconnect();
      if (tap.node.port) tap.node.port.onmessage = null;
      tap.node.onaudioprocess = null;
    }
    if (tap.source) tap.source.disconnect();
    tap.mediaStream.getTracks().forEach((track) => track.stop());
    tap.extraTracks.forEach((track) => track.stop());
    tap.audioContext.close().catch(() => {});
  } catch (error) {
    log(`error stopping ${streamId}`, error);
  }

  window.electronAPI.reportAudioStopped(streamId);
}

/**
 * System audio via Electron's loopback support.
 *
 * The video track is requested at 4x4 @ 1fps and deliberately kept alive: a
 * 0x0 track produces a silent audio track, and stopping the video track has
 * been observed to kill loopback audio. The frames are never rendered, so the
 * cost is negligible.
 */
async function startLoopback() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 4 }, height: { max: 4 }, frameRate: { max: 1 } },
    audio: true
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('No system audio track was returned. Loopback audio is Windows-only.');
  }

  const videoTracks = stream.getVideoTracks();
  const audioOnly = new MediaStream(audioTracks);
  return createTap('system', audioOnly, videoTracks);
}

/** System audio via a named input device (Stereo Mix, VB-CABLE, ...). */
async function startSystemFromDevice(deviceLabel) {
  const deviceId = await resolveDeviceId(deviceLabel);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // This is a line-in style capture of already-mixed audio; the voice
      // processing chain would only distort it.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  return createTap('system', stream);
}

async function startMic(deviceLabel) {
  const deviceId = await resolveDeviceId(deviceLabel);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // Echo cancellation is the first line of defence against the meeting
      // audio coming back in through the mic; the main process also does a
      // text-level echo check for what slips through.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  return createTap('mic', stream);
}

/**
 * Devices are matched by label, not deviceId: Chromium deviceIds for file://
 * origins are unstable across restarts and often empty until permission has
 * been granted.
 */
async function resolveDeviceId(label) {
  if (!label) return null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const match = devices.find(
      (device) => device.kind === 'audioinput' && device.label === label
    );
    return match ? match.deviceId : null;
  } catch (_) {
    return null;
  }
}

async function listDevices() {
  // Labels stay blank until a capture permission has been granted once.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ label: device.label, deviceId: device.deviceId }));
  return { inputs };
}

window.__startCapture = async function startCapture(options = {}) {
  window.__stopCapture();

  const results = { system: null, mic: null, errors: [] };

  if (options.system) {
    try {
      results.system = options.systemSource === 'device'
        ? await startSystemFromDevice(options.systemDeviceLabel)
        : await startLoopback();
    } catch (error) {
      results.errors.push({ streamId: 'system', message: error.message });
      window.electronAPI.reportAudioError('system', error.name || 'Error', error.message);
    }
  }

  if (options.mic) {
    try {
      results.mic = await startMic(options.micDeviceLabel);
    } catch (error) {
      results.errors.push({ streamId: 'mic', message: error.message });
      window.electronAPI.reportAudioError('mic', error.name || 'Error', error.message);
    }
  }

  // Device labels are only readable after a grant, so refresh the cached list
  // once capture is running.
  listDevices()
    .then((devices) => window.electronAPI.setAudioDevices(devices))
    .catch(() => {});

  return results;
};

window.__stopCapture = function stopCapture() {
  for (const streamId of Array.from(taps.keys())) {
    stopTap(streamId);
  }
  return { stopped: true };
};

window.__listDevices = listDevices;

log('ready');
