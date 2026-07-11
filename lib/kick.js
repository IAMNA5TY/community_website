const API_BASE = "https://api.kick.com/public/v1";
const tokenStore = require("./token-store");

async function kickFetch(path, accessToken, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || response.statusText;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      const error = new Error(
        retryAfter
          ? `Rate limit exceeded. Retry in ${retryAfter}s`
          : "Rate limit exceeded"
      );
      error.status = 429;
      error.retryAfter = retryAfter;
      throw error;
    }
    throw new Error(message);
  }

  return data;
}

async function kickFetchSafe(path, accessToken, options = {}) {
  try {
    return await kickFetch(path, accessToken, options);
  } catch {
    return null;
  }
}

async function refreshAccessToken(config, refreshToken) {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Token refresh failed");
  }

  return data;
}

async function ensureAccessToken(req, config) {
  const user = req.session.user;
  if (!user?.accessToken) {
    throw new Error("Not authenticated");
  }

  const expiresSoon =
    user.expiresAt && user.expiresAt - Date.now() < 2 * 60 * 1000;

  if (!expiresSoon || !user.refreshToken) {
    return user.accessToken;
  }

  const tokens = await refreshAccessToken(config, user.refreshToken);
  user.accessToken = tokens.access_token;
  user.refreshToken = tokens.refresh_token || user.refreshToken;
  user.expiresAt = tokens.expires_in
    ? Date.now() + tokens.expires_in * 1000
    : null;
  user.scope = tokens.scope || user.scope;

  return user.accessToken;
}

async function ensureAccessTokenForBroadcaster(broadcasterUserId, config) {
  const stored = tokenStore.getBroadcasterToken(broadcasterUserId);
  if (!stored?.accessToken) {
    throw new Error("No Kick token on server — sign in at na5ty.com");
  }

  const expiresSoon =
    stored.expiresAt && stored.expiresAt - Date.now() < 2 * 60 * 1000;

  if (!expiresSoon || !stored.refreshToken) {
    return stored.accessToken;
  }

  const tokens = await refreshAccessToken(config, stored.refreshToken);
  tokenStore.saveBroadcasterToken(broadcasterUserId, {
    ...stored,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || stored.refreshToken,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : stored.expiresAt,
  });
  return tokens.access_token;
}

async function getCurrentUser(accessToken) {
  const data = await kickFetch("/users", accessToken);
  return data.data?.[0] || null;
}

async function getUsers(accessToken, userIds = []) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter(Boolean))];
  const path = ids.length
    ? `/users?${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`
    : "/users";
  const data = await kickFetchSafe(path, accessToken);
  return data?.data || [];
}

async function getChannel(accessToken) {
  const data = await kickFetch("/channels", accessToken);
  return data.data?.[0] || null;
}

async function getChannelsBySlugs(accessToken, slugs = []) {
  const list = [...new Set(slugs.map((s) => String(s || "").trim()).filter(Boolean))];
  if (!list.length) return [];
  const query = list.map((slug) => `slug=${encodeURIComponent(slug)}`).join("&");
  const data = await kickFetchSafe(`/channels?${query}`, accessToken);
  return data?.data || [];
}

async function getChannelsByBroadcasterIds(accessToken, broadcasterIds = []) {
  const list = [...new Set(broadcasterIds.map((id) => Number(id)).filter(Boolean))];
  if (!list.length) return [];
  const query = list
    .map((id) => `broadcaster_user_id=${encodeURIComponent(id)}`)
    .join("&");
  const data = await kickFetchSafe(`/channels?${query}`, accessToken);
  return data?.data || [];
}

