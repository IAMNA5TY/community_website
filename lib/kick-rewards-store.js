const fs = require("fs");
const path = require("path");
const { parseChatControlAction } = require("./kick-chat-actions");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "kick-rewards.json");
const MAX_MESSAGES = 20000;
const MAX_CONTROL_EVENTS = 5000;

function defaultStore() {
  return {
    registrations: [],
    messages: [],
    controlEvents: [],
    gifts: [],
    nextControlId: 1,
  };
}

function readStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }

  try {
    return { ...defaultStore(), ...JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeStreamer(value) {
  return normalizeUsername(value);
}

function parseChannelMap() {
  const raw = String(process.env.KICK_REWARDS_CHANNELS || "na5ty:1183030").trim();
  const slugToId = new Map();
  const idToSlug = new Map();

  for (const part of raw.split(",")) {
    const [slug, id] = part.split(":").map((s) => s.trim());
    if (!slug) continue;
    const key = slug.toLowerCase();
    slugToId.set(key, id || null);
    if (id) idToSlug.set(String(id), key);
  }

  return { slugToId, idToSlug };
}

const channelMap = parseChannelMap();

function getMonitoredStreamers() {
  return [...channelMap.slugToId.keys()];
}

function getBroadcasterIdForSlug(slug) {
  return channelMap.slugToId.get(normalizeStreamer(slug)) || null;
}

function mergeStreamerSlugs(extraSlugs = []) {
  const merged = new Set(getMonitoredStreamers());
  for (const slug of extraSlugs) {
    const key = normalizeStreamer(slug);
    if (key) merged.add(key);
  }
  return [...merged];
}

function broadcasterIdToStreamer(broadcasterUserId) {
  const id = String(broadcasterUserId || "");
  if (channelMap.idToSlug.has(id)) {
    return channelMap.idToSlug.get(id);
  }
  if (id === String(process.env.DEFAULT_BROADCASTER_ID || "1183030")) {
    return "na5ty";
  }
  return null;
}

function trimStore(store) {
  if (store.messages.length > MAX_MESSAGES) {
    store.messages = store.messages.slice(-MAX_MESSAGES);
  }
  if (store.controlEvents.length > MAX_CONTROL_EVENTS) {
    store.controlEvents = store.controlEvents.slice(-MAX_CONTROL_EVENTS);
  }
}

function recordChatMessage({ streamer, username, content, createdAt = new Date().toISOString() }) {
  const streamerSlug = normalizeStreamer(streamer);
  const chatter = normalizeUsername(username);
  const text = String(content || "").trim();
  if (!streamerSlug || !chatter || !text) return null;

  const store = readStore();
  store.messages.push({
    streamer: streamerSlug,
    username: chatter,
    content: text,
    createdAt,
  });

  const control = parseChatControlAction(text);
  let controlEvent = null;
  if (control) {
    controlEvent = {
      id: store.nextControlId++,
      streamer: streamerSlug,
      chatter_username: chatter,
      action: control.action,
      message: control.message,
      content: control.message,
      createdAt,
    };
    store.controlEvents.push(controlEvent);
  }

  trimStore(store);
  writeStore(store);
  return { controlEvent };
}

function recordKicksGifted({ streamer, donor, amount, createdAt = new Date().toISOString() }) {
  const streamerSlug = normalizeStreamer(streamer);
  const donorName = normalizeUsername(donor);
  const kicks = Math.max(0, Math.floor(Number(amount) || 0));
  if (!streamerSlug || !donorName || kicks < 1) return;

  const store = readStore();
  store.gifts.push({
    streamer: streamerSlug,
    donor: donorName,
    amount: kicks,
    currency: "KICK",
    createdAt,
  });
  trimStore(store);
  writeStore(store);
}

function generateLinkCode(store) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const taken = store.registrations.some(
      (row) => String(row.linkCode || "").toUpperCase() === code
    );
    if (!taken) return code;
  }
  throw new Error("Could not generate link code");
}

