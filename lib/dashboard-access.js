const PLAYER_PAGES = ["city", "profile", "streamers", "overview", "channel", "only-pixels", "discord"];

const OWNER_PAGES = [
  "city",
  "profile",
  "streamers",
  "overview",
  "channel",
  "only-pixels",
  "discord",
  "workout",
  "slots",
  "drinking",
  "widgets",
  "lighting",
  "stake",
  "bot",
  "chat",
  "rewards",
  "leaderboard",
  "settings",
];

/** Twitch sessions cannot call Kick APIs — keep tools that work without Kick OAuth. */
const TWITCH_PLAYER_PAGES = ["profile", "streamers"];
const TWITCH_OWNER_PAGES = [
  "profile",
  "streamers",
  "widgets",
  "workout",
  "slots",
  "drinking",
  "lighting",
  "stake",
  "settings",
];

function getOwnerBroadcasterIds() {
  const raw = String(
    process.env.OWNER_BROADCASTER_IDS || process.env.DEFAULT_BROADCASTER_ID || "1183030"
  ).trim();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function getOwnerKickUsernames() {
  // Comma-separated Kick usernames with full dashboard access (same tabs as na5ty).
  const raw = String(
    process.env.OWNER_KICK_USERNAMES || "na5ty,pipsturr"
  ).trim();
  return new Set(
    raw
      .split(",")
      .map((name) => String(name || "").trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean)
  );
}

function getOwnerTwitchUsernames() {
  const raw = String(process.env.OWNER_TWITCH_USERNAMES || "").trim();
  return new Set(
    raw
      .split(",")
      .map((name) => String(name || "").trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean)
  );
}

function getOwnerTwitchUserIds() {
  const raw = String(process.env.OWNER_TWITCH_USER_IDS || "").trim();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function getPartnerStaffKickUsernames() {
  const raw = String(process.env.PARTNER_STAFF_KICK_USERNAMES || "na5ty").trim();
  return new Set(
    raw
      .split(",")
      .map((name) => String(name || "").trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean)
  );
}

function getKickUsername(user) {
  const profile = user?.profile || user;
  return String(profile?.username || profile?.name || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function isDashboardOwner(user) {
  const profile = user?.profile || user;
  const provider = String(user?.provider || "kick").toLowerCase();
  const id = profile?.id;

  if (provider === "twitch") {
    if (id && getOwnerTwitchUserIds().has(String(id))) return true;
    const username = getKickUsername(user);
    if (username && getOwnerTwitchUsernames().has(username)) return true;
    return false;
  }

  if (id && getOwnerBroadcasterIds().has(String(id))) {
    return true;
  }
  const username = getKickUsername(user);
  if (username && getOwnerKickUsernames().has(username)) {
    return true;
  }
  return false;
}

function isPartnerStaff(user) {
  if (String(user?.provider || "kick").toLowerCase() === "twitch") return false;
  const username = getKickUsername(user);
  return Boolean(username && getPartnerStaffKickUsernames().has(username));
}

function getDashboardRole(user) {
  return isDashboardOwner(user) ? "owner" : "player";
}

function isLocalDashboardHost(host) {
  const hostname = String(host || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function getAllowedPages(user, options = {}) {
  const provider = String(user?.provider || "kick").toLowerCase();
  let pages;
  if (provider === "twitch") {
    pages = isDashboardOwner(user)
      ? TWITCH_OWNER_PAGES.slice()
      : TWITCH_PLAYER_PAGES.slice();
  } else {
    pages = isDashboardOwner(user) ? OWNER_PAGES.slice() : PLAYER_PAGES.slice();
  }

  // Hue/Govee need the stream PC LAN — hide Lighting on the public site.
  const host =
    options.host ||
    options.hostname ||
    (typeof options.req?.hostname === "string" ? options.req.hostname : "");
  if (!isLocalDashboardHost(host)) {
    pages = pages.filter((page) => page !== "lighting");
  }

  return pages;
}

function isPlayerAllowedApiPath(apiPath) {
  const path = String(apiPath || "").replace(/\/+$/, "") || "/";
  if (path === "/me" || path === "/dashboard" || path === "/city") return true;
  if (path.startsWith("/rewards/partners")) return false;
  if (path.startsWith("/rewards/")) return true;
  if (path.startsWith("/discord")) return true;
  return false;
}

module.exports = {
  PLAYER_PAGES,
  OWNER_PAGES,
  TWITCH_PLAYER_PAGES,
  TWITCH_OWNER_PAGES,
  getOwnerBroadcasterIds,
  getOwnerKickUsernames,
  getOwnerTwitchUsernames,
  getOwnerTwitchUserIds,
  getPartnerStaffKickUsernames,
  getKickUsername,
  isDashboardOwner,
  isPartnerStaff,
  getDashboardRole,
  isLocalDashboardHost,
  getAllowedPages,
  isPlayerAllowedApiPath,
};
