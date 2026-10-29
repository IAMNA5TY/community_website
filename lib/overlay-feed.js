/**
 * Partner OBS overlay feed (public/overlay/city.html?channel=<kick>).
 * The FiveM city (op_rewards server/siteoverlay.lua) posts what chat did in the city about once a second:
 * plays, pot chip-ins / fires / refunds, tips, donations. Kept in memory only, per channel.
 * The overlay polls GET /api/rewards/overlay/:channel?after=<id>; its first call only learns the cursor
 * and the open pot, so old alerts never replay when OBS reloads the source.
 */
const PER_CHANNEL = 40;
const POT_TTL_MS = 4 * 60 * 1000;
const KINDS = new Set(["play", "pot_open", "pot_add", "pot_fire", "pot_refund", "tip", "donate", "dailymech", "coke"]);

const channels = new Map(); // slug -> { list: [], pot: null }
let seq = 0;

const slugOf = (v) => String(v || "").trim().replace(/^@/, "").toLowerCase().slice(0, 40);
const str = (v, n = 40) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

function entry(slug) {
  let c = channels.get(slug);
  if (!c) { c = { list: [], pot: null }; channels.set(slug, c); }
  return c;
}

function push(events) {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const e of events.slice(0, 300)) {
    const slug = slugOf(e && e.channel);
    if (!slug || !KINDS.has(e.kind)) continue;
    seq += 1;
    const row = {
      id: seq, kind: e.kind, action: str(e.action), label: str(e.label, 60), group: str(e.group, 20),
      viewer: str(e.viewer), price: num(e.price), take: num(e.take), filled: num(e.filled),
      contributors: num(e.contributors), amount: num(e.amount), free: e.free ? true : undefined,
      reason: str(e.reason, 20), at: Date.now(),
    };
    const c = entry(slug);
    c.list.push(row);
    if (c.list.length > PER_CHANNEL) c.list.splice(0, c.list.length - PER_CHANNEL);
    if (row.kind === "pot_open" || row.kind === "pot_add") {
      c.pot = { action: row.action, label: row.label, filled: row.filled, price: row.price, contributors: row.contributors, at: row.at };
    } else if (row.kind === "pot_fire" || row.kind === "pot_refund") {
      c.pot = null;
    }
    n += 1;
  }
  return n;
}

function since(channel, after = 0) {
  const c = channels.get(slugOf(channel));
  if (c && c.pot && Date.now() - c.pot.at > POT_TTL_MS) c.pot = null;
  const afterId = Number(after) || 0;
  const events = !c || afterId <= 0 ? [] : c.list.filter((r) => r.id > afterId).slice(-15);
  return { events, pot: c ? c.pot : null, last: seq };
}

module.exports = { push, since };
