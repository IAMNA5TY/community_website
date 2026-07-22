const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");

const COOLDOWN_MS = 30 * 60 * 1000; // already healthy — don't re-check often
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000; // default if Kick omits Retry-After
const RETRY_MISSING_MS = 15 * 60 * 1000; // missing subs — retry slowly
const MIN_RATE_LIMIT_MS = 60 * 1000;
const MAX_RATE_LIMIT_MS = 45 * 60 * 1000;
const STATE_PATH = path.join(getDataDir(), "webhook-subscription-state.json");

const stateByBroadcaster = new Map();
let loaded = false;

function defaultRow() {
  return {
    lastAttempt: 0,
    rateLimitedUntil: 0,
    lastEvents: [],
    chatActive: false,
  };
}

function loadPersisted() {
  if (loaded) return;
  loaded = true;
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const rows = parsed?.broadcasters && typeof parsed.broadcasters === "object"
      ? parsed.broadcasters
      : parsed;
    if (!rows || typeof rows !== "object") return;
    for (const [key, row] of Object.entries(rows)) {
      if (!key || !row || typeof row !== "object") continue;
      stateByBroadcaster.set(String(key), {
        lastAttempt: Number(row.lastAttempt) || 0,
        rateLimitedUntil: Number(row.rateLimitedUntil) || 0,
        lastEvents: Array.isArray(row.lastEvents) ? row.lastEvents.slice() : [],
        chatActive: Boolean(row.chatActive),
      });
    }
  } catch {
    /* ignore corrupt state */
  }
}

function persist() {
  ensureDataDir();
  const broadcasters = {};
  for (const [key, row] of stateByBroadcaster.entries()) {
    broadcasters[key] = {
      lastAttempt: row.lastAttempt || 0,
      rateLimitedUntil: row.rateLimitedUntil || 0,
      lastEvents: Array.isArray(row.lastEvents) ? row.lastEvents.slice() : [],
      chatActive: Boolean(row.chatActive),
    };
  }
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), broadcasters }, null, 2)
  );
}

function getState(broadcasterId) {
  loadPersisted();
  const key = String(broadcasterId || "");
  if (!stateByBroadcaster.has(key)) {
    stateByBroadcaster.set(key, defaultRow());
  }
  return stateByBroadcaster.get(key);
}

function isRateLimited(broadcasterId) {
  return Date.now() < getState(broadcasterId).rateLimitedUntil;
}

function rateLimitRetryAt(broadcasterId) {
  const until = getState(broadcasterId).rateLimitedUntil;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

function shouldAttempt(broadcasterId, { force = false, chatActive = false } = {}) {
  const state = getState(broadcasterId);
  if (Date.now() < state.rateLimitedUntil) {
    return false;
  }
  if (force) {
    return true;
  }
  const elapsed = Date.now() - state.lastAttempt;
  if (state.chatActive || chatActive) {
    return elapsed >= COOLDOWN_MS;
  }
  return elapsed >= RETRY_MISSING_MS;
}

function parseRetryAfterMs(error, retryAfter) {
  const fromField = Number(retryAfter);
  if (Number.isFinite(fromField) && fromField > 0) {
    return fromField * 1000;
  }
  const match = String(error || "").match(/retry in\s+(\d+)\s*s/i);
  if (match) {
    return Number(match[1]) * 1000;
  }
  return RATE_LIMIT_BACKOFF_MS;
}

function noteResult(
  broadcasterId,
  { events = [], chatActive = false, error = null, retryAfter = 0 } = {}
) {
  const state = getState(broadcasterId);
  state.lastAttempt = Date.now();
  if (Array.isArray(events) && events.length) {
    state.lastEvents = events.slice();
  }
  if (chatActive !== undefined && chatActive !== null) {
    state.chatActive = Boolean(chatActive);
  }
  if (error && /rate limit/i.test(String(error))) {
    const backoff = Math.min(
      MAX_RATE_LIMIT_MS,
      Math.max(MIN_RATE_LIMIT_MS, parseRetryAfterMs(error, retryAfter))
    );
    state.rateLimitedUntil = Date.now() + backoff;
  } else if (!error) {
    // Successful register/check — clear any stale pause.
    state.rateLimitedUntil = 0;
  }
  persist();
}

function getCachedEvents(broadcasterId) {
  return getState(broadcasterId).lastEvents.slice();
}

function getCachedChatActive(broadcasterId) {
  return getState(broadcasterId).chatActive;
}

module.exports = {
  shouldAttempt,
  noteResult,
  isRateLimited,
  rateLimitRetryAt,
  getCachedEvents,
  getCachedChatActive,
  COOLDOWN_MS,
  RATE_LIMIT_BACKOFF_MS,
  RETRY_MISSING_MS,
};
