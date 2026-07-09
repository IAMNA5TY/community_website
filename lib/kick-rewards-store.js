const fs = require("fs");
const path = require("path");
const { parseChatControlAction } = require("./kick-chat-actions");
const {
  getChatCommandsForStreamer,
  formatKeywordUsage,
} = require("./kick-chat-commands");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "kick-rewards.json");
const MAX_MESSAGES = 20000;
const MAX_CONTROL_EVENTS = 5000;

function defaultStore() {
  return {
    registrations: [],
    monitoredChannels: [],
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

function compactStreamerSlug(value) {
  return normalizeStreamer(value).replace(/[_-]/g, "");
}

function streamerSlugMatches(requested, stored) {
  return compactStreamerSlug(requested) === compactStreamerSlug(stored);
}

function resolveMonitoredSlugKey(apiSlug, knownSlugs) {
  const norm = normalizeStreamer(apiSlug);
  if (!norm) return null;
  for (const key of knownSlugs) {
    if (streamerSlugMatches(key, norm)) return key;
  }
  return knownSlugs.includes(norm) ? norm : null;
}

function parseEnvChannelMap() {
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

function getChannelMap() {
  const { slugToId, idToSlug } = parseEnvChannelMap();
  const store = readStore();

  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug) continue;
    const broadcasterId = row.broadcasterId ? String(row.broadcasterId) : null;
    if (!slugToId.has(slug) || broadcasterId) {
      slugToId.set(slug, broadcasterId || slugToId.get(slug) || null);
    }
    if (broadcasterId) {
      idToSlug.set(broadcasterId, slug);
    }
  }

  return { slugToId, idToSlug };
}

function getMonitoredStreamers() {
  const { slugToId } = getChannelMap();
  const merged = new Set(slugToId.keys());
  for (const slug of parsePartnerSlugList()) {
    merged.add(slug);
  }
  return [...merged];
}

function getBroadcasterIdForSlug(slug) {
  return getChannelMap().slugToId.get(normalizeStreamer(slug)) || null;
}

function getMonitoredBroadcasterIds() {
  const { slugToId } = getChannelMap();
  const ids = new Set();
  for (const broadcasterId of slugToId.values()) {
    if (broadcasterId) ids.add(String(broadcasterId));
  }
  return [...ids];
}

function isMonitoredStreamer(slug) {
  const key = normalizeStreamer(slug);
  return key ? getChannelMap().slugToId.has(key) : false;
}

function upsertMonitoredStreamer(slug, broadcasterId = null) {
  const normalized = normalizeStreamer(slug);
  if (!normalized) {
    throw new Error("Streamer slug is required");
  }

  const store = readStore();
  if (!Array.isArray(store.monitoredChannels)) {
    store.monitoredChannels = [];
  }

  const id = broadcasterId ? String(broadcasterId) : null;
  const existing = store.monitoredChannels.find(
    (row) => normalizeStreamer(row.slug) === normalized
  );

  if (existing) {
    if (id) existing.broadcasterId = id;
    existing.slug = normalized;
  } else {
    store.monitoredChannels.push({
      slug: normalized,
      broadcasterId: id,
      addedAt: new Date().toISOString(),
    });
  }

  writeStore(store);
  return { slug: normalized, broadcasterId: id || getBroadcasterIdForSlug(normalized) };
}

function replaceMonitoredStreamers(slugs, broadcasterIdsBySlug = {}) {
  const store = readStore();
  const existingBySlug = new Map();
  for (const row of store.monitoredChannels || []) {
    const key = normalizeStreamer(row.slug);
    if (key) existingBySlug.set(key, row);
  }

  const next = [];
  const seen = new Set();
  for (const raw of slugs || []) {
    const slug = normalizeStreamer(raw);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const prev = existingBySlug.get(slug);
    const resolvedId = broadcasterIdsBySlug[slug];
    next.push({
      slug,
      broadcasterId: prev?.broadcasterId
        ? String(prev.broadcasterId)
        : resolvedId
          ? String(resolvedId)
          : null,
      addedAt: prev?.addedAt || new Date().toISOString(),
    });
  }

  store.monitoredChannels = next;
  writeStore(store);
  return listMonitoredChannels();
}

function mergeMonitoredStreamers(slugs, broadcasterIdsBySlug = {}) {
  for (const raw of slugs || []) {
    const slug = normalizeStreamer(raw);
    if (!slug) continue;
    const resolvedId = broadcasterIdsBySlug[slug] || null;
    upsertMonitoredStreamer(slug, resolvedId);
  }
  return listMonitoredChannels();
}

function listMonitoredChannels() {
  const { slugToId } = getChannelMap();
  return getMonitoredStreamers().map((slug) => ({
    slug,
    broadcasterId: slugToId.get(slug) || null,
  }));
}

function resolveStreamerForWebhook(payload = {}, channelId = "") {
  const id = String(channelId || "");
  const fromId = broadcasterIdToStreamer(id);
  if (fromId) {
    return { slug: fromId, broadcasterId: id && id !== "unknown" ? id : null };
  }

  const slug = normalizeStreamer(
    payload.channel?.slug ||
      payload.broadcaster?.channel_slug ||
      payload.broadcaster?.username
  );

  if (slug && isMonitoredStreamer(slug)) {
    return {
      slug,
      broadcasterId: id && id !== "unknown" ? id : null,
    };
  }

  return null;
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
  const { idToSlug } = getChannelMap();
  if (idToSlug.has(id)) {
    return idToSlug.get(id);
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
    if (!streamerSlugMatches(streamerSlug, row.streamer)) continue;
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
  const eventsForStreamer = store.controlEvents.filter((row) =>
    streamerSlugMatches(streamerSlug, row.streamer)
  );
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

const DEFAULT_PARTNER_SLUGS = [
  "andy1993",
  "vikinggaming94",
  "d0sil",
  "devilmaykill579",
  "lonewolfclyde",
  "thunderrosegaming",
  "obgmedic",
];

function parsePartnerSlugList() {
  const slugs = new Set();
  const raw = String(process.env.KICK_REWARDS_CHANNELS || "na5ty:1183030").trim();
  for (const part of raw.split(",")) {
    const slug = part.split(":")[0]?.trim();
    if (slug) slugs.add(normalizeStreamer(slug));
  }
  for (const slug of DEFAULT_PARTNER_SLUGS) {
    slugs.add(normalizeStreamer(slug));
  }
  const extra = String(process.env.KICK_REWARD_PARTNER_SLUGS || "").trim();
  for (const part of extra.split(",")) {
    const slug = part.trim();
    if (slug) slugs.add(normalizeStreamer(slug));
  }
  return [...slugs];
}

function getStreamersWithRecentMessages(hours = 24) {
  const store = readStore();
  const cutoff = sinceMs(hours);
  const slugs = new Set();
  for (const row of store.messages) {
    if (cutoff && new Date(row.createdAt).getTime() < cutoff) continue;
    const slug = normalizeStreamer(row.streamer);
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

function getRewardsScanStreamers(hours = 24) {
  const merged = new Set(getMonitoredStreamers());
  for (const slug of getStreamersWithRecentMessages(hours)) {
    merged.add(slug);
  }
  return [...merged];
}

function ensureDefaultPartners() {
  const added = [];
  for (const slug of parsePartnerSlugList()) {
    added.push(upsertMonitoredStreamer(slug));
  }
  return added;
}

function getRecentMessages(streamer, { hours = 24, limit = 50 } = {}) {
  const streamerSlug = normalizeStreamer(streamer);
  const cutoff = sinceMs(hours);
  const store = readStore();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  return store.messages
    .filter((row) => streamerSlugMatches(streamerSlug, row.streamer))
    .filter((row) => !cutoff || new Date(row.createdAt).getTime() >= cutoff)
    .slice(-lim)
    .reverse()
    .map((row) => {
      const control = parseChatControlAction(row.content);
      return {
        username: row.username,
        content: row.content,
        createdAt: row.createdAt,
        keyword: control?.action || null,
      };
    });
}

function getChatDebug(streamer, { hours = 24 } = {}) {
  const slug = normalizeStreamer(streamer);
  return {
    streamer: slug,
    monitored: isMonitoredStreamer(slug),
    broadcasterId: getBroadcasterIdForSlug(slug),
    hours,
    chatters: getChatters(slug, { hours, limit: 100 }),
    recent_messages: getRecentMessages(slug, { hours, limit: 40 }),
    keyword_totals: getChatters(slug, { hours, limit: 500 }).chatters.map((row) => ({
      username: row.username,
      message_count: row.message_count,
      keywords: row.keywords || {},
    })),
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
  const byStreamer = {};
  let totalMessages24h = 0;
  let activeChannels = 0;

  for (const streamer of getRewardsScanStreamers(24)) {
    const chatters = getChatters(streamer, { hours: 24, limit: 500 });
    const row = chatters.chatters.find(
      (c) => normalizeUsername(c.username) === username
    );
    const messageCount = row?.message_count || 0;
    if (messageCount <= 0) continue;

    activeChannels += 1;
    totalMessages24h += messageCount;
    byStreamer[streamer] = {
      message_count_24h: messageCount,
      keywords_24h: row?.keywords || {},
      keyword_usage: formatKeywordUsage(row?.keywords || {}),
      gift_kicks_all_time: sumGiftKicks(streamer, username, 0).total_kicks,
      chat_commands: getChatCommandsForStreamer(streamer),
    };
  }

  return {
    kickUsername: username,
    registered: Boolean(getRegistration(username)),
    total_messages_24h: totalMessages24h,
    active_channels: activeChannels,
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
  getMonitoredBroadcasterIds,
  isMonitoredStreamer,
  upsertMonitoredStreamer,
  replaceMonitoredStreamers,
  mergeMonitoredStreamers,
  listMonitoredChannels,
  resolveStreamerForWebhook,
  mergeStreamerSlugs,
  broadcasterIdToStreamer,
  resolveMonitoredSlugKey,
  streamerSlugMatches,
  getStats,
  getRewardsSummary,
  parsePartnerSlugList,
  streamerSlugMatches,
  getStreamersWithRecentMessages,
  getRewardsScanStreamers,
  ensureDefaultPartners,
  getRecentMessages,
  getChatDebug,
};
