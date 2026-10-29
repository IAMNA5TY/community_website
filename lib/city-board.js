/**
 * Things the FiveM city (op_rewards server/sitestats.lua) tells the player site every few minutes:
 *   - prices: every chat word's Kick Points price (+ which ones chat can split into a pot)
 *   - board:  this week's top trollers, pot fillers and chatters
 * Saved to a small JSON file so a redeploy doesn't blank them until the next push.
 */
const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");
const { createDeferredJsonStore } = require("./deferred-json-store");

const FILE = path.join(getDataDir(), "city-board.json");

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (data && typeof data === "object") return { prices: data.prices || {}, board: data.board || null, season: data.season || null };
    }
  } catch { /* start fresh */ }
  return { prices: {}, board: null, season: null };
}

const store = createDeferredJsonStore({ path: FILE, load, flushMs: 2000, ensureDir: ensureDataDir });

const clean = (v, n = 40) => String(v || "").trim().replace(/^@/, "").toLowerCase().slice(0, n);
const int = (v) => Math.max(0, Math.floor(Number(v) || 0));

/** rows: [{ action, cost, pot, costs: { channel: n } }] */
function setPrices(rows, season) {
  const prices = {};
  for (const r of Array.isArray(rows) ? rows.slice(0, 300) : []) {
    const action = clean(r.action, 32);
    if (!action) continue;
    const costs = {};
    if (r.costs && typeof r.costs === "object") for (const [ch, c] of Object.entries(r.costs)) costs[clean(ch)] = int(c);
    prices[action] = { cost: int(r.cost), pot: Boolean(r.pot), ...(Object.keys(costs).length ? { costs } : {}) };
  }
  const data = store.get();
  store.set({ ...data, prices, season: season ? clean(season, 20) : null, pricesAt: new Date().toISOString() });
  return Object.keys(prices).length;
}

function priceOf(action) {
  return store.get().prices[clean(action, 32)] || null;
}

const list = (rows, keys) => (Array.isArray(rows) ? rows.slice(0, 10) : [])
  .map((r) => {
    const out = { name: clean(r.name) };
    for (const k of keys) out[k] = int(r[k]);
    return out;
  })
  .filter((r) => r.name);

function setBoard(body) {
  const board = {
    trollers: list(body?.trollers, ["points", "plays"]),
    pots: list(body?.pots, ["points", "pots"]),
    chatters: list(body?.chatters, ["messages"]),
    days: int(body?.days) || 7,
    updatedAt: new Date().toISOString(),
  };
  store.set({ ...store.get(), board });
  return board;
}

function getBoard() {
  return store.get().board;
}

module.exports = { setPrices, priceOf, setBoard, getBoard };
