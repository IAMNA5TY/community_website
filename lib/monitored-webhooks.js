const kickApi = require("./kick");
const tokenStore = require("./token-store");
const webhookSubscription = require("./webhook-subscription");
const kickRewardsStore = require("./kick-rewards-store");

function subscriptionEventsFromList(subs) {
  return (subs || []).map((sub) => sub.event || sub.name).filter(Boolean);
}

/**
 * Partner chat is read via Pusher — do not subscribe chat.message.sent for every
 * partner (that is what rate-limits Kick). Optional kicks.gifted only when forced.
 */
async function subscribeMonitoredStreamerWebhooks(broadcasterId, config, options = {}) {
  const id = String(broadcasterId || "").trim();
  if (!id) return false;

  // Default: skip — Pusher handles partner chat counting + keywords.
  if (options.force !== true && process.env.KICK_PARTNER_WEBHOOKS !== "1") {
    return false;
  }

  const ownerId = process.env.DEFAULT_BROADCASTER_ID || "1183030";
  const token = tokenStore.getBroadcasterToken(ownerId);
  if (!token?.accessToken) return false;

  try {
    const accessToken = await kickApi.ensureAccessTokenForBroadcaster(ownerId, config.kick);
    const subs = await kickApi.subscribeToChannelEvents(accessToken, id, {
      includeChat: false,
    });
    const events = subscriptionEventsFromList(subs);
    webhookSubscription.noteResult(id, { events, chatActive: false });
    console.log(
      `[webhooks] partner ${id}: non-chat events (${events.join(", ") || "none"}) — chat via Pusher`
    );
    return true;
  } catch (error) {
    webhookSubscription.noteResult(id, { error: error.message });
    console.warn(`[webhooks] partner subscribe failed for ${id}:`, error.message);
    return false;
  }
}

function ownerSlug() {
  return String(process.env.KICK_OWNER_SLUG || process.env.DEFAULT_BROADCASTER_SLUG || "na5ty")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

async function tokenForPartnerChat(broadcasterId, config) {
  const own = tokenStore.getBroadcasterToken(broadcasterId);
  if (own?.accessToken) {
    try {
      return await kickApi.ensureAccessTokenForBroadcaster(broadcasterId, config.kick);
    } catch (error) {
      console.warn(
        `[webhooks] partner ${broadcasterId} token unusable: ${error.message}`
      );
    }
  }
  const ownerId = process.env.DEFAULT_BROADCASTER_ID || "1183030";
  return kickApi.ensureAccessTokenForBroadcaster(ownerId, config.kick);
}

let watchlistRunning = false;

/** Chat webhooks for the small watch list only. Do not subscribe every approved partner. */
async function ensureWatchlistChatWebhooks(config) {
  if (watchlistRunning) return;
  watchlistRunning = true;
  try {
    const owner = ownerSlug();
    const slugs = kickRewardsStore
      .getChatMonitorSlugs()
      .filter((slug) => slug && slug !== owner);
    for (const slug of slugs) {
      const id = kickRewardsStore.getBroadcasterIdForSlug(slug);
      if (!id) {
        console.log(`[webhooks] partner @${slug}: no broadcaster id, chat not subscribed`);
        continue;
      }
      const key = String(id);
      if (webhookSubscription.getCachedEvents(key).includes("chat.message.sent")) {
        continue;
      }
      if (
        webhookSubscription.isRateLimited(key) ||
        !webhookSubscription.shouldAttempt(key)
      ) {
        continue;
      }
      try {
        const accessToken = await tokenForPartnerChat(key, config);
        const subs = await kickApi.subscribeToChannelEvents(accessToken, key, {
          includeChat: true,
        });
        const events = subscriptionEventsFromList(subs);
        const chat = events.includes("chat.message.sent");
        webhookSubscription.noteResult(key, { events, chatActive: chat });
        console.log(
          `[webhooks] partner @${slug} ${key}: ${
            chat ? "chat.message.sent on" : "chat.message.sent missing"
          } (${events.join(", ") || "none"})`
        );
      } catch (error) {
        webhookSubscription.noteResult(key, {
          error: error.message,
          retryAfter: error.retryAfter,
        });
        console.warn(
          `[webhooks] partner @${slug} ${key} chat subscribe failed: ${error.message}`
        );
        if (/rate limit/i.test(String(error.message))) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    watchlistRunning = false;
  }
}

module.exports = {
  subscribeMonitoredStreamerWebhooks,
  ensureWatchlistChatWebhooks,
};
