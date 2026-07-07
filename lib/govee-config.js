const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "govee-config.json");

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

function getConfig(broadcasterUserId) {
  return readAll()[String(broadcasterUserId)] || null;
}

function saveConfig(broadcasterUserId, patch) {
  const configs = readAll();
  const id = String(broadcasterUserId);
  configs[id] = {
    ...(configs[id] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeAll(configs);
  return configs[id];
}

function deleteConfig(broadcasterUserId) {
  const configs = readAll();
  delete configs[String(broadcasterUserId)];
  writeAll(configs);
}

module.exports = {
  getConfig,
  saveConfig,
  deleteConfig,
};
