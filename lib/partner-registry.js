const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");

const STORE_PATH = path.join(getDataDir(), "kick-partners.json");
const VALID_STATUSES = new Set(["pending", "approved", "banned"]);

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function defaultStore() {
  return { applications: [], audit: [] };
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return defaultStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      applications: Array.isArray(parsed.applications) ? parsed.applications : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function publicApplication(row) {
  if (!row) return null;
  return {
    kickUsername: row.kickUsername,
    displayName: row.displayName || row.kickUsername,
    broadcasterId: row.broadcasterId || null,
    status: row.status,
    appliedAt: row.appliedAt || null,
    updatedAt: row.updatedAt || null,
    moderatedAt: row.moderatedAt || null,
    moderatedBy: row.moderatedBy || null,
    reason: row.reason || null,
  };
}

function getApplication(kickUsername) {
  const username = normalizeUsername(kickUsername);
  return publicApplication(
    readStore().applications.find((row) => row.kickUsername === username)
  );
}

function listApplications() {
  return readStore()
    .applications.map(publicApplication)
    .sort((a, b) => {
      const order = { pending: 0, approved: 1, banned: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
        a.kickUsername.localeCompare(b.kickUsername);
    });
}

function apply({ kickUsername, displayName, broadcasterId }) {
  const username = normalizeUsername(kickUsername);
  if (!username) throw new Error("Kick username is required");

  const store = readStore();
  const now = new Date().toISOString();
  let row = store.applications.find((item) => item.kickUsername === username);
  if (row) {
    row.displayName = String(displayName || row.displayName || username).trim();
    if (broadcasterId) row.broadcasterId = String(broadcasterId);
    row.updatedAt = now;
    // Registering again never bypasses a staff ban or revokes an approval.
  } else {
    row = {
      kickUsername: username,
      displayName: String(displayName || username).trim(),
      broadcasterId: broadcasterId ? String(broadcasterId) : null,
      status: "pending",
      appliedAt: now,
      updatedAt: now,
      moderatedAt: null,
      moderatedBy: null,
      reason: null,
    };
    store.applications.push(row);
  }
  writeStore(store);
  return publicApplication(row);
}

function moderate(kickUsername, status, { staffUsername, reason, broadcasterId } = {}) {
  const username = normalizeUsername(kickUsername);
  const nextStatus = String(status || "").toLowerCase();
  if (!username) throw new Error("Kick username is required");
  if (!VALID_STATUSES.has(nextStatus)) throw new Error("Invalid partner status");

  const store = readStore();
  const row = store.applications.find((item) => item.kickUsername === username);
  if (!row) throw new Error("Partner application not found");

  const now = new Date().toISOString();
  const previousStatus = row.status;
  row.status = nextStatus;
  row.updatedAt = now;
  row.moderatedAt = now;
  row.moderatedBy = normalizeUsername(staffUsername) || "staff";
  row.reason = nextStatus === "banned" ? String(reason || "").trim() || null : null;
  if (broadcasterId) row.broadcasterId = String(broadcasterId);

  store.audit.push({
    kickUsername: username,
    from: previousStatus,
    to: nextStatus,
    staffUsername: row.moderatedBy,
    reason: row.reason,
    createdAt: now,
  });
  if (store.audit.length > 2000) store.audit = store.audit.slice(-2000);
  writeStore(store);
  return publicApplication(row);
}

function setBroadcasterId(kickUsername, broadcasterId) {
  const username = normalizeUsername(kickUsername);
  if (!username || !broadcasterId) return getApplication(username);
  const store = readStore();
  const row = store.applications.find((item) => item.kickUsername === username);
  if (!row) return null;
  row.broadcasterId = String(broadcasterId);
  row.updatedAt = new Date().toISOString();
  writeStore(store);
  return publicApplication(row);
}

function hasStatus(kickUsername, status) {
  return getApplication(kickUsername)?.status === status;
}

module.exports = {
  normalizeUsername,
  apply,
  moderate,
  setBroadcasterId,
  getApplication,
  listApplications,
  isApproved: (username) => hasStatus(username, "approved"),
  isBanned: (username) => hasStatus(username, "banned"),
};
