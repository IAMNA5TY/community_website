const fs = require("fs");
const path = require("path");
const kickApi = require("./kick");
const tokenStore = require("./token-store");
const slotsState = require("./slots-state");

const CACHE_PATH = path.join(__dirname, "..", "data", "slots-profile-cache.json");
const DEFAULT_AVATAR =
  "https://kick.com/img/default-profile-pictures/default-avatar-2.webp";

function readCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function extractSenderMeta(sender = {}) {
  return {
    userId: sender.user_id || sender.userId ? String(sender.user_id || sender.userId) : null,
    profilePicture: sender.profile_picture || sender.profilePicture || null,
    username: sender.username || null,
  };
}

function rememberProfile({ userId, profilePicture, username }) {
  if (!userId && !username) return;

  const cache = readCache();
  const key = userId || `name:${String(username).toLowerCase()}`;
  const existing = cache[key] || {};

  cache[key] = {
    userId: userId || existing.userId || null,
    username: username || existing.username || null,
    profilePicture: profilePicture || existing.profilePicture || null,
    updatedAt: new Date().toISOString(),
  };

  writeCache(cache);
}

function lookupCachedProfile(entry) {
  const cache = readCache();
  if (entry.userId && cache[entry.userId]?.profilePicture) {
    return cache[entry.userId].profilePicture;
  }

  if (entry.username) {
    const byName = cache[`name:${String(entry.username).toLowerCase()}`];
    if (byName?.profilePicture) {
      return byName.profilePicture;
    }
  }

  return entry.profilePicture || null;
}

function applyProfileToEntry(entry) {
  const profilePicture = lookupCachedProfile(entry) || entry.profilePicture || DEFAULT_AVATAR;
  return {
    ...entry,
    profilePicture,
  };
}

async function getBroadcasterAccessToken(broadcasterUserId, kickConfig) {
  const stored = tokenStore.getBroadcasterToken(broadcasterUserId);
  if (!stored?.accessToken) {
    return null;
  }

  const expiresSoon =
    stored.expiresAt && stored.expiresAt - Date.now() < 2 * 60 * 1000;

  if (!expiresSoon || !stored.refreshToken) {
    return stored.accessToken;
  }

  const tokens = await kickApi.refreshTokens(kickConfig, stored.refreshToken);
  tokenStore.updateBroadcasterToken(broadcasterUserId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || stored.refreshToken,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : stored.expiresAt,
  });

  return tokens.access_token;
}

async function fetchMissingProfiles(userIds, kickConfig, broadcasterUserId) {
  const missing = [...new Set(userIds.filter(Boolean))];
  if (!missing.length) {
    return;
  }

  const accessToken = await getBroadcasterAccessToken(broadcasterUserId, kickConfig);
  if (!accessToken) {
    return;
  }

  const users = await kickApi.getUsers(accessToken, missing);
  for (const user of users) {
    rememberProfile({
      userId: String(user.user_id),
      profilePicture: user.profile_picture,
      username: user.name,
    });
  }
}

function enrichPickInState(state) {
  if (!state?.lastPick) {
    return state;
  }

  state.lastPick = applyProfileToEntry(state.lastPick);
  if (Array.isArray(state.lastPick.spinPool)) {
    state.lastPick.spinPool = state.lastPick.spinPool.map(applyProfileToEntry);
  }

  return state;
}

async function enrichSlotsPick(state, kickConfig, broadcasterUserId) {
  if (!state?.lastPick) {
    return state;
  }

  const entries = [
    state.lastPick,
    ...(state.lastPick.spinPool || []),
  ];

  const missingIds = [
    ...new Set(
      entries
        .filter((entry) => entry.userId && !lookupCachedProfile(entry))
        .map((entry) => entry.userId)
    ),
  ];

  if (missingIds.length) {
    await fetchMissingProfiles(missingIds, kickConfig, broadcasterUserId);
  }

  enrichPickInState(state);
  slotsState.save(state);
  return state;
}

module.exports = {
  DEFAULT_AVATAR,
  extractSenderMeta,
  rememberProfile,
  lookupCachedProfile,
  applyProfileToEntry,
  enrichSlotsPick,
};