function ensureLinkCode(entry, store) {
  if (!entry.linkCode) {
    entry.linkCode = generateLinkCode(store);
    entry.linkCodeCreatedAt = new Date().toISOString();
  }
  return entry.linkCode;
}

function registerKickUsername(kickUsername, meta = {}) {
  const username = normalizeUsername(kickUsername);
  if (!username) {
    throw new Error("Kick username is required");
  }

  const store = readStore();
  const existing = store.registrations.find((row) => row.kickUsername === username);
  if (existing) {
    existing.updatedAt = new Date().toISOString();
    if (meta.displayName) existing.displayName = String(meta.displayName).trim();
    if (meta.gameLicense) existing.gameLicense = String(meta.gameLicense).trim();
    ensureLinkCode(existing, store);
    writeStore(store);
    return existing;
  }

  const entry = {
    kickUsername: username,
    displayName: meta.displayName ? String(meta.displayName).trim() : username,
    gameLicense: meta.gameLicense ? String(meta.gameLicense).trim() : null,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ensureLinkCode(entry, store);
  store.registrations.push(entry);
  writeStore(store);
  return entry;
}

function linkGameLicense(linkCode, gameLicense) {
  const code = String(linkCode || "")
    .trim()
    .toUpperCase();
  const license = String(gameLicense || "").trim();
  if (!code || code.length < 6) {
    throw new Error("Invalid link code");
  }
  if (!license) {
    throw new Error("Game license required");
  }

  const store = readStore();
  const entry = store.registrations.find(
    (row) => String(row.linkCode || "").toUpperCase() === code
  );
  if (!entry) {
    throw new Error("Link code not found — register at na5ty.com first");
  }

  if (entry.gameLicense === license) {
    return entry;
  }

  const licenseTaken = store.registrations.find(
    (row) => row.gameLicense === license && row.kickUsername !== entry.kickUsername
  );
  if (licenseTaken) {
    throw new Error("This game account is already linked to another Kick username");
  }

  const kickLinkedElsewhere = store.registrations.find(
    (row) =>
      row.kickUsername === entry.kickUsername &&
      row.gameLicense &&
      row.gameLicense !== license
  );
  if (kickLinkedElsewhere) {
    throw new Error("This Kick username is already linked to another game account");
  }

  entry.gameLicense = license;
  entry.linkedAt = new Date().toISOString();
  entry.updatedAt = new Date().toISOString();
  writeStore(store);
  return entry;
}

function getRegistrationByLicense(gameLicense) {
  const license = String(gameLicense || "").trim();
  if (!license) return null;
  const store = readStore();
  return store.registrations.find((row) => row.gameLicense === license) || null;
}

function getRegistration(kickUsername) {
  const username = normalizeUsername(kickUsername);
  const store = readStore();
  return store.registrations.find((row) => row.kickUsername === username) || null;
}

function listRegistrations() {
  return readStore().registrations.slice().sort((a, b) => a.kickUsername.localeCompare(b.kickUsername));
}

function sinceMs(hours) {
  const h = Math.max(0, Number(hours) || 0);
  if (!h) return 0;
  return Date.now() - h * 60 * 60 * 1000;
}

function getChatters(streamer, { hours = 24, limit = 200 } = {}) {
  const streamerSlug = normalizeStreamer(streamer);
  const store = readStore();
  const cutoff = sinceMs(hours);
  const counts = new Map();
  const keywords = new Map();

  for (const row of store.messages) {
    if (row.streamer !== streamerSlug) continue;
    if (cutoff && new Date(row.createdAt).getTime() < cutoff) continue;

    const user = row.username;
    counts.set(user, (counts.get(user) || 0) + 1);

    const control = parseChatControlAction(row.content);
    if (control?.action) {
      if (!keywords.has(user)) keywords.set(user, {});
      const bag = keywords.get(user);
      bag[control.action] = (bag[control.action] || 0) + 1;
    }
  }

  const chatters = [...counts.entries()]
    .map(([username, message_count]) => ({
      username,
      message_count,
      keywords: keywords.get(username) || {},
    }))
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));

  return {
    success: true,
    streamer: streamerSlug,
    hours,
    chatters,
  };
}

