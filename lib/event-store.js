const fs = require("fs");
const path = require("path");
const subscriptionUtils = require("./subscription-utils");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "events.json");
const MAX_MESSAGES = 10000;
const MAX_SUB_EVENTS = 1000;

function defaultStore() {
  return { messages: [], subscriptions: [], stats: { messagesByBroadcaster: {} } };
}

function readStore() {
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
    };
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

function getTotalMessageCount(broadcasterUserId) {
  const store = readStore();
  const id = String(broadcasterUserId);
  const fromStats = store.stats?.messagesByBroadcaster?.[id];
  if (fromStats != null) return fromStats;

  return store.messages.filter((entry) => entry.broadcasterUserId === id).length;
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

  return {
    username,
    userId: userId ? String(userId) : null,
    profilePicture: sender.profile_picture || sender.profilePicture || null,
    isModerator,
    isSubscriber: Boolean(sender.is_subscriber || sender.isSubscriber),
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
  const sender = extractSender(payload, broadcasterUserId);

  const message = {
    id: payload.message_id || payload.id || `${Date.now()}-${Math.random()}`,
    broadcasterUserId: String(broadcasterUserId),
    username: sender.username,
    userId: sender.userId,
    profilePicture: sender.profilePicture,
    content: payload.content || "",
    isModerator: sender.isModerator,
    isSubscriber: sender.isSubscriber,
    isBroadcaster: sender.isBroadcaster,
    createdAt: payload.created_at || new Date().toISOString(),
  };

  store.messages.push(message);
  incrementMessageTotal(store, broadcasterUserId);
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
  const id = String(broadcasterUserId);

  const messages = store.messages.filter(
    (entry) => entry.broadcasterUserId === id
  );
  const subscriptions = store.subscriptions.filter(
    (entry) => entry.broadcasterUserId === id
  );

  const uniqueChatters = new Set(
    messages.map((entry) => entry.username).filter(Boolean)
  );

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentMessages = messages.filter(
    (entry) => new Date(entry.createdAt).getTime() >= oneHourAgo
  );

  const chatterCounts = {};
  for (const entry of messages) {
    chatterCounts[entry.username] = (chatterCounts[entry.username] || 0) + 1;
  }

  const topChatters = Object.entries(chatterCounts)
    .map(([username, count]) => ({ username, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    messages: messages.slice(-50).reverse(),
    subscriptions: subscriptions.slice(-20).reverse(),
    stats: {
      totalMessages: messages.length,
      uniqueChatters: uniqueChatters.size,
      messagesLastHour: recentMessages.length,
      totalSubEvents: subscriptions.length,
      topChatters,
    },
  };
}

module.exports = {
  addChatMessage,
  addSubscriptionEvent,
  getChannelData,
  getRecentMessages,
  getSessionMessageCount,
  getSessionSubCount,
  getTotalMessageCount,
  migrateMessageStats,
};
