const fs = require("fs");
const path = require("path");
const alertEvents = require("./alert-events");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "alert-state.json");

const DEFAULT_STATE = {
  alertNonce: 0,
  lastAlert: null,
};

function readState() {
  if (!fs.existsSync(STORE_PATH)) return { ...DEFAULT_STATE };

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      alertNonce: parsed.alertNonce || 0,
      lastAlert: parsed.lastAlert || null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFile(STORE_PATH, JSON.stringify(state, null, 2), () => {});
}

function pushAlert(alert) {
  const state = readState();
  const next = {
    alertNonce: (state.alertNonce || 0) + 1,
    lastAlert: {
      ...alert,
      at: new Date().toISOString(),
    },
  };
  alertEvents.broadcastAlert(next);
  writeState(next);
  return next;
}

function load() {
  return readState();
}

module.exports = {
  load,
  pushAlert,
};
