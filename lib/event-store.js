const fs = require("fs");
const path = require("path");
const subscriptionUtils = require("./subscription-utils");
const { normalizeEmotes } = require("./chat-emotes");
const { getDataDir, ensureDataDir } = require("./data-dir");
const { createDeferredJsonStore } = require("./deferred-json-store");

const DATA_DIR = getDataDir();
const STORE_PATH = path.join(DATA_DIR, "events.json");
// Recent lines stay for OBS chat-box + sub evidence — dashboard uses dailyCounts.
const MAX_MESSAGES = Math.max(
  200,
  Number(process.env.CHAT_RECENT_MESSAGE_MAX || 2000) || 2000
);
const MAX_SUB_EVENTS = 1000;
const DAILY_COUNT_KEEP_DAYS = Math.max(
  2,
  Number(process.env.CHAT_DAILY_KEEP_DAYS || 14) || 14
);

function defaultStore() {
  return {
    messages: [],
    subscriptions: [],
    stats: { messagesByBroadcaster: {} },
    dailyCounts: {},
    meta: {},
  };
}

function loadStoreFromDisk() {
  if (!fs.existsSync(STORE_PATH)) {
    return defaultStore();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      subscriptions: Array.isArray(parsed.subscriptions)
        ? parsed.subscriptions
        : [],
      stats: parsed.stats || { messagesByBroadcaster: {} },
      dailyCounts:
        parsed.dailyCounts && typeof parsed.dailyCounts === "object"
          ? parsed.dailyCounts
          : {},
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  } catch {
    return defaultStore();
  }
}

const deferred = createDeferredJsonStore({
  path: STORE_PATH,
  load: loadStoreFromDisk,
  flushMs: 1000,
  pretty: false,
  ensureDir: ensureDataDir,
});

function readStore() {
  return deferred.get();
}

function writeStore(store) {
  deferred.set(store);
}

function flushSync() {
  deferred.flushSyncNow();
}

function trimMessages(list) {
  return list.slice(-MAX_MESSAGES);
}

function trimSubscriptions(list) {
  return list.slice(-MAX_SUB_EVENTS);
}

function ensureStats(store) {
  if (!store.stats) store.stats = { messagesByBroadcaster: {} };
  if (!store.stats.messagesByBroadcaster) store.stats.messagesByBroadcaster = {};
  return store.stats;
}

function incrementMessageTotal(store, broadcasterUserId) {
  const stats = ensureStats(store);
  const id = String(broadcasterUserId);
  stats.messagesByBroadcaster[id] = (stats.messagesByBroadcaster[id] || 0) + 1;
  return stats.messagesByBroadcaster[id];
}

function chatDayKey(date = new Date()) {
  const tz = String(process.env.CHAT_DAY_TZ || "America/Chicago").trim() || "America/Chicago";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function ensureDailyCounts(store) {
  if (!store.dailyCounts || typeof store.dailyCounts !== "object") {
    store.dailyCounts = {};
  }
  return store.dailyCounts;
}

function pruneDailyCounts(store) {
  const daily = ensureDailyCounts(store);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - DAILY_COUNT_KEEP_DAYS);
  const cutoffKey = chatDayKey(cutoff);

  for (const broadcasterId of Object.keys(daily)) {
    const byDay = daily[broadcasterId];
    if (!byDay || typeof byDay !== "object") {
      delete daily[broadcasterId];
      continue;
    }
    for (const day of Object.keys(byDay)) {
      if (day < cutoffKey) delete byDay[day];
    }
    if (!Object.keys(byDay).length) delete daily[broadcasterId];
  }
}

