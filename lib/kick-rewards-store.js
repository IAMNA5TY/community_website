const fs = require("fs");
const path = require("path");
const { parseChatControlAction } = require("./kick-chat-actions");
const {
  getChatCommandsForStreamer,
  formatKeywordUsage,
} = require("./kick-chat-commands");
const { getDataDir, ensureDataDir } = require("./data-dir");
const partnerRegistry = require("./partner-registry");

const DATA_DIR = getDataDir();
const STORE_PATH = path.join(DATA_DIR, "kick-rewards.json");
const MAX_MESSAGES = 20000;
const MAX_CONTROL_EVENTS = 5000;

function defaultStore() {
  return {
    registrations: [],
    monitoredChannels: [],
    removedPartners: [],
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
  ensureDataDir();
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
  const envMap = parseEnvChannelMap();
  const slugToId = new Map();
  const idToSlug = new Map();
  const store = readStore();

  for (const application of partnerRegistry.listApplications()) {
    if (application.status !== "approved") continue;
    const slug = normalizeStreamer(application.kickUsername);
    const broadcasterId =
      application.broadcasterId || envMap.slugToId.get(slug) || null;
    slugToId.set(slug, broadcasterId);
    if (broadcasterId) idToSlug.set(String(broadcasterId), slug);
  }

  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug || !partnerRegistry.isApproved(slug)) continue;
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
  return [...slugToId.keys()];
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

function upsertMonitoredStreamer(slug, broadcasterId = null, options = {}) {
  const normalized = normalizeStreamer(slug);
  if (!normalized) {
    throw new Error("Streamer slug is required");
  }
  const alwaysMonitor = getAlwaysMonitorSlugs().has(normalized);
  if (!alwaysMonitor && !partnerRegistry.isApproved(normalized)) {
    throw new Error(`@${normalized} is not approved for Streamer Rewards partnership`);
  }

  const store = readStore();
  if (!Array.isArray(store.monitoredChannels)) {
    store.monitoredChannels = [];
  }
  if (!Array.isArray(store.removedPartners)) {
    store.removedPartners = [];
  }

  // Re-adding clears a previous Only Pixels remove.
  store.removedPartners = store.removedPartners.filter(
    (row) => normalizeStreamer(row) !== normalized
  );

  const id =
    broadcasterId != null && String(broadcasterId).trim() !== ""
      ? String(broadcasterId)
      : null;
  // Prefer an existing compact-slug match (stevens_gaming ↔ stevens-gaming).
  let existing = store.monitoredChannels.find(
    (row) => normalizeStreamer(row.slug) === normalized
  );
  if (!existing) {
    existing = store.monitoredChannels.find((row) =>
      streamerSlugMatches(normalized, row.slug)
    );
  }

  if (existing) {
    if (id) existing.broadcasterId = id;
    // Prefer hyphenated Kick slug when merging underscore variants.
    if (normalized.includes("-") && !String(existing.slug).includes("-")) {
      existing.slug = normalized;
    } else {
      existing.slug = existing.slug || normalized;
    }
    // Chat stays on once enabled; new partners default on below.
    if (options.chatPriority === true) existing.chatPriority = true;
    if (options.chatPriority === false) existing.chatPriority = false;
    if (options.liveChat === true) existing.liveChat = true;
    if (options.liveChat === false) existing.liveChat = false;
    if (options.chatroomId) existing.chatroomId = String(options.chatroomId);
    if (options.channelId) existing.channelId = String(options.channelId);
  } else {
    store.monitoredChannels.push({
      slug: normalized,
      broadcasterId: id,
      // New partners always get chat — no manual Enable click.
      chatPriority: options.chatPriority !== false,
      liveChat: options.liveChat === true,
      chatroomId: options.chatroomId ? String(options.chatroomId) : null,
      channelId: options.channelId ? String(options.channelId) : null,
      addedAt: new Date().toISOString(),
    });
  }

  writeStore(store);
  const row = store.monitoredChannels.find(
    (item) =>
      normalizeStreamer(item.slug) === normalized ||
      streamerSlugMatches(normalized, item.slug)
  );
  return {
    slug: normalizeStreamer(row && row.slug) || normalized,
    broadcasterId: (row && row.broadcasterId) || getBroadcasterIdForSlug(normalized),
    chatPriority: Boolean(row && row.chatPriority),
    chatroomId: (row && row.chatroomId) || null,
  };
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
      chatPriority: prev?.chatPriority !== false,
      chatroomId: prev?.chatroomId || null,
      channelId: prev?.channelId || null,
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
    upsertMonitoredStreamer(slug, resolvedId, { chatPriority: true });
  }
  return listMonitoredChannels();
}

