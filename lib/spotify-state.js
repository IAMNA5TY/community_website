const spotify = require("./spotify");
const spotifyEvents = require("./spotify-events");
const tokenStore = require("./token-store");

const CACHE_MS = 20000;
const REQUEST_COOLDOWN_MS = 45 * 1000;

const playbackCache = new Map();
const requestCooldowns = new Map();
const overlayMeta = new Map();

function getPrimaryBroadcasterId() {
  return tokenStore.getPrimaryBroadcasterId();
}

function setOverlayMeta(broadcasterUserId, patch) {
  const id = String(broadcasterUserId);
  const next = {
    ...(overlayMeta.get(id) || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  overlayMeta.set(id, next);
  return next;
}

function getOverlayMeta(broadcasterUserId) {
  return overlayMeta.get(String(broadcasterUserId)) || null;
}

function canRequest(broadcasterUserId, username) {
  const key = `${broadcasterUserId}:${String(username || "").toLowerCase()}`;
  const last = requestCooldowns.get(key) || 0;
  return Date.now() - last >= REQUEST_COOLDOWN_MS;
}

function markRequest(broadcasterUserId, username) {
  const key = `${broadcasterUserId}:${String(username || "").toLowerCase()}`;
  requestCooldowns.set(key, Date.now());
}

function cooldownSecondsLeft(broadcasterUserId, username) {
  const key = `${broadcasterUserId}:${String(username || "").toLowerCase()}`;
  const last = requestCooldowns.get(key) || 0;
  const left = REQUEST_COOLDOWN_MS - (Date.now() - last);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function buildPublicState(broadcasterUserId, playback, meta) {
  return {
    connected: Boolean(playback?.connected),
    isPlaying: Boolean(playback?.isPlaying),
    track: playback?.track || null,
    device: playback?.device || null,
    volume: playback?.volume ?? null,
    progressMs: playback?.progressMs || 0,
    error: playback?.error || null,
    lastRequest: meta?.lastRequest || null,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshPlayback(broadcasterUserId, { force = false } = {}) {
  const id = String(broadcasterUserId);
  const cached = playbackCache.get(id);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.state;
  }

  if (!spotify.getToken(id)) {
    const state = buildPublicState(id, { connected: false }, getOverlayMeta(id));
    playbackCache.set(id, { fetchedAt: Date.now(), state });
    return state;
  }

  try {
    const playback = await spotify.getPlaybackState(id);
    const state = buildPublicState(id, playback, getOverlayMeta(id));
    playbackCache.set(id, { fetchedAt: Date.now(), state });
    spotifyEvents.broadcastPlayback(state);
    return state;
  } catch (error) {
    const state = buildPublicState(
      id,
      { connected: true, isPlaying: false, track: null, error: error.message },
      getOverlayMeta(id)
    );
    playbackCache.set(id, { fetchedAt: Date.now(), state });
    return state;
  }
}

async function loadForBroadcaster(broadcasterUserId) {
  return refreshPlayback(broadcasterUserId);
}

async function loadForNowPlaying(broadcasterUserId) {
  const id = String(broadcasterUserId);
  const cached = playbackCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.state;
  }
  return refreshPlayback(broadcasterUserId);
}

function getCachedPlayback(broadcasterUserId) {
  const cached = playbackCache.get(String(broadcasterUserId));
  return cached?.state || null;
}

async function loadForDisplay() {
  const id = getPrimaryBroadcasterId();
  if (!id) {
    return {
      connected: false,
      isPlaying: false,
      track: null,
      error: "Sign in with Kick first",
    };
  }
  return loadForBroadcaster(id);
}

function noteQueuedRequest(broadcasterUserId, { username, trackName, artists }) {
  const meta = setOverlayMeta(broadcasterUserId, {
    lastRequest: {
      username,
      trackName,
      artists,
      at: new Date().toISOString(),
    },
  });
  const cached = playbackCache.get(String(broadcasterUserId));
  if (cached?.state) {
    cached.state.lastRequest = meta.lastRequest;
    spotifyEvents.broadcastPlayback(cached.state);
  }
  return meta;
}

module.exports = {
  loadForBroadcaster,
  loadForNowPlaying,
  loadForDisplay,
  refreshPlayback,
  getCachedPlayback,
  canRequest,
  markRequest,
  cooldownSecondsLeft,
  noteQueuedRequest,
  getPrimaryBroadcasterId,
};
