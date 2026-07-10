const PLAYER_PAGES = ["overview", "only-pixels"];

const OWNER_PAGES = [
  "overview",
  "only-pixels",
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

function isDashboardOwner(user) {
  const profile = user?.profile || user;
  const id = profile?.id;
  if (id && getOwnerBroadcasterIds().has(String(id))) {
    return true;
  }
  const username = String(profile?.username || profile?.name || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (username && getOwnerKickUsernames().has(username)) {
    return true;
  }
  return false;
}

function getDashboardRole(user) {
  return isDashboardOwner(user) ? "owner" : "player";
}

function getAllowedPages(user) {
  return isDashboardOwner(user) ? OWNER_PAGES.slice() : PLAYER_PAGES.slice();
}

function isPlayerAllowedApiPath(apiPath) {
  const path = String(apiPath || "").replace(/\/+$/, "") || "/";
  if (path === "/me" || path === "/dashboard") return true;
  if (path.startsWith("/rewards/partners")) return false;
  if (path.startsWith("/rewards/")) return true;
  return false;
}

module.exports = {
  PLAYER_PAGES,
  OWNER_PAGES,
  getOwnerBroadcasterIds,
  getOwnerKickUsernames,
  isDashboardOwner,
  getDashboardRole,
  getAllowedPages,
  isPlayerAllowedApiPath,
};