function isEnvLockedStreamer(slug) {
  const key = normalizeStreamer(slug);
  if (!key) return false;
  const raw = String(process.env.KICK_REWARDS_CHANNELS || "na5ty:1183030").trim();
  for (const part of raw.split(",")) {
    const envSlug = normalizeStreamer(part.split(":")[0]?.trim());
    if (envSlug && envSlug === key) return true;
  }
  return false;
}

function removeMonitoredStreamer(slug) {
  const normalized = normalizeStreamer(slug);
  if (!normalized) {
    throw new Error("Streamer slug is required");
  }
  if (isEnvLockedStreamer(normalized)) {
    throw new Error(`Cannot remove ${normalized} — locked in KICK_REWARDS_CHANNELS`);
  }

  const store = readStore();
  if (!Array.isArray(store.removedPartners)) {
    store.removedPartners = [];
  }
  const before = (store.monitoredChannels || []).length;
  store.monitoredChannels = (store.monitoredChannels || []).filter(
    (row) => normalizeStreamer(row.slug) !== normalized
  );
  if (!store.removedPartners.some((row) => normalizeStreamer(row) === normalized)) {
    store.removedPartners.push(normalized);
  }
  writeStore(store);

  return {
    slug: normalized,
    removed: store.monitoredChannels.length < before || true,
    locked: false,
  };
}

function listMonitoredChannels() {
  const store = readStore();
  const { slugToId } = getChannelMap();
  const chatSet = new Set(getChatMonitorSlugs());
  const seen = new Set();
  const rows = [];

  // Store is source of truth for the Only Pixels manage list (includes UI / FiveM adds).
  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug || seen.has(slug) || !partnerRegistry.isApproved(slug)) continue;
    seen.add(slug);
    rows.push({
      slug,
      broadcasterId: row.broadcasterId
        ? String(row.broadcasterId)
        : slugToId.get(slug) || null,
      inStore: true,
      locked: isEnvLockedStreamer(slug),
      chatPriority: row.chatPriority === true || chatSet.has(slug),
      chatroomId: row.chatroomId || null,
    });
  }

  // Approved channels can use env entries for broadcaster ID resolution.
  for (const application of partnerRegistry.listApplications()) {
    if (application.status !== "approved") continue;
    const slug = normalizeStreamer(application.kickUsername);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({
      slug,
      broadcasterId: slugToId.get(slug) || null,
      inStore: false,
      locked: isEnvLockedStreamer(slug),
      chatPriority: chatSet.has(slug),
      chatroomId: null,
    });
  }

  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
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
    if (key && partnerRegistry.isApproved(key)) merged.add(key);
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
  const entry = store.registrations.find((row) => row.gameLicense === license) || null;
  return entry;
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
  // FiveM cursor can sit ahead of the store after a redeploy/reset — resync or keywords never fire.
  if (after > maxId) {
    return {
      success: true,
      cursor: maxId,
      events: [],
      resync: true,
    };
  }

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

function parsePartnerSlugList() {
  const slugs = new Set();
  const raw = String(process.env.KICK_REWARDS_CHANNELS || "na5ty:1183030").trim();
  for (const part of raw.split(",")) {
    const slug = part.split(":")[0]?.trim();
    if (slug) slugs.add(normalizeStreamer(slug));
  }
  const extra = String(process.env.KICK_REWARD_PARTNER_SLUGS || "").trim();
  for (const part of extra.split(",")) {
    const slug = part.trim();
    if (slug) slugs.add(normalizeStreamer(slug));
  }
  return [...slugs];
}

function getRemovedPartnerSet() {
  const store = readStore();
  return new Set(
    (store.removedPartners || []).map((row) => normalizeStreamer(row)).filter(Boolean)
  );
}

function ensureDefaultPartners() {
  // Partnership starts from the approval registry; legacy/env lists no longer grant access.
  dedupePartnerSlugVariants();
  pruneChatPriorityToActive();
  return listMonitoredChannels();
}

/**
 * Prefer hyphenated Kick slugs; merge underscore variants into one row.
 */
function dedupePartnerSlugVariants() {
  const store = readStore();
  const byCompact = new Map();
  const next = [];

  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug) continue;
    const compact = compactStreamerSlug(slug);
    const existing = byCompact.get(compact);
    if (!existing) {
      byCompact.set(compact, { ...row, slug });
      continue;
    }
    // Prefer hyphen form, keep richest metadata.
    const preferHyphen = slug.includes("-") && !existing.slug.includes("-");
    const winner = preferHyphen ? { ...row, slug } : existing;
    const loser = preferHyphen ? existing : { ...row, slug };
    winner.broadcasterId = winner.broadcasterId || loser.broadcasterId || null;
    winner.chatroomId = winner.chatroomId || loser.chatroomId || null;
    winner.channelId = winner.channelId || loser.channelId || null;
    winner.chatPriority = winner.chatPriority === true || loser.chatPriority === true;
    winner.liveChat = winner.liveChat === true || loser.liveChat === true;
    winner.addedAt = winner.addedAt || loser.addedAt;
    byCompact.set(compact, winner);
  }

  for (const row of byCompact.values()) next.push(row);
  if (next.length !== (store.monitoredChannels || []).length) {
    console.log(
      `[kick-rewards] deduped partner slugs ${store.monitoredChannels.length} → ${next.length}`
    );
    store.monitoredChannels = next;
    writeStore(store);
  }
}