function incrementDailyCount(store, broadcasterUserId, username, userId = null) {
  const name = String(username || "")
    .trim()
    .replace(/^@/, "");
  if (!name) return null;

  const day = chatDayKey();
  const bid = String(broadcasterUserId);
  const daily = ensureDailyCounts(store);
  if (!daily[bid] || typeof daily[bid] !== "object") daily[bid] = {};
  if (!daily[bid][day] || typeof daily[bid][day] !== "object") daily[bid][day] = {};

  const key = name.toLowerCase();
  const prev = daily[bid][day][key] || {};
  daily[bid][day][key] = {
    username: name,
    userId: userId ? String(userId) : prev.userId || null,
    count: Number(prev.count || 0) + 1,
    lastAt: new Date().toISOString(),
  };
  pruneDailyCounts(store);
  return daily[bid][day][key];
}

function getDailyChatCounts(broadcasterUserId, { day = null, limit = 200 } = {}) {
  const store = readStore();
  const bid = String(broadcasterUserId);
  const d = day || chatDayKey();
  const map = store.dailyCounts?.[bid]?.[d] || {};
  const rows = Object.values(map)
    .map((row) => ({
      username: row.username || "unknown",
      userId: row.userId || null,
      count: Number(row.count || 0),
      lastAt: row.lastAt || null,
    }))
    .filter((row) => row.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        String(a.username).localeCompare(String(b.username), undefined, {
          sensitivity: "base",
        })
    );
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  return {
    day: d,
    timeZone: String(process.env.CHAT_DAY_TZ || "America/Chicago"),
    totalMessages: rows.reduce((sum, row) => sum + row.count, 0),
    uniqueChatters: rows.length,
    chatters: rows.slice(0, lim),
  };
}

/**
 * One-time backfill of today's counters from recent stored messages
 * (so the dashboard isn't empty right after deploy).
 */
function backfillDailyCountsFromMessages(store) {
  if (store.meta?.dailyCountsBackfilled) return false;
  const today = chatDayKey();
  const daily = ensureDailyCounts(store);
  let wrote = false;

  for (const entry of store.messages || []) {
    const created = entry?.createdAt ? new Date(entry.createdAt) : null;
    if (!created || Number.isNaN(created.getTime())) continue;
    if (chatDayKey(created) !== today) continue;
    const bid = String(entry.broadcasterUserId || "");
    const name = String(entry.username || "")
      .trim()
      .replace(/^@/, "");
    if (!bid || !name) continue;
    if (!daily[bid]) daily[bid] = {};
    if (!daily[bid][today]) daily[bid][today] = {};
    const key = name.toLowerCase();
    const prev = daily[bid][today][key] || {};
    daily[bid][today][key] = {
      username: name,
      userId: entry.userId ? String(entry.userId) : prev.userId || null,
      count: Number(prev.count || 0) + 1,
      lastAt: entry.createdAt || prev.lastAt || null,
    };
    wrote = true;
  }

  store.meta = store.meta && typeof store.meta === "object" ? store.meta : {};
  store.meta.dailyCountsBackfilled = true;
  store.meta.dailyCountsBackfilledAt = new Date().toISOString();
  pruneDailyCounts(store);
  return wrote;
}

function getTotalMessageCount(broadcasterUserId) {
  const store = readStore();
  const id = String(broadcasterUserId);
  const fromStats = store.stats?.messagesByBroadcaster?.[id];
  if (fromStats != null) return fromStats;

  return store.messages.filter((entry) => entry.broadcasterUserId === id).length;
}

/**
 * Look through recent chat + sub webhook history for evidence that a Kick user
 * is/was a subscriber (Kick has no live "is user X subbed?" API).
 */
