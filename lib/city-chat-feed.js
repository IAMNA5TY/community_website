/**
 * Recent Kick chat per partner channel, kept in memory for the FiveM city's Kick hub.
 * The pusher monitor pushes every chat line here; the city polls
 * GET /api/channels/:streamer/city_chat?after=<id> only for channels a player has open.
 * Nothing is written to disk: after a redeploy the panel just starts empty.
 */
const PER_CHANNEL = 60;

const channels = new Map(); // slug -> [{ id, user, text, color, at, keyword }]
let seq = 0;

function slugOf(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function cleanText(content) {
  return String(content || "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\[emote:\d+:([^\]]+)\]/g, ":$1:")
    .trim()
    .slice(0, 200);
}

function push({ streamer, username, content, color, keyword, createdAt }) {
  const slug = slugOf(streamer);
  const text = cleanText(content);
  if (!slug || !username || !text) return null;
  seq += 1;
  const row = {
    id: seq,
    user: String(username).slice(0, 40),
    text,
    color: typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
    at: createdAt || new Date().toISOString(),
    keyword: keyword || null,
  };
  let list = channels.get(slug);
  if (!list) {
    list = [];
    channels.set(slug, list);
  }
  list.push(row);
  if (list.length > PER_CHANNEL) list.splice(0, list.length - PER_CHANNEL);
  return row;
}

/** Messages newer than `after` (oldest first). after=0 returns the last `limit`. */
function since(streamer, after = 0, limit = 30) {
  const list = channels.get(slugOf(streamer)) || [];
  const lim = Math.max(1, Math.min(PER_CHANNEL, Number(limit) || 30));
  const afterId = Number(after) || 0;
  const rows = afterId > 0 ? list.filter((row) => row.id > afterId) : list;
  return { messages: rows.slice(-lim), last: seq };
}

module.exports = { push, since };