function getOwnerChatSlug() {
  return normalizeStreamer(
    process.env.KICK_OWNER_SLUG ||
      process.env.DEFAULT_BROADCASTER_SLUG ||
      "na5ty"
  );
}

/** Env-locked + owner channels must always stay on Pusher (OBS chat depends on this). */
function getAlwaysMonitorSlugs() {
  const slugs = new Set();
  const owner = getOwnerChatSlug();
  if (owner) slugs.add(owner);

  const raw = String(process.env.KICK_REWARDS_CHANNELS || "na5ty:1183030").trim();
  for (const part of raw.split(",")) {
    const slug = normalizeStreamer(part.split(":")[0]?.trim());
    if (slug) slugs.add(slug);
  }
  for (const rawExtra of String(process.env.KICK_MONITOR_EXTRA_SLUGS || "").split(",")) {
    const slug = normalizeStreamer(rawExtra);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/** Keep Pusher on owner/env/bootstrap/live/recent — demote the rest. */
function pruneChatPriorityToActive() {
  const keep = new Set(
    partnerRegistry
      .listApplications()
      .filter((row) => row.status === "approved")
      .map((row) => normalizeStreamer(row.kickUsername))
  );
  for (const slug of getStreamersWithRecentMessages(48)) {
    keep.add(normalizeStreamer(slug));
  }
  for (const slug of getAlwaysMonitorSlugs()) {
    keep.add(slug);
  }

  const store = readStore();
  let changed = 0;
  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug) continue;
    if (row.liveChat === true || isEnvLockedStreamer(slug) || keep.has(slug)) {
      if (row.chatPriority !== true) {
        row.chatPriority = true;
        changed += 1;
      }
      continue;
    }
    if (row.chatPriority === true) {
      row.chatPriority = false;
      changed += 1;
    }
  }
  if (changed) writeStore(store);
}

function markStreamerLiveChat(slug, live = true) {
  const key = normalizeStreamer(slug);
  if (!key) return null;
  const store = readStore();
  const row = (store.monitoredChannels || []).find(
    (item) => normalizeStreamer(item.slug) === key
  );
  if (!row) {
    return upsertMonitoredStreamer(key, null, { chatPriority: true });
  }
  row.liveChat = live === true;
  if (live) row.chatPriority = true;
  writeStore(store);
  return row;
}

/** Pusher targets: owner/env always + chatPriority / liveChat partners. */
function getChatMonitorSlugs() {
  const removed = getRemovedPartnerSet();
  const slugs = new Set();

  // Owner OBS chat must never drop off Pusher, even if partner registry flaps.
  for (const slug of getAlwaysMonitorSlugs()) {
    if (slug && !removed.has(slug)) slugs.add(slug);
  }

  const store = readStore();
  for (const row of store.monitoredChannels || []) {
    const slug = normalizeStreamer(row.slug);
    if (!slug || removed.has(slug)) continue;
    if (isEnvLockedStreamer(slug)) {
      slugs.add(slug);
      continue;
    }
    if (!partnerRegistry.isApproved(slug)) continue;
    if (row.chatPriority === true || row.liveChat === true) slugs.add(slug);
  }
  return [...slugs].filter(Boolean);
}

function getStoredChannelMeta(slug) {
  const key = normalizeStreamer(slug);
  const store = readStore();
  return (
    (store.monitoredChannels || []).find(
      (row) => normalizeStreamer(row.slug) === key
    ) || null
  );
}

function getStreamersWithRecentMessages(hours = 24) {
  const store = readStore();
  const cutoff = sinceMs(hours);
  const slugs = new Set();
  for (const row of store.messages) {
    if (cutoff && new Date(row.createdAt).getTime() < cutoff) continue;
    const slug = normalizeStreamer(row.streamer);
    if (slug && partnerRegistry.isApproved(slug)) slugs.add(slug);
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
  getChatMonitorSlugs,
  getStoredChannelMeta,
  markStreamerLiveChat,
  dedupePartnerSlugVariants,
  pruneChatPriorityToActive,
  getBroadcasterIdForSlug,
  getMonitoredBroadcasterIds,
  isMonitoredStreamer,
  upsertMonitoredStreamer,
  removeMonitoredStreamer,
  replaceMonitoredStreamers,
  mergeMonitoredStreamers,
  listMonitoredChannels,
  isEnvLockedStreamer,
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
  normalizeStreamer,
};
