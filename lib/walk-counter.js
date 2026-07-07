const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const COUNTER_PATH = path.join(DATA_DIR, "walk-counter.json");

function readCounters() {
  if (!fs.existsSync(COUNTER_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(COUNTER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCounters(counters) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(COUNTER_PATH, JSON.stringify(counters, null, 2));
}

function defaultEntry(targetName = "Nasty") {
  return {
    minutes: 0,
    targetName,
    updatedAt: new Date().toISOString(),
  };
}

function getWalkCounter(broadcasterUserId) {
  const counters = readCounters();
  return counters[String(broadcasterUserId)] || defaultEntry();
}

function setTargetName(broadcasterUserId, targetName) {
  const counters = readCounters();
  const id = String(broadcasterUserId);
  const current = counters[id] || defaultEntry();
  current.targetName = targetName.trim() || "Nasty";
  current.updatedAt = new Date().toISOString();
  counters[id] = current;
  writeCounters(counters);
  return current;
}

function setMinutes(broadcasterUserId, minutes) {
  const counters = readCounters();
  const id = String(broadcasterUserId);
  const current = counters[id] || defaultEntry();
  current.minutes = Math.max(0, Number(minutes) || 0);
  current.updatedAt = new Date().toISOString();
  counters[id] = current;
  writeCounters(counters);
  return current;
}

function adjustMinutes(broadcasterUserId, delta) {
  const current = getWalkCounter(broadcasterUserId);
  return setMinutes(broadcasterUserId, current.minutes + delta);
}

function formatWalkMessage(counter) {
  const name = counter.targetName || "Nasty";
  const minutes = counter.minutes || 0;
  return `${name} owes ${minutes} minute${minutes === 1 ? "" : "s"} on the treadmill`;
}

function parseWalkCommand(content) {
  const trimmed = content.trim();

  const setMatch = trimmed.match(/^!walk\s+set\s+(\d+)\s*$/i);
  if (setMatch) {
    return { action: "set", minutes: Number(setMatch[1]) };
  }

  const match = trimmed.match(/^!walk(?:\s+([+-])\s*(\d+)?)?$/i);
  if (!match) {
    return null;
  }

  if (!match[1]) {
    return { action: "show" };
  }

  const sign = match[1] === "+" ? 1 : -1;
  const amount = match[2] ? Number(match[2]) : 1;
  return { action: "adjust", delta: sign * amount };
}

module.exports = {
  getWalkCounter,
  setTargetName,
  setMinutes,
  adjustMinutes,
  formatWalkMessage,
  parseWalkCommand,
};
