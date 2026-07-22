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
    chatPresence: {},
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
      chatPresence:
        parsed.chatPresence && typeof parsed.chatPresence === "object"
          ? parsed.chatPresence
          : {},
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

/** Single read→mutate→write so chat/claim/mark don't clobber each other mid-update. */
function mutateStore(mutator) {
  const store = readStore();
  const result = mutator(store);
  writeStore(store);
  return result;
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

/** Mark Kick roster entry as expired / not a sub (confirmed chat without sub badge). */
function clearSubscriberFromChat(username, userId = null) {
  const key = normalizeUsername(username);
  if (!key) return null;
  return mutateStore((store) => {
    const prev = store.subscribers[key] || {};
    // Don't wipe owner-manual / fresh webhook rows on a flaky chat read unless they
    // already expired or were chat-sourced.
    const source = String(prev.source || "");
    const protectedSource =
      source === "owner-manual" ||
      source === "webhook" ||
      source.startsWith("channel.subscription");
    const stillActive =
      prev.expiresAt && new Date(prev.expiresAt).getTime() > Date.now();
    if (protectedSource && stillActive) {
      return store.subscribers[key] || prev;
    }
    store.subscribers[key] = {
      username: String(username || key).replace(/^@/, ""),
      kickUserId: userId ? String(userId) : prev.kickUserId || null,
      expiresAt: new Date(0).toISOString(),
      gifted: Boolean(prev.gifted),
      source: "chat-no-badge",
      lastEventType: "chat.no_subscriber_badge",
      lastEventAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return store.subscribers[key];
  });
}

/**
 * Classify Kick chat badge payload.
 * - subscriber: has sub badge or explicit is_subscriber
 * - confirmed-non-sub: identity.badges present (array) and no subscriber badge
 * - unknown: badges field missing — do not clear roster or revoke
 */
function classifyChatSubscription({
  isSubscriber = false,
  badges = undefined,
  explicitSubscriber = null,
} = {}) {
  const badgeTypes = normalizeBadgeList(badges);
  const hasSubBadge = badgeTypes.some((type) => type.includes("subscriber"));
  if (explicitSubscriber === true || isSubscriber === true || hasSubBadge) {
    return { status: "subscriber", badgeTypes };
  }
  if (explicitSubscriber === false) {
    return { status: "confirmed-non-sub", badgeTypes };
  }
  // badges === undefined/null → Kick omitted identity; treat as unknown
  if (badges === undefined || badges === null) {
    return { status: "unknown", badgeTypes };
  }
  if (Array.isArray(badges)) {
    return { status: "confirmed-non-sub", badgeTypes };
  }
  return { status: "unknown", badgeTypes };
}

function findActiveGrantForKick(kickUserId, kickUsername) {
  const store = readStore();
  const name = normalizeUsername(kickUsername);
  const id = String(kickUserId || "").trim();

  if (id && store.links[id]?.discordId) {
    const grant = store.grants[String(store.links[id].discordId)];
    if (grant?.active) {
      return { grant, link: store.links[id] };
    }
  }

  if (name) {
    const link =
      Object.values(store.links).find(
        (row) => normalizeUsername(row.kickUsername) === name
      ) || null;
    if (link?.discordId) {
      const grant = store.grants[String(link.discordId)];
      if (grant?.active) return { grant, link };
    }

    const grant =
      Object.values(store.grants).find(
        (row) => row.active && normalizeUsername(row.kickUsername) === name
      ) || null;
    if (grant) return { grant, link: null };
  }

  return null;
}

/**
 * Kick chat badges are the live signal for sub status.
 * - With sub badge → renew roster
 * - Missing badge fields → ignore (unknown)
 * - Confirmed no sub badge → only revoke after prior with-badge + 2 confirms
 */
function normalizeBadgeList(badges) {
  if (!Array.isArray(badges)) return [];
  return badges
    .map((badge) => {
      const type = String(badge?.type || badge?.name || badge || "")
        .trim()
        .toLowerCase();
      return type || null;
    })
    .filter(Boolean)
    .slice(0, 24);
}

const CONFIRMED_NO_BADGE_BEFORE_REVOKE = Math.max(
  1,
  Number(process.env.DISCORD_CHAT_REVOKE_CONFIRMATIONS || 2) || 2
);

function recordChatPresence({
  username,
  userId = null,
  isSubscriber = false,
  badges = undefined,
  explicitSubscriber = null,
} = {}) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const classified = classifyChatSubscription({
    isSubscriber,
    badges,
    explicitSubscriber,
  });
  return mutateStore((store) => {
    store.chatPresence = store.chatPresence || {};
    const prev = store.chatPresence[key] || {};
    const now = new Date().toISOString();
    const isSub = classified.status === "subscriber";
    const confirmedNo = classified.status === "confirmed-non-sub";
    const noBadgeStreak = isSub
      ? 0
      : confirmedNo
        ? Number(prev.noBadgeStreak || 0) + 1
        : Number(prev.noBadgeStreak || 0);

    store.chatPresence[key] = {
      username: String(username || key).replace(/^@/, ""),
      kickUserId: userId ? String(userId) : prev.kickUserId || null,
      lastSeenAt: now,
      lastHadSubscriberBadge: isSub,
      lastBadgeStatus: classified.status,
      lastBadges: classified.badgeTypes.length
        ? classified.badgeTypes
        : prev.lastBadges || [],
      withBadgeAt: isSub ? now : prev.withBadgeAt || null,
      withoutBadgeAt: confirmedNo ? now : prev.withoutBadgeAt || null,
      noBadgeStreak,
      seenCount: Number(prev.seenCount || 0) + 1,
    };
    return store.chatPresence[key];
  });
}

function observeChatSubscriberBadge({
  username,
  userId = null,
  isSubscriber = false,
  badges = undefined,
  explicitSubscriber = null,
} = {}) {
  const name = normalizeUsername(username);
  if (!name) return { action: "skip", reason: "no-username" };

  const classified = classifyChatSubscription({
    isSubscriber,
    badges,
    explicitSubscriber,
  });

  const presence = recordChatPresence({
    username,
    userId,
    isSubscriber,
    badges,
    explicitSubscriber,
  });

  if (isChannelOwner(userId, username)) {
    return {
      action: "owner",
      kickUsername: name,
      kickUserId: userId,
      presence,
      badgeStatus: classified.status,
    };
  }

  if (classified.status === "subscriber") {
    markSubscriberFromChat({ username, userId });
    return {
      action: "renewed",
      kickUsername: name,
      kickUserId: userId,
      presence,
      badgeStatus: classified.status,
    };
  }

  if (classified.status === "unknown") {
    return {
      action: "unknown",
      reason: "badges-omitted",
      kickUsername: name,
      kickUserId: userId,
      presence,
      badgeStatus: classified.status,
    };
  }

  // confirmed-non-sub — never wipe roster just because they haven't claimed yet
  const hit = findActiveGrantForKick(userId, username);
  if (!hit?.grant?.discordId) {
    return {
      action: "not-sub",
      kickUsername: name,
      kickUserId: userId,
      presence,
      badgeStatus: classified.status,
    };
  }

  if (!presence?.withBadgeAt) {
    return {
      action: "no-badge-ignored",
      reason: "never-saw-subscriber-badge",
      kickUsername: name,
      kickUserId: userId,
      discordId: String(hit.grant.discordId),
      presence,
      badgeStatus: classified.status,
    };
  }

  if (Number(presence.noBadgeStreak || 0) < CONFIRMED_NO_BADGE_BEFORE_REVOKE) {
    return {
      action: "no-badge-pending",
      reason: `need-${CONFIRMED_NO_BADGE_BEFORE_REVOKE}-confirmed-sightings`,
      kickUsername: name,
      kickUserId: userId,
      discordId: String(hit.grant.discordId),
      presence,
      badgeStatus: classified.status,
    };
  }

  clearSubscriberFromChat(username, userId);
  return {
    action: "should-revoke",
    discordId: String(hit.grant.discordId),
    kickUsername: name,
    kickUserId: userId || hit.grant.kickUserId || hit.link?.kickUserId || null,
    presence,
    badgeStatus: classified.status,
  };
}

function listChatBadgeRoster(limit = 200) {
  const store = readStore();
  const presenceRows = Object.values(store.chatPresence || {});
  const byName = new Map();

  for (const row of presenceRows) {
    const key = normalizeUsername(row.username);
    if (!key) continue;
    byName.set(key, {
      username: row.username || key,
      kickUserId: row.kickUserId || null,
      lastSeenAt: row.lastSeenAt || null,
      hasSubscriberBadge: Boolean(row.lastHadSubscriberBadge),
      lastBadgeStatus: row.lastBadgeStatus || null,
      lastBadges: Array.isArray(row.lastBadges) ? row.lastBadges : [],
      withBadgeAt: row.withBadgeAt || null,
      withoutBadgeAt: row.withoutBadgeAt || null,
      noBadgeStreak: Number(row.noBadgeStreak || 0),
      seenCount: Number(row.seenCount || 0),
      source: "chat",
    });
  }

  // Include roster entries that have never chatted while we were watching.
  for (const row of Object.values(store.subscribers || {})) {
    const key = normalizeUsername(row.username);
    if (!key || byName.has(key)) continue;
    const active =
      row.expiresAt && new Date(row.expiresAt).getTime() > Date.now();
    byName.set(key, {
      username: row.username || key,
      kickUserId: row.kickUserId || null,
      lastSeenAt: row.lastEventAt || row.updatedAt || null,
      hasSubscriberBadge: Boolean(active),
      lastBadgeStatus: active ? "subscriber" : "confirmed-non-sub",
      lastBadges: active ? ["subscriber (roster)"] : [],
      withBadgeAt: active ? row.lastEventAt || null : null,
      withoutBadgeAt: active ? null : row.updatedAt || null,
      noBadgeStreak: 0,
      seenCount: 0,
      source: row.source || "roster",
    });
  }

  const rows = [...byName.values()].map((row) => {
    const link =
      (row.kickUserId && store.links[String(row.kickUserId)]) ||
      Object.values(store.links).find(
        (l) => normalizeUsername(l.kickUsername) === normalizeUsername(row.username)
      ) ||
      null;
    const grant = link?.discordId ? store.grants[String(link.discordId)] : null;
    const grantByName =
      grant ||
      Object.values(store.grants).find(
        (g) => normalizeUsername(g.kickUsername) === normalizeUsername(row.username)
      ) ||
      null;
    return {
      ...row,
      isOwner: isChannelOwner(row.kickUserId, row.username),
      discordLinked: Boolean(link?.discordId),
      discordUsername: link?.discordUsername || null,
      roleGranted: Boolean(grantByName?.active),
    };
  });

  rows.sort((a, b) => {
    if (a.hasSubscriberBadge !== b.hasSubscriberBadge) {
      return a.hasSubscriberBadge ? -1 : 1;
    }
    return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
  });

  return rows.slice(0, Math.max(1, Math.min(500, limit)));
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
  const key = String(discordId);
  const prev = store.grants[key] || {};
  store.grants[key] = {
    discordId: key,
    kickUsername: normalizeUsername(
      payload.kickUsername !== undefined ? payload.kickUsername : prev.kickUsername
    ),
    kickUserId:
      payload.kickUserId !== undefined
        ? payload.kickUserId
          ? String(payload.kickUserId)
          : null
        : prev.kickUserId || null,
    active: payload.active !== false,
    grantedAt: prev.grantedAt || new Date().toISOString(),
    expiresAt:
      payload.expiresAt !== undefined ? payload.expiresAt || null : prev.expiresAt || null,
    lastCheckedAt:
      payload.lastCheckedAt !== undefined
        ? payload.lastCheckedAt
        : prev.lastCheckedAt || null,
    revokedAt: payload.active === false ? new Date().toISOString() : null,
    revokeReason: payload.revokeReason || null,
  };
  writeStore(store);
  return store.grants[key];
}

function getGrant(discordId) {
  const store = readStore();
  return store.grants[String(discordId)] || null;
}

function listActiveGrants() {
  const store = readStore();
  return Object.values(store.grants).filter(
    (row) => row && row.active && row.discordId
  );
}

function listGrants(limit = 200) {
  const store = readStore();
  return Object.values(store.grants)
    .filter((row) => row && row.discordId)
    .sort((a, b) => String(b.grantedAt || "").localeCompare(String(a.grantedAt || "")))
    .slice(0, Math.max(1, Math.min(500, limit)));
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

/**
 * Kick has no "is this user subbed?" API. Before failing a claim, try to
 * discover evidence from recent chat / subscription webhook history.
 */
function refreshEligibilityFromHistory(kickUserId, kickUsername, eventStore, broadcasterUserId) {
  const current = isEligibleForSubRole(kickUserId, kickUsername);
  if (current.eligible) return current;
  if (!eventStore || typeof eventStore.findRecentSubscriberEvidence !== "function") {
    return current;
  }

  const evidence = eventStore.findRecentSubscriberEvidence({
    username: kickUsername,
    userId: kickUserId,
    broadcasterUserId,
  });
  if (!evidence) return current;

  markSubscriberFromChat({
    username: evidence.username || kickUsername,
    userId: evidence.userId || kickUserId,
  });
  return isEligibleForSubRole(kickUserId, kickUsername);
}

function markSubscriberManual({ username, userId = null, days = null } = {}) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const subDays = Math.max(
    1,
    Number(days || process.env.DISCORD_SUB_DURATION_DAYS || 31) || 31
  );
  const row = upsertSubscriber({
    username: key,
    userId,
    expiresAt: new Date(Date.now() + subDays * 24 * 60 * 60 * 1000).toISOString(),
    source: "owner-manual",
    gifted: false,
    eventType: "owner.manual_mark",
  });
  // Seed presence so a missing-badge chat packet can't wipe them before claim.
  mutateStore((store) => {
    store.chatPresence = store.chatPresence || {};
    const prev = store.chatPresence[key] || {};
    const now = new Date().toISOString();
    store.chatPresence[key] = {
      username: String(username || key).replace(/^@/, ""),
      kickUserId: userId ? String(userId) : prev.kickUserId || null,
      lastSeenAt: prev.lastSeenAt || now,
      lastHadSubscriberBadge: true,
      lastBadgeStatus: "subscriber",
      lastBadges: prev.lastBadges?.length ? prev.lastBadges : ["subscriber (owner-mark)"],
      withBadgeAt: prev.withBadgeAt || now,
      withoutBadgeAt: prev.withoutBadgeAt || null,
      noBadgeStreak: 0,
      seenCount: Number(prev.seenCount || 0),
    };
  });
  return row;
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
    note = `No Kick sub on record yet for @${kickName || "unknown"} (Kick has no live sub list). Type once in na5ty chat while subbed, or wait for a sub/gift webhook.`;
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
  listActiveGrants,
  listGrants,
  listActiveSubscribers,
  getPublicStatusForKickUser,
  isEligibleForSubRole,
  isChannelOwner,
  refreshEligibilityFromHistory,
  markSubscriberManual,
  observeChatSubscriberBadge,
  recordChatPresence,
  listChatBadgeRoster,
  findActiveGrantForKick,
  clearSubscriberFromChat,
  getDiscordPanelMeta,
  setDiscordPanelMeta,
  normalizeUsername,
};
