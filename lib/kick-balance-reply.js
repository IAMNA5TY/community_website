const kickApi = require("./kick");
const kickRewardsStore = require("./kick-rewards-store");

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

async function maybeReplyBalance(streamerSlug, username, controlEvent) {
  if (controlEvent?.action !== "balance") return false;

  const slug = normalizeName(streamerSlug);
  const user = normalizeName(username);
  if (!slug || !user) return false;

  const cooldownKey = `${slug}:${user}`;
  const now = Date.now();
  if (now - (lastReplyAt.get(cooldownKey) || 0) < COOLDOWN_MS) return false;
  lastReplyAt.set(cooldownKey, now);

  const row = kickRewardsStore.getViewerPointsOnChannel(slug, user, { hours: 24 });
  const points = Number(row?.points) || 0;
  const content = `@${user} ${points} Kick Point${points === 1 ? "" : "s"} on this stream.`;

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
};
