const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CALIBRATION_PATH = path.join(DATA_DIR, "lighting-calibration.json");

const KNOWN_TRACKS = [
  {
    match: /sandstorm/i,
    name: "Sandstorm",
    bpm: 136,
    beatsPerFlash: 1,
    mode: "wild",
    bpmOffset: 0,
  },
];

function readStore() {
  if (!fs.existsSync(CALIBRATION_PATH)) {
    return { tracks: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8"));
    return { tracks: parsed.tracks || {} };
  } catch {
    return { tracks: {} };
  }
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(
    CALIBRATION_PATH,
    JSON.stringify({ tracks: store.tracks || {} }, null, 2)
  );
}

function matchKnownTrack(track) {
  const name = String(track?.name || "");
  return KNOWN_TRACKS.find((entry) => entry.match.test(name)) || null;
}

function getTrackCalibration(broadcasterUserId, trackId) {
  const store = readStore();
  return store.tracks[`${broadcasterUserId}:${trackId}`] || null;
}

function saveTrackCalibration(broadcasterUserId, track, profile) {
  const store = readStore();
  const key = `${broadcasterUserId}:${track.id}`;
  store.tracks[key] = {
    trackId: track.id,
    name: track.name,
    bpm: profile.bpm ?? null,
    bpmOffset: Number(profile.bpmOffset) || 0,
    beatsPerFlash: Number(profile.beatsPerFlash) || 1,
    mode: profile.mode || "wild",
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return store.tracks[key];
}

function resolveTrackProfile(track, settings) {
  const known = matchKnownTrack(track);
  if (known) {
    return {
      ...known,
      bpmOffset: Number(settings.bpmOffset ?? known.bpmOffset) || 0,
      source: "preset",
    };
  }

  return {
    name: track.name,
    bpm: null,
    beatsPerFlash: 1,
    mode: "drop",
    bpmOffset: Number(settings.bpmOffset) || 0,
    source: "auto",
  };
}

function resolveTrackProfileForUser(broadcasterUserId, track, settings) {
  const saved = getTrackCalibration(broadcasterUserId, track.id);
  if (saved) {
    return {
      name: saved.name,
      bpm: saved.bpm,
      beatsPerFlash: saved.beatsPerFlash,
      mode: saved.mode,
      bpmOffset: Number(saved.bpmOffset ?? settings.bpmOffset) || 0,
      source: "saved",
    };
  }

  const profile = resolveTrackProfile(track, settings);
  return profile;
}

function listCalibrations(broadcasterUserId) {
  const store = readStore();
  const prefix = `${broadcasterUserId}:`;
  return Object.entries(store.tracks)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value);
}

module.exports = {
  KNOWN_TRACKS,
  getTrackCalibration,
  saveTrackCalibration,
  resolveTrackProfileForUser,
  listCalibrations,
  matchKnownTrack,
};
