/**
 * Kick Points as the FiveM city sees them (op_rewards wallets: rollover + cap).
 * The city pushes balances when they change (POST /api/city/wallets); the player site
 * shows "Your Kick Points" from here so the number matches the in-game Kick hub.
 */
const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");
const { createDeferredJsonStore } = require("./deferred-json-store");

const FILE = path.join(getDataDir(), "city-wallets.json");

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (data && typeof data.viewers === "object") return data;
    }
  } catch { /* start fresh */ }
  return { viewers: {}, cap: 1000, updatedAt: null };
}

const store = createDeferredJsonStore({ path: FILE, load, flushMs: 3000, ensureDir: ensureDataDir });

const clean = (v) => String(v || "").trim().replace(/^@/, "").toLowerCase();

/** rows: [{ viewer, channel, balance }] */
function upsert(rows, { cap } = {}) {
  const data = store.get();
  let n = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const viewer = clean(row.viewer);
    const channel = clean(row.channel);
    if (!viewer || !channel || viewer.length > 40 || channel.length > 40) continue;
    const balance = Math.max(0, Math.floor(Number(row.balance) || 0));
    const wallets = data.viewers[viewer] || (data.viewers[viewer] = {});
    if (balance > 0) wallets[channel] = balance;
    else delete wallets[channel];
    if (!Object.keys(wallets).length) delete data.viewers[viewer];
    n += 1;
  }
  if (Number(cap) > 0) data.cap = Math.floor(Number(cap));
  data.updatedAt = new Date().toISOString();
  store.set(data);
  return n;
}

function forViewer(kickUsername) {
  const data = store.get();
  const wallets = data.viewers[clean(kickUsername)] || {};
  return {
    cap: data.cap || 1000,
    updatedAt: data.updatedAt,
    wallets: Object.entries(wallets)
      .map(([channel, balance]) => ({ channel, balance }))
      .sort((a, b) => b.balance - a.balance),
  };
}

module.exports = { upsert, forViewer };
