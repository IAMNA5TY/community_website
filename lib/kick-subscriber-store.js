const fs = require("fs");
const path = require("path");
const { getDataDir, ensureDataDir } = require("./data-dir");

const STORE_PATH = path.join(getDataDir(), "kick-subscribers.json");
const DEFAULT_SUB_DAYS = Math.max(
  1,
  Number(process.env.DISCORD_SUB_DURATION_DAYS || 31) || 31
);

function defaultStore() {
  return {
    subscribers: {},
    links: {},
    grants: {},
    meta: {},
  };
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) return defaultStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return {
      subscribers:
        parsed.subscribers && typeof parsed.subscribers === "object"
          ? parsed.subscribers
          : {},
      links: parsed.links && typeof parsed.links === "object" ? parsed.links : {},
      grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {},
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function parseExpiry(payload = {}, fallbackDays = DEFAULT_SUB_DAYS) {
  const candidates = [
    payload.expires_at,
    payload.expiresAt,
    payload.subscription?.expires_at,
    payload.subscription?.expiresAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms) && ms > Date.now() - 60_000) {
      return new Date(ms).toISOString();
    }
  }

  const durationMonths = Number(
    payload.duration ||
      payload.subscription?.duration ||
      payload.months ||
      payload.subscription?.months ||
      0
  );
  const days =
    Number.isFinite(durationMonths) && durationMonths > 0
      ? Math.ceil(durationMonths * 31)
      : fallbackDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function extractPeopleFromSubscriptionPayload(eventType, payload = {}) {
  const people = [];
  const type = String(eventType || "");

  if (type.includes("gifts")) {
    const lists = [
      payload.giftees,
      payload.gifted_users,
      payload.recipients,
      payload.giftee_usernames,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (typeof row === "string") {
          people.push({ username: row, userId: null, gifted: true });
          continue;
        }
        people.push({
          username: row?.username || row?.slug || row?.name || null,
          userId: row?.user_id || row?.userId || row?.id || null,
          gifted: true,
        });
      }
    }
    return people.filter((row) => row.username);
  }

  const subscriber = payload.subscriber || payload.user || {};
  const username =
    subscriber.username ||
    subscriber.slug ||
    payload.username ||
    null;
  if (!username) return [];
  return [
    {
      username,
      userId: subscriber.user_id || subscriber.userId || subscriber.id || null,
      gifted: false,
    },
  ];
}

function upsertSubscriber({
  username,
  userId = null,
  expiresAt = null,
  source = "webhook",
  gifted = false,
  eventType = null,
}) {
  const key = normalizeUsername(username);
  if (!key) return null;

  const store = readStore();
  const prev = store.subscribers[key] || {};
  const nextExpires = expiresAt || prev.expiresAt || parseExpiry({});
  const prevMs = prev.expiresAt ? new Date(prev.expiresAt).getTime() : 0;
  const nextMs = new Date(nextExpires).getTime();

  store.subscribers[key] = {
    username: String(username).replace(/^@/, ""),
    kickUserId: userId ? String(userId) : prev.kickUserId || null,
    expiresAt: nextMs >= prevMs ? nextExpires : prev.expiresAt,
    gifted: Boolean(gifted || prev.gifted),
    source: source || prev.source || "webhook",
    lastEventType: eventType || prev.lastEventType || null,
    lastEventAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return store.subscribers[key];
}

function recordSubscriptionEvent(eventType, payload = {}) {
  if (!String(eventType || "").startsWith("channel.subscription")) {
    return [];
  }
  const expiresAt = parseExpiry(payload);
  const people = extractPeopleFromSubscriptionPayload(eventType, payload);
  return people
    .map((person) =>
      upsertSubscriber({
        username: person.username,
        userId: person.userId,
        expiresAt,
        source: "webhook",
        gifted: person.gifted,
        eventType,
      })
    )
    .filter(Boolean);
}

function markSubscriberFromChat({ username, userId = null }) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const store = readStore();
  const prev = store.subscribers[key];
  const stillActive =
    prev?.expiresAt && new Date(prev.expiresAt).getTime() > Date.now();
  if (stillActive) {
    if (userId && !prev.kickUserId) {
      prev.kickUserId = String(userId);
      prev.updatedAt = new Date().toISOString();
      writeStore(store);
    }
    return prev;
  }
  return upsertSubscriber({
    username,
    userId,
    expiresAt: parseExpiry({}),
    source: "chat-badge",
    gifted: false,
    eventType: "chat.subscriber_badge",
  });
}

function getSubscriber(usernameOrId) {
  const store = readStore();
  const key = normalizeUsername(usernameOrId);
  if (key && store.subscribers[key]) return store.subscribers[key];

  const id = String(usernameOrId || "").trim();
  if (!id) return null;
  return (
    Object.values(store.subscribers).find(
      (row) => String(row.kickUserId || "") === id
    ) || null
  );
}

function isActiveSubscriber(usernameOrId) {
  const row = getSubscriber(usernameOrId);
  if (!row?.expiresAt) return false;
  return new Date(row.expiresAt).getTime() > Date.now();
}

function linkDiscordAccount(kickUserId, kickUsername, discordUser) {
  const store = readStore();
  const kickId = String(kickUserId);
  store.links[kickId] = {
    kickUserId: kickId,
    kickUsername: normalizeUsername(kickUsername),
    discordId: String(discordUser.id),
    discordUsername: discordUser.username || discordUser.global_name || null,
    discordGlobalName: discordUser.global_name || null,
    linkedAt: new Date().toISOString(),
  };
  writeStore(store);
  return store.links[kickId];
}

function getLinkForKickUser(kickUserId) {
  const store = readStore();
  return store.links[String(kickUserId)] || null;
}

