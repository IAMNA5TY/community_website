const { channelList } = require("./twitch-irc");

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function houseTwitchLogins() {
  return channelList(
    process.env.TWITCH_CHAT_CHANNELS || process.env.TWITCH_CHAT_CHANNEL || "iamna5ty"
  );
}

function offlineTestLogins() {
  const extra = String(
    process.env.TWITCH_OFFLINE_TEST_USERNAMES ||
      process.env.OWNER_TWITCH_USERNAMES ||
      "iamna5ty"
  )
    .split(",")
    .map(normalizeLogin)
    .filter(Boolean);
  const owners = String(process.env.OWNER_KICK_USERNAMES || "na5ty,pipsturr")
    .split(",")
    .map(normalizeLogin)
    .filter(Boolean);
  return new Set([...houseTwitchLogins(), ...extra, ...owners]);
}

function isOfflineTestBypass(username) {
  const login = normalizeLogin(username);
  if (!login) return false;
  if (offlineTestLogins().has(login)) return true;
  try {
    const mapped = require("./kick-rewards-store").resolveLinkedUsername(login);
    return Boolean(mapped && offlineTestLogins().has(mapped));
  } catch {
    return false;
  }
}

async function isHouseTwitchLive() {
  if (String(process.env.TWITCH_CITY_REQUIRE_LIVE || "1") === "0") {
    return { live: true, reason: "live-gate-disabled" };
  }
  const login = houseTwitchLogins()[0] || "iamna5ty";
  try {
    const status = await require("./twitch-live").getLiveStatus(login);
    return {
      live: Boolean(status?.isLive),
      login,
      reason: status?.isLive ? "live" : "offline",
    };
  } catch (error) {
    return {
      live: false,
      login,
      reason: "live-check-failed",
      error: error.message,
    };
  }
}

async function canUseTwitchCityChat(username) {
  const login = normalizeLogin(username);
  if (isOfflineTestBypass(login)) {
    return { ok: true, reason: "owner-test", username: login };
  }
  const live = await isHouseTwitchLive();
  if (live.live) {
    return { ok: true, reason: live.reason, username: login, channel: live.login };
  }
  return {
    ok: false,
    reason: live.reason || "offline",
    username: login,
    channel: live.login,
  };
}

module.exports = {
  normalizeLogin,
  houseTwitchLogins,
  offlineTestLogins,
  isOfflineTestBypass,
  isHouseTwitchLive,
  canUseTwitchCityChat,
};
