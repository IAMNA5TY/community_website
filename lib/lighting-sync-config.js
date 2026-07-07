const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "lighting-sync.json");

const DEFAULTS = {
  moodEnabled: false,
  beatEnabled: false,
  bpmOffset: 0,
  beatPhaseMs: 0,
  audioSyncEnabled: true,
  audioSensitivity: 6,
};

function readAll() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(configs) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2));
}

function getSettings(broadcasterUserId) {
  const stored = readAll()[String(broadcasterUserId)] || {};
  return {
    ...DEFAULTS,
    ...stored,
    moodEnabled: Boolean(stored.moodEnabled),
    beatEnabled: Boolean(stored.beatEnabled),
    bpmOffset: Number(stored.bpmOffset) || 0,
    beatPhaseMs: Number(stored.beatPhaseMs) || 0,
    audioSyncEnabled:
      stored.audioSyncEnabled !== undefined
        ? Boolean(stored.audioSyncEnabled)
        : DEFAULTS.audioSyncEnabled,
    audioSensitivity: clampSensitivity(stored.audioSensitivity),
  };
}

function clampSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.audioSensitivity;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function saveSettings(broadcasterUserId, patch) {
  const current = getSettings(broadcasterUserId);
  const configs = readAll();
  const id = String(broadcasterUserId);
  configs[id] = {
    moodEnabled:
      patch.moodEnabled !== undefined ? Boolean(patch.moodEnabled) : current.moodEnabled,
    beatEnabled:
      patch.beatEnabled !== undefined ? Boolean(patch.beatEnabled) : current.beatEnabled,
    bpmOffset:
      patch.bpmOffset !== undefined ? Number(patch.bpmOffset) || 0 : current.bpmOffset,
    beatPhaseMs:
      patch.beatPhaseMs !== undefined ? Number(patch.beatPhaseMs) || 0 : current.beatPhaseMs,
    audioSyncEnabled:
      patch.audioSyncEnabled !== undefined
        ? Boolean(patch.audioSyncEnabled)
        : current.audioSyncEnabled,
    audioSensitivity:
      patch.audioSensitivity !== undefined
        ? clampSensitivity(patch.audioSensitivity)
        : current.audioSensitivity,
    updatedAt: new Date().toISOString(),
  };
  writeAll(configs);
  return getSettings(id);
}

module.exports = {
  getSettings,
  saveSettings,
};
