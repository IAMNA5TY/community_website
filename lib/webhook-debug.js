const MAX_RECENT = 30;

const stats = {
  startedAt: new Date().toISOString(),
  totalHits: 0,
  totalAccepted: 0,
  totalRejected: 0,
  totalChatStored: 0,
  lastHitAt: null,
  lastAcceptedAt: null,
  lastRejectedAt: null,
  lastChatAt: null,
  lastRejection: null,
  lastChat: null,
  recent: [],
};

function summarizePayload(eventType, payload = {}) {
  if (eventType === "chat.message.sent") {
    return {
      username: payload.sender?.username || payload.username || "?",
      content: String(payload.content || "").slice(0, 120),
      messageId: payload.message_id || payload.id || null,
      broadcasterUserId:
        payload.broadcaster?.user_id ||
        payload.broadcaster_user_id ||
        payload.channel?.user_id ||
        null,
    };
  }

  return {
    type: eventType || "unknown",
    keys: Object.keys(payload || {}).slice(0, 8),
  };
}

function pushRecent(entry) {
  stats.recent.unshift(entry);
  if (stats.recent.length > MAX_RECENT) {
    stats.recent.length = MAX_RECENT;
  }
}

function recordHit({ eventType, headers = {}, valid, reason, payload, channelId, stored }) {
  stats.totalHits += 1;
  stats.lastHitAt = new Date().toISOString();

  const entry = {
    at: stats.lastHitAt,
    eventType: eventType || headers["kick-event-type"] || "unknown",
    valid,
    reason: reason || null,
    hasSignature: Boolean(headers["kick-event-signature"]),
    hasMessageId: Boolean(headers["kick-event-message-id"]),
    hasTimestamp: Boolean(headers["kick-event-message-timestamp"]),
    channelId: channelId || null,
    stored: Boolean(stored),
    summary: summarizePayload(eventType, payload),
  };

  pushRecent(entry);

  if (valid) {
    stats.totalAccepted += 1;
    stats.lastAcceptedAt = entry.at;
    if (eventType === "chat.message.sent" && stored) {
      stats.totalChatStored += 1;
      stats.lastChatAt = entry.at;
      stats.lastChat = {
        at: entry.at,
        channelId,
        ...entry.summary,
      };
    }
    return;
  }

  stats.totalRejected += 1;
  stats.lastRejectedAt = entry.at;
  stats.lastRejection = {
    at: entry.at,
    eventType: entry.eventType,
    reason: reason || "rejected",
    hasSignature: entry.hasSignature,
    hasMessageId: entry.hasMessageId,
    hasTimestamp: entry.hasTimestamp,
  };
}

function getDebugSnapshot(extra = {}) {
  return {
    ...stats,
    ...extra,
  };
}

module.exports = {
  recordHit,
  getDebugSnapshot,
};
