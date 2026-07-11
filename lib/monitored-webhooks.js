const kickApi = require("./kick");
const tokenStore = require("./token-store");
const webhookSubscription = require("./webhook-subscription");

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

module.exports = {
  subscribeMonitoredStreamerWebhooks,
};
