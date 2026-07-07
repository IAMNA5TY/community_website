const kickApi = require("./kick");
const tokenStore = require("./token-store");
const webhookSubscription = require("./webhook-subscription");

function subscriptionEventsFromList(subs) {
  return (subs || []).map((sub) => sub.event || sub.name).filter(Boolean);
}

async function subscribeMonitoredStreamerWebhooks(broadcasterId, config) {
  const id = String(broadcasterId || "").trim();
  if (!id) return false;

  const ownerId = process.env.DEFAULT_BROADCASTER_ID || "1183030";
  const token = tokenStore.getBroadcasterToken(ownerId);
  if (!token?.accessToken) return false;

  try {
    const accessToken = await kickApi.ensureAccessTokenForBroadcaster(ownerId, config.kick);
    const subs = await kickApi.subscribeToChannelEvents(accessToken, id);
    const events = subscriptionEventsFromList(subs);
    const chatActive = events.includes("chat.message.sent");
    webhookSubscription.noteResult(id, { events, chatActive });
    console.log(
      `[webhooks] partner ${id}: ${chatActive ? "ready" : "incomplete"} (${events.join(", ") || "no events"})`
    );
    return chatActive;
  } catch (error) {
    webhookSubscription.noteResult(id, { error: error.message });
    console.warn(`[webhooks] partner subscribe failed for ${id}:`, error.message);
    return false;
  }
}

module.exports = {
  subscribeMonitoredStreamerWebhooks,
};
