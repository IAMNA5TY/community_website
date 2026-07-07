const COOLDOWN_MS = 10 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const RETRY_MISSING_MS = 2 * 60 * 1000;

const stateByBroadcaster = new Map();

function getState(broadcasterId) {
  const key = String(broadcasterId || "");
  if (!stateByBroadcaster.has(key)) {
    stateByBroadcaster.set(key, {
      lastAttempt: 0,
      rateLimitedUntil: 0,
      lastEvents: [],
      chatActive: false,
    });
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

function noteResult(broadcasterId, { events = [], chatActive = false, error = null } = {}) {
  const state = getState(broadcasterId);
  state.lastAttempt = Date.now();
  state.lastEvents = events;
  state.chatActive = Boolean(chatActive);
  if (error && /rate limit/i.test(String(error))) {
    state.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
  }
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
};
