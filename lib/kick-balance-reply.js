const kickApi = require("./kick");
const kickRewardsStore = require("./kick-rewards-store");
const partnerRegistry = require("./partner-registry");

const lastReplyAt = new Map();
const COOLDOWN_MS = 8000;

function kickConfig() {
  return {
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    redirectUri: process.env.KICK_REDIRECT_URI,
    tokenUrl: process.env.KICK_TOKEN_URL || "https://id.kick.com/oauth/token",
  };
}

function ownerBroadcasterId() {
  return String(
    process.env.DEFAULT_BROADCASTER_ID ||
      process.env.OWNER_BROADCASTER_IDS ||
      "1183030"
  )
    .split(",")[0]
    .trim();
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function streamerHandle(slug) {
  const app = partnerRegistry.getApplication?.(slug);
  const raw = String(app?.displayName || slug || "")
    .trim()
    .replace(/^@/, "");
  if (!raw) return "@thestreamer";
  if (normalizeName(raw) === "na5ty") return "@NA5TY";
  return `@${raw}`;
}

function formatBalanceReply(username, points, streamerSlug) {
  const who = streamerHandle(streamerSlug);
  const n = Number(points) || 0;
  if (n <= 0) {
    return `@${username} has 0 points in Only Pixels RP on ${who}'s stream. Chat to stack some, then take the wheel — left, right, or forward. Don’t forget tip — it’s free.`;
  }
  return `@${username} has ${n} point${n === 1 ? "" : "s"} in Only Pixels RP — ready to take the wheel on ${who}. left, right, or forward. Don’t forget tip — it’s free.`;
}

async function tokenFor(broadcasterId, config) {
  try {
    return await kickApi.ensureAccessTokenForBroadcaster(broadcasterId, config);
  } catch {
    return null;
  }
}

async function sendIntoChannel(channelId, content, config) {
  const ownerId = ownerBroadcasterId();
  const attempts = [
    { tokenId: String(channelId), type: "user" },
    { tokenId: String(channelId), type: "bot" },
    { tokenId: ownerId, type: "bot" },
    { tokenId: ownerId, type: "user" },
  ];

  let lastError = null;
  const tried = new Set();
  for (const attempt of attempts) {
    const key = `${attempt.tokenId}:${attempt.type}`;
    if (tried.has(key) || !attempt.tokenId) continue;
    tried.add(key);
    const accessToken = await tokenFor(attempt.tokenId, config);
    if (!accessToken) continue;
    try {
      await kickApi.sendChatMessage(accessToken, {
        broadcasterUserId: Number(channelId),
        content,
        type: attempt.type,
      });
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    console.warn(`[balance-reply] could not post in Kick chat: ${lastError.message}`);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedPoints(row) {
  if (!row || !Number.isFinite(Number(row.points))) return 0;
  return Math.max(0, Math.floor(Number(row.points)));
}

function pickBalancePoints(stored, chatPoints) {
  const synced = storedPoints(stored);
  if (synced > 0) return synced;
  return Math.max(0, Math.floor(Number(chatPoints) || 0));
}

async function waitForSyncedBalance(slug, user, queuedAt) {
  for (let i = 0; i < 8; i += 1) {
    await sleep(350);
    const stored = kickRewardsStore.getStoredViewerBalance(slug, user);
    const updated = stored ? new Date(stored.updatedAt).getTime() : 0;
    if (stored && updated >= queuedAt - 250) return stored;
  }
  return kickRewardsStore.getStoredViewerBalance(slug, user);
}

async function maybeReplyBalance(streamerSlug, username, controlEvent) {
  if (controlEvent?.action !== "balance") return false;

  const slug = normalizeName(streamerSlug);
  const user = normalizeName(username);
  if (!slug || !user) return false;

  const cooldownKey = `${slug}:${user}`;
  const now = Date.now();
  if (now - (lastReplyAt.get(cooldownKey) || 0) < COOLDOWN_MS) return false;
  lastReplyAt.set(cooldownKey, now);

  // Prefer a fresh in-game sync. If FiveM never posts, do not announce 0
  // when this channel already has a 24h chat total.
  const stored = await waitForSyncedBalance(slug, user, now);
  const chat = kickRewardsStore.computeViewerChatPoints(slug, user, { hours: 24 });
  const points = pickBalancePoints(stored, chat.points);
  const content = formatBalanceReply(user, points, slug);

  const channelId =
    kickRewardsStore.getBroadcasterIdForSlug(slug) ||
    (slug === "na5ty" ? ownerBroadcasterId() : null);
  if (!channelId) {
    console.warn(`[balance-reply] no Kick channel id for ${slug}`);
    return false;
  }

  return sendIntoChannel(channelId, content, kickConfig());
}

module.exports = {
  maybeReplyBalance,
  formatBalanceReply,
  pickBalancePoints,
};