function getControlEvents(streamer, { afterId = 0, limit = 20, init = false } = {}) {
  const streamerSlug = normalizeStreamer(streamer);
  const store = readStore();
  const eventsForStreamer = store.controlEvents.filter((row) => row.streamer === streamerSlug);
  const maxId = eventsForStreamer.reduce((max, row) => Math.max(max, row.id || 0), 0);

  if (init) {
    return {
      success: true,
      bootstrap: true,
      cursor: maxId,
    };
  }

  const after = Math.max(0, Number(afterId) || 0);
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const events = eventsForStreamer
    .filter((row) => (row.id || 0) > after)
    .sort((a, b) => (a.id || 0) - (b.id || 0))
    .slice(0, lim)
    .map((row) => ({
      id: row.id,
      chatter_username: row.chatter_username,
      action: row.action,
      message: row.message,
      content: row.content || row.message,
      created_at: row.createdAt,
    }));

  const cursor = events.length
    ? Math.max(after, events[events.length - 1].id || 0)
    : Math.max(after, maxId);

  return {
    success: true,
    cursor,
    events,
  };
}

function sumGiftKicks(streamer, donor, hours = 0) {
  const streamerSlug = normalizeStreamer(streamer);
  const donorName = normalizeUsername(donor);
  const cutoff = sinceMs(hours);
  const store = readStore();

  const total = store.gifts.reduce((sum, row) => {
    if (row.streamer !== streamerSlug || row.donor !== donorName) return sum;
    if (cutoff && new Date(row.createdAt).getTime() < cutoff) return sum;
    return sum + Math.max(0, Number(row.amount) || 0);
  }, 0);

  return {
    success: true,
    streamer: streamerSlug,
    donor: donorName,
    hours,
    total_kicks: total,
    total: total,
  };
}

function getViewerEarnTotals(streamer, donor) {
  const gift = sumGiftKicks(streamer, donor, 0);
  return {
    success: true,
    donor: gift.donor,
    streamer: gift.streamer,
    total_kicks: gift.total_kicks,
    total_kick_currency: gift.total_kicks,
    total_usd: 0,
    usd_total: 0,
  };
}

function getStats() {
  const store = readStore();
  const cutoff = sinceMs(24);
  const messagesLast24h = store.messages.filter(
    (row) => new Date(row.createdAt).getTime() >= cutoff
  ).length;

  return {
    messages_last_24h: messagesLast24h,
    monitored_streamers: getMonitoredStreamers().length,
    registrations: store.registrations.length,
  };
}

function getRewardsSummary(kickUsername) {
  const username = normalizeUsername(kickUsername);
  const store = readStore();
  const byStreamer = {};

  for (const streamer of getMonitoredStreamers()) {
    const chatters = getChatters(streamer, { hours: 24, limit: 500 });
    const row = chatters.chatters.find((c) => c.username === username);
    byStreamer[streamer] = {
      message_count_24h: row?.message_count || 0,
      keywords_24h: row?.keywords || {},
      gift_kicks_all_time: sumGiftKicks(streamer, username, 0).total_kicks,
    };
  }

  return {
    kickUsername: username,
    registered: Boolean(getRegistration(username)),
    streamers: byStreamer,
  };
}

module.exports = {
  registerKickUsername,
  linkGameLicense,
  getRegistrationByLicense,
  getRegistration,
  listRegistrations,
  recordChatMessage,
  recordKicksGifted,
  getChatters,
  getControlEvents,
  sumGiftKicks,
  getViewerEarnTotals,
  getMonitoredStreamers,
  getBroadcasterIdForSlug,
  mergeStreamerSlugs,
  broadcasterIdToStreamer,
  getStats,
  getRewardsSummary,
};