async function getChannelLiveBySlugV2(slug) {
  const channelSlug = String(slug || "").trim();
  if (!channelSlug) return null;

  try {
    const response = await fetch(
      `https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "na5ty.com-kick-rewards/1",
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return {
      slug: data.slug || channelSlug,
      stream: { is_live: Boolean(data.livestream) },
    };
  } catch {
    return null;
  }
}

async function getLeaderboard(accessToken, top = 25) {
  const data = await kickFetch(`/kicks/leaderboard?top=${top}`, accessToken);
  return data.data || { week: [], month: [], lifetime: [] };
}

async function getEventSubscriptions(accessToken, broadcasterUserId) {
  const data = await kickFetchSafe(
    `/events/subscriptions?broadcaster_user_id=${broadcasterUserId}`,
    accessToken
  );
  return data?.data || [];
}

async function getChannelRewards(accessToken) {
  const data = await kickFetchSafe("/channels/rewards", accessToken);
  return data?.data || [];
}

async function getRewardRedemptions(accessToken, status) {
  const data = await kickFetchSafe(
    `/channels/rewards/redemptions?status=${status}`,
    accessToken
  );
  return data?.data || [];
}

async function getLivestreamStats(accessToken) {
  const data = await kickFetchSafe("/livestreams/stats", accessToken);
  return data?.data || null;
}

async function introspectToken(accessToken) {
  const response = await fetch("https://id.kick.com/oauth/token/introspect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return null;
  }

  return data.data || null;
}

function flattenRedemptions(groups) {
  const flat = [];

  for (const group of groups) {
    const rewardTitle = group.reward?.title || "Reward";
    for (const redemption of group.redemptions || []) {
      flat.push({
        id: redemption.id,
        status: redemption.status,
        rewardTitle,
        userInput: redemption.user_input || "",
        redeemedAt: redemption.redeemed_at,
        redeemerId: redemption.redeemer?.user_id
          ? String(redemption.redeemer.user_id)
          : null,
      });
    }
  }

  return flat.sort(
    (a, b) => new Date(b.redeemedAt).getTime() - new Date(a.redeemedAt).getTime()
  );
}

async function deleteEventSubscriptions(accessToken, subscriptionIds = []) {
  const ids = [...new Set(subscriptionIds.filter(Boolean))];
  if (!ids.length) return;

  const query = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  await kickFetch(`/events/subscriptions?${query}`, accessToken, {
    method: "DELETE",
  });
}

async function subscribeToChannelEvents(accessToken, broadcasterUserId, options = {}) {
  // Chat is read via Pusher (kick-pusher-monitor) — do not subscribe chat.message.sent
  // unless explicitly requested (burns Kick API quota and causes rate limits).
  const includeChat = options.includeChat === true;
  const events = [
    ...(includeChat ? [{ name: "chat.message.sent", version: 1 }] : []),
    { name: "channel.subscription.new", version: 1 },
    { name: "channel.subscription.gifts", version: 1 },
    { name: "channel.subscription.renewal", version: 1 },
    { name: "channel.followed", version: 1 },
    { name: "kicks.gifted", version: 1 },
  ];

  const existing = broadcasterUserId
    ? await getEventSubscriptions(accessToken, broadcasterUserId)
    : [];
  const existingEvents = new Set(
    existing.map((sub) => sub.event || sub.name).filter(Boolean)
  );
  const missing = options.force
    ? events
    : events.filter((event) => !existingEvents.has(event.name));

  if (!missing.length) {
    return existing;
  }

  const body = {
    events: missing,
    method: "webhook",
  };
  if (broadcasterUserId) {
    body.broadcaster_user_id = Number(broadcasterUserId);
  }

  const data = await kickFetch("/events/subscriptions", accessToken, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const merged = [...existing, ...(data.data || [])];
  return merged;
}

async function resubscribeChannelEvents(accessToken, broadcasterUserId, options = {}) {
  const existing = broadcasterUserId
    ? await getEventSubscriptions(accessToken, broadcasterUserId)
    : [];
  const ids = existing.map((sub) => sub.id).filter(Boolean);

  if (ids.length) {
    await deleteEventSubscriptions(accessToken, ids);
  }

  return subscribeToChannelEvents(accessToken, broadcasterUserId, {
    force: true,
    includeChat: options.includeChat === true,
  });
}

function mapChannel(channel) {
  if (!channel) return null;

  return {
    slug: channel.slug,
    title: channel.stream_title,
    description: channel.channel_description,
    bannerImage: channel.banner_picture || null,
    isLive: Boolean(channel.stream?.is_live),
    viewerCount: channel.stream?.viewer_count || 0,
    activeSubscribers: channel.active_subscribers_count || 0,
    canceledSubscribers: channel.canceled_subscribers_count || 0,
    category: channel.category?.name || null,
    categoryThumbnail: channel.category?.thumbnail || null,
    language: channel.stream?.language || null,
    isMature: Boolean(channel.stream?.is_mature),
    customTags: channel.stream?.custom_tags || [],
    streamStartedAt: channel.stream?.start_time || null,
    thumbnail: channel.stream?.thumbnail || null,
  };
}

function mapRewards(rewards) {
  return rewards.map((reward) => ({
    id: reward.id,
    title: reward.title,
    description: reward.description || "",
    cost: reward.cost,
    isEnabled: Boolean(reward.is_enabled),
    isPaused: Boolean(reward.is_paused),
    requiresInput: Boolean(reward.is_user_input_required),
    backgroundColor: reward.background_color || null,
  }));
}

function mapEventSubscriptions(subscriptions) {
  return subscriptions.map((sub) => ({
    id: sub.id,
    event: sub.event,
    method: sub.method,
    version: sub.version,
    createdAt: sub.created_at,
    updatedAt: sub.updated_at,
  }));
}

async function getDashboard(req, config) {
  const accessToken = await ensureAccessToken(req, config);
  const user = req.session.user;

  const [
    channel,
    leaderboard,
    rewards,
    pendingGroups,
    acceptedGroups,
    eventSubscriptions,
    livestreamStats,
    tokenInfo,
  ] = await Promise.all([
    getChannel(accessToken).catch(() => null),
    getLeaderboard(accessToken, 25).catch((error) => ({
      week: [],
      month: [],
      lifetime: [],
      error: error.message,
    })),
    getChannelRewards(accessToken),
    getRewardRedemptions(accessToken, "pending"),
    getRewardRedemptions(accessToken, "accepted"),
    getEventSubscriptions(accessToken, user.profile.id),
    getLivestreamStats(accessToken),
    introspectToken(accessToken),
  ]);

  const pendingRedemptions = flattenRedemptions(pendingGroups);
  const acceptedRedemptions = flattenRedemptions(acceptedGroups);
  const mappedRewards = mapRewards(rewards);

  return {
    profile: user.profile,
    channel: mapChannel(channel),
    leaderboard,
    rewards: mappedRewards,
    redemptions: {
      pending: pendingRedemptions.slice(0, 20),
      accepted: acceptedRedemptions.slice(0, 20),
      pendingCount: pendingRedemptions.length,
      acceptedCount: acceptedRedemptions.length,
    },
    eventSubscriptions: mapEventSubscriptions(eventSubscriptions),
    livestreamStats: livestreamStats
      ? { totalLivestreams: livestreamStats.total_count || 0 }
      : null,
    token: tokenInfo
      ? {
          active: Boolean(tokenInfo.active),
          scopes: tokenInfo.scope || user.scope || "",
          expiresAt: tokenInfo.exp ? new Date(tokenInfo.exp * 1000).toISOString() : null,
        }
      : {
          active: true,
          scopes: user.scope || "",
          expiresAt: user.expiresAt
            ? new Date(user.expiresAt).toISOString()
            : null,
        },
    apiSources: {
      channel: channel ? "public/v1/channels" : null,
      leaderboard: "public/v1/kicks/leaderboard",
      rewards: rewards.length ? "public/v1/channels/rewards" : null,
      redemptions: pendingGroups.length || acceptedGroups.length
        ? "public/v1/channels/rewards/redemptions"
        : null,
      eventSubscriptions: "public/v1/events/subscriptions",
      livestreamStats: livestreamStats ? "public/v1/livestreams/stats" : null,
    },
    webhookConfigured: Boolean(process.env.WEBHOOK_URL),
  };
}

async function sendChatMessage(accessToken, { broadcasterUserId, content, type = "user" }) {
  return kickFetch("/chat", accessToken, {
    method: "POST",
    body: JSON.stringify({
      broadcaster_user_id: broadcasterUserId,
      content,
      type,
    }),
  });
}

module.exports = {
  ensureAccessToken,
  ensureAccessTokenForBroadcaster,
  refreshTokens: refreshAccessToken,
  getCurrentUser,
  getUsers,
  getChannel,
  getChannelsBySlugs,
  getChannelsByBroadcasterIds,
  getChannelLiveBySlugV2,
  getLeaderboard,
  getEventSubscriptions,
  subscribeToChannelEvents,
  resubscribeChannelEvents,
  deleteEventSubscriptions,
  getDashboard,
  sendChatMessage,
};
