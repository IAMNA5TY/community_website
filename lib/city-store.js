const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");

const STORE_PATH = path.join(getDataDir(), "city-snapshot.json");
const STALE_AFTER_MS = 45 * 1000;
const MAX_PLAYERS = 256;

let snapshot = readSnapshot();

function emptySnapshot() {
  return {
    serverName: "Only Pixels",
    playerCount: 0,
    maxPlayers: 0,
    linkedCount: 0,
    liveCount: 0,
    updatedAt: 0,
    players: [],
  };
}

function readSnapshot() {
  if (!fs.existsSync(STORE_PATH)) return emptySnapshot();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return sanitizeSnapshot(parsed);
  } catch {
    return emptySnapshot();
  }
}

function writeSnapshot(next) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2));
}

function cleanText(value, fallback = "") {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80);
  return text || fallback;
}

function normalizeKick(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .slice(0, 40);
}

function compactKick(value) {
  return normalizeKick(value).replace(/[_-]/g, "");
}

function kickNamesMatch(left, right) {
  const a = normalizeKick(left);
  const b = normalizeKick(right);
  if (!a || !b) return false;
  return a === b || compactKick(a) === compactKick(b);
}

function looksLikeKickSlug(value) {
  const slug = normalizeKick(value);
  return Boolean(slug && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(slug));
}

function pickKickUsername(row) {
  const candidates = [
    row.kickUsername,
    row.kick_username,
    row.kickName,
    row.kick_name,
    row.KickUsername,
    row.kickUser,
    row.kick_user,
    row.kick,
  ];
  for (const value of candidates) {
    if (looksLikeKickSlug(value)) return normalizeKick(value);
  }
  return "";
}

function sanitizePlayer(row) {
  if (!row || typeof row !== "object") return null;
  const name = cleanText(row.name || row.character || row.charName, "Unknown");
  const kickUsername = pickKickUsername(row);
  return {
    name,
    job: cleanText(row.job || row.jobLabel || row.job_label, "Unemployed"),
    kickUsername: kickUsername || null,
    accountType:
      cleanText(row.accountType || row.account_type || row.role || row.type).toLowerCase() ||
      null,
    live: Boolean(row.live || row.isLive || row.is_live || row.streaming),
  };
}

function sanitizeSnapshot(raw) {
  const players = Array.isArray(raw?.players)
    ? raw.players.map(sanitizePlayer).filter(Boolean).slice(0, MAX_PLAYERS)
    : [];
  const linkedCount = players.filter((player) => player.kickUsername).length;
  const liveCount = players.filter((player) => player.live).length;
  return {
    serverName: cleanText(raw?.serverName || raw?.server, "Only Pixels"),
    playerCount: Number.isFinite(Number(raw?.playerCount))
      ? Math.max(0, Math.min(MAX_PLAYERS, Number(raw.playerCount)))
      : players.length,
    maxPlayers: Number.isFinite(Number(raw?.maxPlayers))
      ? Math.max(0, Math.min(1024, Number(raw.maxPlayers)))
      : 0,
    linkedCount: Number.isFinite(Number(raw?.linkedCount))
      ? Number(raw.linkedCount)
      : linkedCount,
    liveCount: Number.isFinite(Number(raw?.liveCount)) ? Number(raw.liveCount) : liveCount,
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    players,
  };
}

function saveSnapshot(raw) {
  snapshot = sanitizeSnapshot({
    ...raw,
    updatedAt: Number(raw?.updatedAt) || Date.now(),
  });
  writeSnapshot(snapshot);
  return snapshot;
}

function getSnapshot() {
  return snapshot;
}

function isConnected(now = Date.now()) {
  return Boolean(snapshot?.updatedAt) && now - Number(snapshot.updatedAt) < STALE_AFTER_MS;
}

function publicPlayer(player) {
  return {
    name: player.name,
    kickUsername: player.kickUsername,
    live: Boolean(player.live),
    accountType: player.accountType,
  };
}

function staffPlayer(player) {
  return {
    ...publicPlayer(player),
    job: player.job,
  };
}

function getPublicCityView() {
  const view = getCityView({ kickUsername: "", isStaff: false });
  return {
    success: true,
    public: true,
    connected: view.connected,
    serverName: view.serverName,
    liveCount: view.liveCount,
    updatedAt: view.updatedAt,
    liveStreamers: (view.liveStreamers || []).map((player) => ({
      name: player.name,
      kickUsername: player.kickUsername,
      live: Boolean(player.live),
    })),
  };
}

function getCityView({ kickUsername, isStaff }) {
  const mineName = normalizeKick(kickUsername);
  const players = snapshot.players || [];
  const mine = mineName
    ? players.find((player) => kickNamesMatch(player.kickUsername, mineName))
    : null;
  const me = mine ? staffPlayer(mine) : null;
  const liveStreamers = players.filter((player) => player.live).map(publicPlayer);

  const view = {
    success: true,
    connected: isConnected(),
    serverName: snapshot.serverName,
    updatedAt: snapshot.updatedAt || null,
    me,
    liveStreamers,
    liveCount: liveStreamers.length,
  };

  if (isStaff) {
    view.playerCount = snapshot.playerCount || players.length;
    view.maxPlayers = snapshot.maxPlayers || 0;
    view.linkedCount =
      snapshot.linkedCount || players.filter((player) => player.kickUsername).length;
    view.liveCount = snapshot.liveCount || liveStreamers.length;
    view.players = players.map(staffPlayer);
  }

  return view;
}

function listLinkedStreamerSlugs() {
  const slugs = [];
  for (const player of snapshot.players || []) {
    const slug = normalizeKick(player.kickUsername);
    if (!slug) continue;
    const role = String(player.accountType || "").toLowerCase();
    if (player.live || role === "streamer" || role === "partner") {
      slugs.push(slug);
    }
  }
  return slugs;
}

module.exports = {
  saveSnapshot,
  getSnapshot,
  getCityView,
  getPublicCityView,
  isConnected,
  listLinkedStreamerSlugs,
  kickNamesMatch,
  normalizeKick,
};
