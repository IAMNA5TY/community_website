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

function isDashboardOwner(user) {
  const profile = user?.profile || user;
  const id = profile?.id;
  if (!id) return false;
  return getOwnerBroadcasterIds().has(String(id));
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
  if (path.startsWith("/rewards/")) return true;
  return false;
}

module.exports = {
  PLAYER_PAGES,
  OWNER_PAGES,
  getOwnerBroadcasterIds,
  isDashboardOwner,
  getDashboardRole,
  getAllowedPages,
  isPlayerAllowedApiPath,
};