function getLinkForDiscordId(discordId) {
  const id = String(discordId || "").trim();
  if (!id) return null;
  const store = readStore();
  return (
    Object.values(store.links).find((row) => String(row.discordId || "") === id) ||
    null
  );
}

function unlinkDiscord(kickUserId) {
  const store = readStore();
  const key = String(kickUserId);
  const existing = store.links[key] || null;
  delete store.links[key];
  writeStore(store);
  return existing;
}

function getDiscordPanelMeta() {
  const store = readStore();
  return store.meta?.discordPanel || null;
}

function setDiscordPanelMeta(panel) {
  const store = readStore();
  store.meta = store.meta && typeof store.meta === "object" ? store.meta : {};
  store.meta.discordPanel = panel
    ? {
        channelId: String(panel.channelId || ""),
        messageId: String(panel.messageId || ""),
        postedAt: panel.postedAt || new Date().toISOString(),
      }
    : null;
  writeStore(store);
  return store.meta.discordPanel;
}

function recordGrant(discordId, payload = {}) {
  const store = readStore();
  store.grants[String(discordId)] = {
    discordId: String(discordId),
    kickUsername: normalizeUsername(payload.kickUsername),
    kickUserId: payload.kickUserId ? String(payload.kickUserId) : null,
    active: payload.active !== false,
    grantedAt: new Date().toISOString(),
    expiresAt: payload.expiresAt || null,
  };
  writeStore(store);
  return store.grants[String(discordId)];
}

function getGrant(discordId) {
  const store = readStore();
  return store.grants[String(discordId)] || null;
}

function listActiveSubscribers(limit = 100) {
  const store = readStore();
  const now = Date.now();
  return Object.values(store.subscribers)
    .filter((row) => row.expiresAt && new Date(row.expiresAt).getTime() > now)
    .sort((a, b) => String(a.username).localeCompare(String(b.username)))
    .slice(0, Math.max(1, Math.min(500, limit)));
}

function getOwnerKickUsernames() {
  const raw = String(
    process.env.OWNER_KICK_USERNAMES ||
      process.env.DEFAULT_BROADCASTER_SLUG ||
      "na5ty"
  ).trim();
  const set = new Set(
    raw
      .split(",")
      .map((name) => normalizeUsername(name))
      .filter(Boolean)
  );
  const channelSlug = normalizeUsername(
    process.env.KICK_OWNER_SLUG || process.env.DEFAULT_BROADCASTER_SLUG || "na5ty"
  );
  if (channelSlug) set.add(channelSlug);
  return set;
}

function getOwnerBroadcasterIds() {
  const raw = String(
    process.env.OWNER_BROADCASTER_IDS || process.env.DEFAULT_BROADCASTER_ID || "1183030"
  ).trim();
  return new Set(
    raw
      .split(",")
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
}

/** Channel owner is always eligible — Kick has no "sub to yourself" webhook. */
function isChannelOwner(kickUserId, kickUsername) {
  const id = String(kickUserId || "").trim();
  if (id && getOwnerBroadcasterIds().has(id)) return true;
  const name = normalizeUsername(kickUsername);
  return Boolean(name && getOwnerKickUsernames().has(name));
}

function isEligibleForSubRole(kickUserId, kickUsername) {
  if (isChannelOwner(kickUserId, kickUsername)) {
    return { eligible: true, reason: "owner" };
  }
  if (isActiveSubscriber(kickUsername) || isActiveSubscriber(kickUserId)) {
    return { eligible: true, reason: "subscriber" };
  }
  return { eligible: false, reason: "none" };
}

function getPublicStatusForKickUser(kickUserId, kickUsername) {
  const link = getLinkForKickUser(kickUserId);
  const kickName = normalizeUsername(kickUsername);
  const eligibility = isEligibleForSubRole(kickUserId, kickUsername);
  const active = eligibility.eligible;
  const sub = getSubscriber(kickUsername) || getSubscriber(kickUserId);
  const grant = link?.discordId ? getGrant(link.discordId) : null;

  let note;
  if (eligibility.reason === "owner") {
    note = `Kick login @${kickName || "unknown"} is the channel owner — subscriber role allowed.`;
  } else if (active) {
    note = `Kick login @${kickName || "unknown"} is an active paid/gifted sub on record.`;
  } else {
    note = `Checking Kick login @${kickName || "unknown"} (not Discord). No active sub found yet — sub to na5ty or chat while subbed.`;
  }

  return {
    discordConfigured: Boolean(
      process.env.DISCORD_BOT_TOKEN &&
        process.env.DISCORD_CLIENT_ID &&
        process.env.DISCORD_GUILD_ID &&
        process.env.DISCORD_SUB_ROLE_ID
    ),
    kickUsername: kickName || null,
    kickUserId: kickUserId ? String(kickUserId) : null,
    linked: Boolean(link?.discordId),
    discordUsername: link?.discordUsername || null,
    discordId: link?.discordId || null,
    activeSubscriber: active,
    eligibilityReason: eligibility.reason,
    expiresAt: sub?.expiresAt || null,
    roleGranted: Boolean(grant?.active),
    note,
  };
}

module.exports = {
  recordSubscriptionEvent,
  markSubscriberFromChat,
  upsertSubscriber,
  getSubscriber,
  isActiveSubscriber,
  linkDiscordAccount,
  getLinkForKickUser,
  getLinkForDiscordId,
  unlinkDiscord,
  recordGrant,
  getGrant,
  listActiveSubscribers,
  getPublicStatusForKickUser,
  isEligibleForSubRole,
  isChannelOwner,
  getDiscordPanelMeta,
  setDiscordPanelMeta,
  normalizeUsername,
};
