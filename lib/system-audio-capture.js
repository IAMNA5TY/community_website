const { spawn } = require("child_process");
const path = require("path");
const { AudioBeatDetector, SAMPLE_RATE } = require("./audio-beat-detector");

let ffmpegPath = null;
try {
  ffmpegPath = require("ffmpeg-static");
} catch {
  ffmpegPath = null;
}

const listeners = new Set();
let captureProcess = null;
let detector = null;
let activeDevice = null;
let status = {
  running: false,
  device: null,
  error: null,
  beatsDetected: 0,
  lastBeatAt: null,
  hasSignal: false,
  signalLevel: 0,
};

let recentEnergy = [];

function getStatus() {
  return { ...status };
}

function onBeat(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function emitBeat() {
  status.beatsDetected += 1;
  status.lastBeatAt = new Date().toISOString();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[system-audio] beat listener:", error.message);
    }
  }
}

function listDshowAudioDevices() {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve([]);
      return;
    }

    const devices = [];
    const proc = spawn(ffmpegPath, ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
      windowsHide: true,
    });

    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      const match = text.match(/"([^"]+)" \(audio\)/);
      if (match) {
        devices.push(match[1]);
      }
    });

    proc.on("close", () => resolve(devices));
    proc.on("error", () => resolve([]));
  });
}

function pickCaptureDevice(devices) {
  const envDevice = process.env.AUDIO_CAPTURE_DEVICE?.trim();
  if (envDevice) {
    const exact = devices.find((name) => name === envDevice);
    if (exact) return exact;
    const partial = devices.find((name) =>
      name.toLowerCase().includes(envDevice.toLowerCase())
    );
    if (partial) return partial;
  }

  const preferred = [
    /stereo mix/i,
    /wave out/i,
    /loopback/i,
    /cable output/i,
    /vb-audio/i,
    /rodecaster.*chat/i,
    /rodecaster.*main/i,
    /what u hear/i,
  ];

  for (const pattern of preferred) {
    const match = devices.find((name) => pattern.test(name));
    if (match) return match;
  }

  return devices[0] || null;
}

function startCapture(deviceName, options = {}) {
  if (!ffmpegPath) {
    status.error = "ffmpeg-static is not available";
    return false;
  }

  stopCapture();

  const device = deviceName.includes("audio=") ? deviceName : `audio=${deviceName}`;
  const sensitivity =
    Number(options.sensitivity) || Number(process.env.AUDIO_BEAT_SENSITIVITY) || 6;
  const minBeatGapMs =
    Number(options.minBeatGapMs) || Number(process.env.AUDIO_MIN_BEAT_GAP_MS) || 135;

  detector = new AudioBeatDetector({
    sensitivity,
    minBeatGapMs,
  });

  const args = [
    "-f",
    "dshow",
    "-i",
    device,
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-f",
    "s16le",
    "-",
  ];

  captureProcess = spawn(ffmpegPath, args, { windowsHide: true });
  status.running = true;
  status.device = deviceName;
  status.error = null;
  activeDevice = deviceName;

  captureProcess.stdout.on("data", (chunk) => {
    if (!detector) return;

    const level = detector.getLastEnergy();
    recentEnergy.push(level);
    if (recentEnergy.length > 40) {
      recentEnergy.shift();
    }
    const avg =
      recentEnergy.reduce((sum, value) => sum + value, 0) / Math.max(1, recentEnergy.length);
    status.signalLevel = Math.round(avg);
    status.hasSignal = avg > 28;

    if (detector.processInt16(chunk)) {
      emitBeat();
    }
  });

  captureProcess.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/error|failed|could not/i.test(text) && !/Past duration/i.test(text)) {
      status.error = text.split("\n").find((line) => line.trim())?.trim() || text.trim();
    }
  });

  captureProcess.on("close", (code) => {
    if (code && code !== 0 && !status.error) {
      status.error = `Audio capture stopped (code ${code})`;
    }
    status.running = false;
    captureProcess = null;
  });

  captureProcess.on("error", (error) => {
    status.error = error.message;
    status.running = false;
    captureProcess = null;
  });

  return true;
}

function stopCapture() {
  if (captureProcess) {
    captureProcess.kill("SIGTERM");
    captureProcess = null;
  }
  detector = null;
  recentEnergy = [];
  status.running = false;
  status.hasSignal = false;
  status.signalLevel = 0;
  activeDevice = null;
}

async function start(options = {}) {
  if (captureProcess) {
    return getStatus();
  }

  const devices = await listDshowAudioDevices();
  const device = options.device || pickCaptureDevice(devices);

  if (!device) {
    status.error =
      "No audio input found. Enable Stereo Mix in Windows Sound settings, or set AUDIO_CAPTURE_DEVICE in .env to your mixer/output device name.";
    status.running = false;
    return getStatus();
  }

  const ok = startCapture(device, options);
  if (!ok) {
    status.error = status.error || "Failed to start audio capture";
  }

  return getStatus();
}

function getLastBeatStrength() {
  return detector?.getLastBeatStrength?.() ?? 0.5;
}

module.exports = {
  start,
  stop: stopCapture,
  onBeat,
  getStatus,
  getLastBeatStrength,
  listDshowAudioDevices,
  pickCaptureDevice,
};
