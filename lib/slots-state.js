const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_PATH = path.join(__dirname, "..", "data", "slots-state.json");

const DEFAULT_STATE = {
  requests: [],
  lastPick: null,
  pickNonce: 0,
  lastPickAt: null,
};

/** Minimum time between !slots picks (matches ~12s pick animation + buffer). */
const PICK_COOLDOWN_MS = 15000;

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE };
  }

  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function load() {
  return readState();
}

function save(state) {
  writeState(state);
  return state;
}

function normalizeUsername(username) {
  return String(username || "viewer").trim().slice(0, 40);
}

function findRequestIndex(requests, username) {
  const key = normalizeUsername(username).toLowerCase();
  return requests.findIndex(
    (entry) => normalizeUsername(entry.username).toLowerCase() === key
  );
}

function addRequest(username, slotName, userMeta = {}) {
  const state = load();
  const safeName = normalizeUsername(username);
  const safeSlot = String(slotName || "").trim().slice(0, 80);
  const userId = userMeta.userId ? String(userMeta.userId) : null;
  const profilePicture = userMeta.profilePicture || null;

  if (!safeSlot) {
    return { state, error: "Slot name required. Use: !sr <slot name>" };
  }

  const existingIndex = findRequestIndex(state.requests, safeName);

  if (existingIndex >= 0) {
    const entry = state.requests[existingIndex];
    entry.slotName = safeSlot;
    entry.updatedAt = new Date().toISOString();
    if (userId) entry.userId = userId;
    if (profilePicture) entry.profilePicture = profilePicture;
    save(state);
    return { state, request: entry, updated: true };
  }

  const entry = {
    id: crypto.randomUUID(),
    username: safeName,
    slotName: safeSlot,
    userId,
    profilePicture,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };

  state.requests.push(entry);
  save(state);
  return { state, request: entry, updated: false };
}

function getPickCooldownRemaining(state = load()) {
  if (!state.lastPickAt) return 0;
  return Math.max(0, PICK_COOLDOWN_MS - (Date.now() - state.lastPickAt));
}

function pickRandom() {
  const state = load();
  const cooldownMs = getPickCooldownRemaining(state);
  if (cooldownMs > 0) {
    const seconds = Math.ceil(cooldownMs / 1000);
    return {
      state,
      error: `!slots on cooldown — wait ${seconds}s (pick animation still running)`,
    };
  }

  if (!state.requests.length) {
    return { state, error: "No slot requests in the queue." };
  }

  const spinPool = state.requests.map((entry) => ({
    slotName: entry.slotName,
    username: entry.username,
    userId: entry.userId || null,
    profilePicture: entry.profilePicture || null,
  }));

  const index = Math.floor(Math.random() * state.requests.length);
  const [picked] = state.requests.splice(index, 1);

  state.lastPick = {
    id: picked.id,
    username: picked.username,
    slotName: picked.slotName,
    userId: picked.userId || null,
    profilePicture: picked.profilePicture || null,
    pickedAt: new Date().toISOString(),
    spinPool,
  };
  state.pickNonce += 1;
  state.lastPickAt = Date.now();
  save(state);

  return { state, pick: state.lastPick };
}

function clearQueue() {
  const state = load();
  state.requests = [];
  save(state);
  return state;
}

function clearLastPick() {
  const state = load();
  state.lastPick = null;
  save(state);
  return state;
}

function parseSlotRequest(content) {
  const match = content.trim().match(/^[!/]sr\s+(.+)$/i);
  if (!match) return null;
  const slotName = match[1].trim();
  if (!slotName) return null;
  return { slotName };
}

function parseSlotsPick(content) {
  if (/^[!/]slots$/i.test(content.trim())) {
    return { action: "pick" };
  }
  return null;
}

module.exports = {
  DEFAULT_STATE,
  load,
  save,
  addRequest,
  pickRandom,
  getPickCooldownRemaining,
  PICK_COOLDOWN_MS,
  clearQueue,
  clearLastPick,
  parseSlotRequest,
  parseSlotsPick,
};