function findRecentSubscriberEvidence({
  username = null,
  userId = null,
  broadcasterUserId = null,
  limit = 1200,
} = {}) {
  const store = readStore();
  const name = String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  const id = String(userId || "").trim();
  const ownerId = broadcasterUserId ? String(broadcasterUserId) : null;
  if (!name && !id) return null;

  const matchesPerson = (uname, uid) => {
    const n = String(uname || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    const u = String(uid || "").trim();
    return (name && n === name) || (id && u && u === id);
  };

  const start = Math.max(0, store.messages.length - Math.max(50, limit));
  for (let i = store.messages.length - 1; i >= start; i -= 1) {
    const row = store.messages[i];
    if (ownerId && String(row.broadcasterUserId) !== ownerId) continue;
    if (!matchesPerson(row.username, row.userId)) continue;
    if (row.isSubscriber) {
      return {
        source: "chat",
        username: row.username,
        userId: row.userId || null,
        at: row.createdAt || row.created_at || null,
      };
    }
  }

  for (let i = store.subscriptions.length - 1; i >= 0; i -= 1) {
    const row = store.subscriptions[i];
    if (!matchesPerson(row.username, row.userId || row.subscriberUserId)) continue;
    return {
      source: "subscription-event",
      username: row.username,
      userId: row.userId || row.subscriberUserId || null,
      at: row.createdAt || row.created_at || null,
      eventType: row.eventType || row.type || null,
    };
  }

  return null;
}

function extractSender(payload, broadcasterUserId) {
  const sender = payload.sender || {};
  const userId = sender.user_id || sender.userId || null;
  const username = sender.username || sender.slug || payload.username || "unknown";
  const identity = sender.identity || {};
  const badges = Array.isArray(identity.badges) ? identity.badges : [];
  const isBroadcaster = Boolean(
    sender.is_broadcaster ||
      (userId && broadcasterUserId && String(userId) === String(broadcasterUserId))
  );
  const isModerator = Boolean(
    sender.is_moderator ||
      isBroadcaster ||
      badges.some((badge) =>
        ["moderator", "broadcaster"].includes(
          String(badge.type || badge.name || "").toLowerCase()
        )
      )
  );

  const isSubscriber = Boolean(
    sender.is_subscriber ||
      sender.isSubscriber ||
      badges.some((badge) =>
        String(badge.type || badge.name || "")
          .toLowerCase()
          .includes("subscriber")
      )
  );

  return {
    username,
    userId: userId ? String(userId) : null,
    profilePicture: sender.profile_picture || sender.profilePicture || null,
    isModerator,
    isSubscriber,
    isBroadcaster,
  };
}

function migrateMessageStats(store = readStore()) {
  const stats = ensureStats(store);
  let changed = false;
  const counts = {};

  for (const entry of store.messages) {
    const id = String(entry.broadcasterUserId);
    counts[id] = (counts[id] || 0) + 1;
  }

  for (const [id, count] of Object.entries(counts)) {
    const current = stats.messagesByBroadcaster[id] || 0;
    if (current < count) {
      stats.messagesByBroadcaster[id] = count;
      changed = true;
    }
  }

  if (changed) writeStore(store);
  return store;
}

function addChatMessage(broadcasterUserId, payload) {
  const store = migrateMessageStats(readStore());
  if (!store.meta?.dailyCountsBackfilled) {
    backfillDailyCountsFromMessages(store);
  }
  const sender = extractSender(payload, broadcasterUserId);

  const message = {
    id: payload.message_id || payload.id || `${Date.now()}-${Math.random()}`,
    broadcasterUserId: String(broadcasterUserId),
    username: sender.username,
    userId: sender.userId,
    profilePicture: sender.profilePicture,
    content: payload.content || "",
    emotes: normalizeEmotes(payload.emotes),
    isModerator: sender.isModerator,
    isSubscriber: sender.isSubscriber,
    isBroadcaster: sender.isBroadcaster,
    createdAt: payload.created_at || new Date().toISOString(),
  };

  store.messages.push(message);
  incrementMessageTotal(store, broadcasterUserId);
  incrementDailyCount(store, broadcasterUserId, sender.username, sender.userId);
  store.messages = trimMessages(store.messages);
  writeStore(store);
  return message;
}

function addSubscriptionEvent(broadcasterUserId, eventType, payload) {
  const store = readStore();
  const quantity = subscriptionUtils.parseSubscriptionQuantity(eventType, payload);

  store.subscriptions.push({
    id: `${Date.now()}-${Math.random()}`,
    broadcasterUserId: String(broadcasterUserId),
    type: eventType,
    username:
      payload.gifter?.username ||
      payload.subscriber?.username ||
      payload.user?.username ||
      payload.username ||
      "unknown",
    quantity,
    createdAt: new Date().toISOString(),
  });

  store.subscriptions = trimSubscriptions(store.subscriptions);
  writeStore(store);
}

function getSessionMessageCount(broadcasterUserId, sessionStartedAt = null) {
  const store = readStore();
  const id = String(broadcasterUserId);
  const since = sessionStartedAt ? new Date(sessionStartedAt).getTime() : 0;

  if (!since) {
    return getTotalMessageCount(id);
  }

  return store.messages.filter(
    (entry) =>
      entry.broadcasterUserId === id &&
      new Date(entry.createdAt).getTime() >= since
  ).length;
}

function getRecentMessages(broadcasterUserId, limit = 30) {
  const store = readStore();
  const id = String(broadcasterUserId);

  const filtered = store.messages.filter((entry) => entry.broadcasterUserId === id);
  if (filtered.length) {
    return filtered.slice(-limit);
  }

  return store.messages.slice(-limit);
}

function getRecentMessagesAll(limit = 20) {
  const store = readStore();
  return store.messages.slice(-limit).map((message) => ({
    id: message.id,
    broadcasterUserId: message.broadcasterUserId,
    username: message.username,
    content: String(message.content || "").slice(0, 120),
    createdAt: message.createdAt,
  }));
}

function getMessageCountsByBroadcaster() {
  const store = readStore();
  const counts = {};

  for (const entry of store.messages) {
    const id = String(entry.broadcasterUserId || "unknown");
    counts[id] = (counts[id] || 0) + 1;
  }

  return counts;
}

function getSessionSubCount(broadcasterUserId, sessionStartedAt = null) {
  const store = readStore();
  const id = String(broadcasterUserId);
  const since = sessionStartedAt ? new Date(sessionStartedAt).getTime() : 0;

  return store.subscriptions
    .filter((entry) => {
      if (entry.broadcasterUserId !== id) return false;
      if (since && new Date(entry.createdAt).getTime() < since) return false;
      const type = String(entry.type || "");
      if (type.includes("renewal")) return false;
      return type.includes("subscription");
    })
    .reduce((sum, entry) => sum + (entry.quantity || 1), 0);
}

function getChannelData(broadcasterUserId) {
  const store = readStore();
  if (!store.meta?.dailyCountsBackfilled) {
    if (backfillDailyCountsFromMessages(store)) writeStore(store);
    else {
      store.meta = store.meta && typeof store.meta === "object" ? store.meta : {};
      store.meta.dailyCountsBackfilled = true;
      writeStore(store);
    }
  }

  const id = String(broadcasterUserId);
  const daily = getDailyChatCounts(id, { limit: 300 });

  const messages = store.messages.filter(
    (entry) => entry.broadcasterUserId === id
  );
  const subscriptions = store.subscriptions.filter(
    (entry) => entry.broadcasterUserId === id
  );

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentMessages = messages.filter(
    (entry) => new Date(entry.createdAt).getTime() >= oneHourAgo
  );

  return {
    // Keep a short recent list for any legacy consumers; dashboard shows dailyChat.
    messages: messages.slice(-20).reverse(),
    subscriptions: subscriptions.slice(-20).reverse(),
    dailyChat: daily,
    stats: {
      totalMessages: getTotalMessageCount(id),
      uniqueChatters: daily.uniqueChatters,
      messagesLastHour: recentMessages.length,
      messagesToday: daily.totalMessages,
      totalSubEvents: subscriptions.length,
      topChatters: daily.chatters.slice(0, 10),
    },
  };
}

module.exports = {
  addChatMessage,
  addSubscriptionEvent,
  getChannelData,
  getRecentMessages,
  getRecentMessagesAll,
  getDailyChatCounts,
  chatDayKey,
  getMessageCountsByBroadcaster,
  getSessionMessageCount,
  getSessionSubCount,
  getTotalMessageCount,
  findRecentSubscriberEvidence,
  migrateMessageStats,
  flushSync,
};
