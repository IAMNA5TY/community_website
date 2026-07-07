const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "data", "sign-in-log.json");
const MAX_ENTRIES = 100;

function readLog() {
  if (!fs.existsSync(LOG_PATH)) {
    return [];
  }

  try {
    const entries = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeLog(entries) {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

function recordSignIn(entry) {
  try {
    const log = readLog();
    log.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      broadcasterId: String(entry.broadcasterId || ""),
      username: entry.username || null,
      displayName: entry.displayName || null,
      profileImage: entry.profileImage || null,
      allowed: Boolean(entry.allowed),
      ip: entry.ip || null,
    });
    writeLog(log.slice(0, MAX_ENTRIES));
  } catch (error) {
    console.warn("[sign-in-log] record failed:", error.message);
  }
}

function getRecent(limit = 50) {
  return readLog().slice(0, Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

module.exports = {
  recordSignIn,
  getRecent,
};
