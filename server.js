require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const path = require("path");

const eventStore = require("./lib/event-store");
const chatEvents = require("./lib/chat-events");
const kickApi = require("./lib/kick");
const webhook = require("./lib/webhook");
const tokenStore = require("./lib/token-store");
const webhookState = require("./lib/webhook-state");
const webhookDebug = require("./lib/webhook-debug");
const webhookSubscription = require("./lib/webhook-subscription");
const botConfig = require("./lib/bot-config");
const botEngine = require("./lib/bot-engine");
const workoutState = require("./lib/workout-state");
const slotsState = require("./lib/slots-state");
const slotsEvents = require("./lib/slots-events");
const slotsProfiles = require("./lib/slots-profiles");
const slotsTimerState = require("./lib/slots-timer-state");
const slotsTimerEvents = require("./lib/slots-timer-events");
const drinkingState = require("./lib/drinking-state");
const drinkingEvents = require("./lib/drinking-events");
const workoutEvents = require("./lib/workout-events");
const subscriptionUtils = require("./lib/subscription-utils");
const { extractWebhookPayload } = require("./lib/webhook-payload");
const giftedSubLeaderboardApi = require("./lib/gifted-sub-leaderboard");
const spotify = require("./lib/spotify");
const spotifyState = require("./lib/spotify-state");
const spotifyEvents = require("./lib/spotify-events");
const spotifyOAuthPending = require("./lib/spotify-oauth-pending");
const hue = require("./lib/hue");
const govee = require("./lib/govee");
const goveeLan = require("./lib/govee-lan");
const lightingSyncConfig = require("./lib/lighting-sync-config");
const lightingLayout = require("./lib/lighting-layout");
const spotifyHueSync = require("./lib/spotify-hue-sync");
const systemAudio = require("./lib/system-audio-capture");
const alertEvents = require("./lib/alert-events");
const alertState = require("./lib/alert-state");
const alertUtils = require("./lib/alert-utils");
const stakeApi = require("./lib/stake");

systemAudio.onBeat(() => {
  const broadcasterId = tokenStore.getPrimaryBroadcasterId();
  if (broadcasterId) {
    spotifyHueSync.onAudioBeat(broadcasterId);
  }
});
const stakeAffiliate = require("./lib/stake-affiliate");
const signInLog = require("./lib/sign-in-log");
const kickRewardsStore = require("./lib/kick-rewards-store");
const { createKickRewardsRouter } = require("./lib/kick-rewards-routes");
const kickPusherMonitor = require("./lib/kick-pusher-monitor");
const dashboardAccess = require("./lib/dashboard-access");
const discord = require("./lib/discord");
const kickSubscriberStore = require("./lib/kick-subscriber-store");
const discordSubRoleRecheck = require("./lib/discord-sub-role-recheck");
const discordGateway = require("./lib/discord-gateway");
const discordRoleWatch = require("./lib/discord-role-watch");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `${BASE_URL}/webhooks/kick`;
const DEFAULT_BROADCASTER_ID = String(process.env.DEFAULT_BROADCASTER_ID || "1183030");

function publicBaseUrl(req) {
  const fromEnv = String(process.env.BASE_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const proto =
    req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "https";
  const host =
    req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "localhost";
  return `${proto}://${host}`;
}

function kickRedirectUri(req) {
  return `${publicBaseUrl(req)}/auth/kick/callback`;
}

function getAllowedBroadcasterIds() {
  const raw = String(process.env.ALLOWED_BROADCASTER_IDS ?? "*").trim();
  if (!raw || raw === "*") return null;
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function isAllowedBroadcaster(broadcasterId, username) {
  const allowed = getAllowedBroadcasterIds();
  if (!allowed) return true;
  if (allowed.has(String(broadcasterId))) return true;

  const allowedNames = String(process.env.ALLOWED_KICK_USERNAMES || "na5ty")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedNames.length) return false;

  return allowedNames.includes(String(username || "").toLowerCase());
}

const config = {
  kick: {
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    authorizeUrl: "https://id.kick.com/oauth/authorize",
    tokenUrl: "https://id.kick.com/oauth/token",
    userUrl: "https://api.kick.com/public/v1/users",
    scope:
      "user:read channel:read channel:rewards:read kicks:read events:subscribe chat:write",
  },
};

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use((req, res, next) => {
  if (req.path.startsWith("/slots/") || req.path.startsWith("/api/slots")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  if (req.path.startsWith("/widgets/") || req.path.startsWith("/api/chat") || req.path.startsWith("/api/alerts")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  if (req.path.startsWith("/api/spotify")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  if (req.path.startsWith("/drinking/") || req.path.startsWith("/api/drinking")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  // Dashboard shell + app.js change often; don't let CDN keep a stale bundle.
  if (
    req.path === "/" ||
    req.path === "/index.html" ||
    req.path === "/app.js" ||
    req.path === "/styles.css"
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" ? "auto" : false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  if (!req.session?.user || req.session.user.provider !== "kick") return next();
  if (
    dashboardAccess.isDashboardOwner(req.session.user) ||
    dashboardAccess.isPartnerStaff(req.session.user)
  ) return next();

  const apiPath = req.path.replace(/^\/api/, "") || "/";
  if (dashboardAccess.isPlayerAllowedApiPath(apiPath)) return next();
  return res.status(403).json({ error: "Forbidden" });
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", createKickRewardsRouter(config));

function randomState() {
  return crypto.randomBytes(24).toString("hex");
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

async function exchangeForm(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data.error_description || data.error || data.message || response.statusText;
    throw new Error(message);
  }
  return data;
}

function saveUserSession(req, profile, tokens) {
  req.session.user = {
    provider: "kick",
    profile,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : null,
    scope: tokens.scope || null,
  };

  try {
    tokenStore.saveBroadcasterToken(profile.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: req.session.user.expiresAt,
      username: profile.username,
    });
  } catch (error) {
    console.warn("[auth] token store save failed:", error.message);
  }
}

function redirectWithSession(req, res, url) {
  req.session.save((err) => {
    if (err) {
      return res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
    res.redirect(url);
  });
}

function buildWebhookNote(req) {
  if (WEBHOOK_URL.includes("localhost") || WEBHOOK_URL.includes("127.0.0.1")) {
    return "Kick cannot reach localhost. Use ngrok and set WEBHOOK_URL in .env, then put that URL in Kick Developer → Enable Webhooks (not Redirect URLs).";
  }

  const broadcasterId = req.session.user?.profile?.id;
  if (broadcasterId && webhookSubscription.isRateLimited(broadcasterId)) {
    const retryAt = webhookSubscription.rateLimitRetryAt(broadcasterId);
    return `Kick API rate limit — sub/gift webhook setup paused until ${retryAt ? new Date(retryAt).toLocaleTimeString() : "later"}. Chat still works via Pusher. Auto-retry is slowed so we stop burning Kick quota.`;
  }

  if (!req.session.webhookReady) {
    const err = req.session.webhookError;
    if (err && /rate limit/i.test(err)) {
      return `Kick API rate limit — wait a bit, then refresh. Chat still works via Pusher. Webhook URL for subs/gifts: ${WEBHOOK_URL}.`;
    }
    if (err) {
      return `${err} In Kick Developer → Enable Webhooks, set Webhook URL = ${WEBHOOK_URL} (for subs/gifts — chat uses Pusher).`;
    }
    return `Chat is read via Pusher (no chat webhook needed). For subs/gifts, set Kick Developer → Enable Webhooks → ${WEBHOOK_URL}.`;
  }

  return null;
}

function subscriptionEventsFromList(subs) {
  return (subs || []).map((sub) => sub.event || sub.name).filter(Boolean);
}

async function setupKickSubscriptions(req, options = {}) {
  const broadcasterId = req.session.user?.profile?.id;
  if (!broadcasterId) {
    req.session.webhookReady = false;
    req.session.webhookError = "Not signed in";
    return;
  }

  const force = Boolean(options.force);
  const sessionReady = Boolean(req.session.webhookReady);

  if (
    !force &&
    !webhookSubscription.shouldAttempt(broadcasterId, { chatActive: sessionReady })
  ) {
    if (webhookSubscription.isRateLimited(broadcasterId)) {
      req.session.webhookError = "Rate limit exceeded";
      if (webhookSubscription.getCachedChatActive(broadcasterId)) {
        req.session.webhookReady = true;
        req.session.webhookError = null;
      }
    }
    return;
  }

  try {
    const accessToken = await kickApi.ensureAccessToken(req, config.kick);
    let subs;
    if (force) {
      subs = await kickApi.resubscribeChannelEvents(accessToken, broadcasterId);
    } else {
      subs = await kickApi.subscribeToChannelEvents(accessToken, broadcasterId);
    }

    const events = subscriptionEventsFromList(subs);
    // Chat is via Pusher — "ready" means we have a token + non-chat webhooks (or Pusher on).
    const hasSubEvents = events.some((name) => String(name).startsWith("channel.subscription"));
    const pusherOn = String(process.env.KICK_PUSHER_MONITOR || "1") !== "0";
    req.session.webhookReady = hasSubEvents || pusherOn || events.length > 0;
    req.session.webhookError = null;

    webhookSubscription.noteResult(broadcasterId, {
      events,
      chatActive: pusherOn || events.includes("chat.message.sent"),
    });

    console.log(
      `[webhooks] ${broadcasterId}: ready (chat=Pusher, events=${events.join(", ") || "none"})`
    );
  } catch (error) {
    webhookSubscription.noteResult(broadcasterId, {
      error: error.message,
      retryAfter: error.retryAfter,
    });
    if (/rate limit/i.test(error.message)) {
      // Chat doesn't need webhooks — still mark ready so the banner isn't scary.
      if (String(process.env.KICK_PUSHER_MONITOR || "1") !== "0") {
        req.session.webhookReady = true;
        req.session.webhookError = null;
        console.warn("[webhooks] rate limited — chat via Pusher, sub webhooks will retry later");
        return;
      }
      if (webhookSubscription.getCachedChatActive(broadcasterId)) {
        req.session.webhookReady = true;
        req.session.webhookError = null;
        return;
      }
    }
    req.session.webhookReady = false;
    req.session.webhookError = error.message;
    console.warn("[webhooks] subscribe failed:", error.message);
  }
}

async function ensureStoredWebhookSubscriptions(options = {}) {
  const token = tokenStore.getBroadcasterToken(DEFAULT_BROADCASTER_ID);
  if (!token?.accessToken) {
    if (options.webhookUrlChanged) {
      console.warn(
        "[webhooks] webhook URL changed but no saved Kick token — sign in at na5ty.com once"
      );
    }
    return;
  }

  let accessToken;
  try {
    accessToken = await kickApi.ensureAccessTokenForBroadcaster(
      DEFAULT_BROADCASTER_ID,
      config.kick
    );
  } catch (error) {
    console.warn("[webhooks] boot subscribe failed — no access token:", error.message);
    return;
  }

  // Only the owner channel needs Kick webhooks (subs/gifts for workout).
  // Partner chat is Pusher-only — mass partner subscribe is what rate-limits Kick.
  const broadcasterIds = [String(DEFAULT_BROADCASTER_ID)];
  const force = Boolean(options.webhookUrlChanged);

  for (const broadcasterId of broadcasterIds) {
    if (!broadcasterId) continue;
    if (!webhookSubscription.shouldAttempt(broadcasterId, { force })) {
      if (webhookSubscription.isRateLimited(broadcasterId)) {
        console.warn(`[webhooks] boot subscribe skipped for ${broadcasterId} — rate limit`);
      }
      continue;
    }

    try {
      const subs = force
        ? await kickApi.resubscribeChannelEvents(accessToken, broadcasterId)
        : await kickApi.subscribeToChannelEvents(accessToken, broadcasterId, {
            includeChat: false,
          });
      const events = subscriptionEventsFromList(subs);
      webhookSubscription.noteResult(broadcasterId, {
        events,
        chatActive: String(process.env.KICK_PUSHER_MONITOR || "1") !== "0",
      });
      console.log(
        `[webhooks] boot ${broadcasterId}: non-chat events (${events.join(", ") || "none"}) — partner chat via Pusher`
      );
    } catch (error) {
      webhookSubscription.noteResult(broadcasterId, {
        error: error.message,
        retryAfter: error.retryAfter,
      });
      console.warn(`[webhooks] boot subscribe failed for ${broadcasterId}:`, error.message);
      if (/rate limit/i.test(error.message)) {
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function subscribeMonitoredStreamerWebhooks(broadcasterId) {
  return require("./lib/monitored-webhooks").subscribeMonitoredStreamerWebhooks(
    broadcasterId,
    config
  );
}

async function bootstrapKickRewardPartners() {
  kickRewardsStore.ensureDefaultPartners();
  const slugsNeedingIds = kickRewardsStore
    .listMonitoredChannels()
    .filter((row) => !row.broadcasterId)
    .map((row) => row.slug);

  if (!slugsNeedingIds.length) return kickRewardsStore.listMonitoredChannels();

  const token = tokenStore.getBroadcasterToken(DEFAULT_BROADCASTER_ID);
  if (!token?.accessToken) return kickRewardsStore.listMonitoredChannels();

  try {
    const accessToken = await kickApi.ensureAccessTokenForBroadcaster(
      DEFAULT_BROADCASTER_ID,
      config.kick
    );
    for (let i = 0; i < slugsNeedingIds.length; i += 50) {
      const channels = await kickApi.getChannelsBySlugs(
        accessToken,
        slugsNeedingIds.slice(i, i + 50)
      );
      for (const channel of channels) {
        const slug = String(channel.slug || "").toLowerCase();
        const broadcasterId = channel.broadcaster_user_id
          ? String(channel.broadcaster_user_id)
          : null;
        if (slug && broadcasterId) {
          kickRewardsStore.upsertMonitoredStreamer(slug, broadcasterId);
          subscribeMonitoredStreamerWebhooks(broadcasterId).catch((error) => {
            console.warn(`[kick-rewards] partner webhook subscribe failed for ${slug}:`, error.message);
          });
        }
      }
    }
  } catch (error) {
    console.warn("[kick-rewards] partner broadcaster id lookup failed:", error.message);
  }

  return kickRewardsStore.listMonitoredChannels();
}

function resolveWebhookBroadcasterId(payload) {
  return (
    payload.broadcaster?.user_id ||
    payload.broadcaster_user_id ||
    payload.channel?.user_id ||
    tokenStore.getPrimaryBroadcasterId() ||
    DEFAULT_BROADCASTER_ID
  );
}

app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    startedAt: process.env.BOOT_STARTED_AT || null,
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.json({ loggedIn: false });
  }

  const { provider, profile, scope } = req.session.user;
  const role = dashboardAccess.getDashboardRole(req.session.user);
  const kickUsername = profile?.username || "";
  const kickRewards = kickUsername
    ? kickRewardsStore.getRewardsSummary(kickUsername)
    : null;
  res.json({
    loggedIn: true,
    provider,
    profile,
    scope,
    role,
    allowedPages: dashboardAccess.getAllowedPages(req.session.user),
    isOwner: role === "owner",
    kickRewards,
    discord: kickSubscriberStore.getPublicStatusForKickUser(
      profile?.id,
      kickUsername
    ),
    webhookReady: Boolean(req.session.webhookReady),
    webhookUrl: WEBHOOK_URL,
  });
});

app.get("/api/auth/kick-info", (req, res) => {
  res.json({
    configured: Boolean(config.kick.clientId),
    redirectUri: kickRedirectUri(req),
    baseUrl: publicBaseUrl(req),
  });
});

app.get("/api/discord/status", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  const kickUsername = user.profile?.username || "";
  kickSubscriberStore.refreshEligibilityFromHistory(
    user.profile?.id,
    kickUsername,
    eventStore,
    DEFAULT_BROADCASTER_ID
  );
  res.json({
    ok: true,
    ...kickSubscriberStore.getPublicStatusForKickUser(user.profile?.id, kickUsername),
    redirectUri: discord.redirectUri(req),
  });
});

app.post("/api/discord/claim", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    if (!discord.configured()) {
      return res.status(503).json({
        success: false,
        error: "Discord is not fully configured on the server",
      });
    }

    const kickUsername = user.profile?.username || "";
    const link = kickSubscriberStore.getLinkForKickUser(user.profile.id);
    if (!link?.discordId) {
      kickSubscriberStore.recordClaimAttempt({
        kickUsername,
        kickUserId: user.profile.id,
        result: "not-linked",
        reason: "Link Discord first",
      });
      return res.status(400).json({
        success: false,
        error: "Link Discord first",
      });
    }

    const eligibility = kickSubscriberStore.refreshEligibilityFromHistory(
      user.profile.id,
      kickUsername,
      eventStore,
      DEFAULT_BROADCASTER_ID
    );
    const active = eligibility.eligible;
    if (!active) {
      kickSubscriberStore.recordClaimAttempt({
        discordId: link.discordId,
        kickUsername,
        kickUserId: user.profile.id,
        result: "not-eligible",
        reason: "No Kick sub badge/webhook on record yet",
      });
      return res.status(403).json({
        success: false,
        error:
          `No active Kick sub on record for @${kickSubscriberStore.normalizeUsername(kickUsername)} yet. ` +
          `Kick does not give us a live sub list — type once in na5ty Kick chat while subbed with your sub badge visible, ` +
          `or ask the owner to Mark as sub if your badge is hidden, then try again. ` +
          `Or subscribe at https://kick.com/na5ty/subscribe.`,
      });
    }

    await discord.addSubRole(link.discordId);
    const sub =
      kickSubscriberStore.getSubscriber(kickUsername) ||
      kickSubscriberStore.getSubscriber(user.profile.id);
    kickSubscriberStore.recordGrant(link.discordId, {
      kickUsername,
      kickUserId: user.profile.id,
      active: true,
      expiresAt: sub?.expiresAt || null,
      lastCheckedAt: new Date().toISOString(),
    });
    kickSubscriberStore.recordClaimAttempt({
      discordId: link.discordId,
      kickUsername,
      kickUserId: user.profile.id,
      result: "granted",
      reason: eligibility.reason || "subscriber",
    });

    try {
      const announcement = await discord.announceSubRoleChange({
        kickName: kickUsername || user.profile?.username,
        action: "granted",
        reason: eligibility.reason,
      });
      const announceNote = announcement.posted
        ? " Public thank-you posted in Discord."
        : ` Public thank-you failed: ${announcement.error || "unknown"}.`;
      res.json({
        success: true,
        announcement,
        message:
          (eligibility.reason === "owner"
            ? "Channel owner — Discord linked and subscriber role granted."
            : "Subscriber role granted on Discord.") + announceNote,
        discord: kickSubscriberStore.getPublicStatusForKickUser(
          user.profile.id,
          kickUsername
        ),
      });
    } catch (error) {
      console.warn("[discord] claim announcement failed:", error.message);
      res.json({
        success: true,
        message:
          eligibility.reason === "owner"
            ? "Channel owner — role granted, but public thank-you failed."
            : "Subscriber role granted, but public thank-you failed.",
        discord: kickSubscriberStore.getPublicStatusForKickUser(
          user.profile.id,
          kickUsername
        ),
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/discord/unlink", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  try {
    const existing = kickSubscriberStore.unlinkDiscord(user.profile.id);
    if (existing?.discordId && discord.configured()) {
      try {
        await discord.removeSubRole(existing.discordId);
      } catch {
        /* ignore */
      }
      kickSubscriberStore.recordGrant(existing.discordId, {
        kickUsername: user.profile?.username,
        kickUserId: user.profile.id,
        active: false,
        revokeReason: "unlink",
      });
      try {
        await discord.announceSubRoleChange({
          kickName: user.profile?.username || existing.kickUsername,
          action: "revoked",
          reason: "unlink",
        });
      } catch (error) {
        console.warn("[discord] unlink announcement failed:", error.message);
      }
    }
    res.json({
      success: true,
      discord: kickSubscriberStore.getPublicStatusForKickUser(
        user.profile.id,
        user.profile?.username
      ),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/discord/subscribers", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json({
    ok: true,
    subscribers: kickSubscriberStore.listActiveSubscribers(200),
    chatBadges: kickSubscriberStore.listChatBadgeRoster(200),
    grants: kickSubscriberStore.listGrants(100),
    recheck: discordSubRoleRecheck.getLastRun(),
    recheckIntervalMs: discordSubRoleRecheck.getRecheckIntervalMs(),
    recheckBatchSize: discordSubRoleRecheck.getBatchSize(),
    roleWatch: discordRoleWatch.getStatus(),
    botInviteUrl: discord.botInviteUrl(),
  });
});

app.post("/api/discord/recheck", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const forceAll = Boolean(req.body?.forceAll);
    const result = await discordSubRoleRecheck.runRecheck(kickSubscriberStore, {
      forceAll,
    });
    res.json({
      success: Boolean(result.ok),
      ...result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Owner: demote RoleLogic + strip Manage Roles so it cannot strip Kick Supporter. */
app.post("/api/discord/block-rolelogic", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    if (!discord.configured()) {
      return res.status(503).json({
        success: false,
        error: "Discord is not fully configured on the server",
      });
    }
    if (req.body?.kick === true || req.body?.kickRoleLogic === true) {
      const kicked = await discord.kickRoleLogicFromGuild(
        "Owner stopped RoleLogic Kick Supporter strip loop"
      );
      return res.json({
        success: Boolean(kicked.ok),
        ...kicked,
      });
    }
    const result = await discord.blockRoleLogicFromManagingSubRole();
    res.json({
      success: Boolean(result.ok),
      ...result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Owner: give / re-apply Discord sub role for a Kick user (or Discord id). */
app.post("/api/discord/give-role", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    if (!discord.configured()) {
      return res.status(503).json({
        success: false,
        error: "Discord is not fully configured on the server",
      });
    }

    const kickUsername = String(req.body?.kickUsername || req.body?.username || "")
      .trim()
      .replace(/^@/, "");
    let discordId = String(req.body?.discordId || "").trim();
    let kickUserId = req.body?.kickUserId ? String(req.body.kickUserId) : null;

    if (!discordId) {
      if (kickUserId) {
        const link = kickSubscriberStore.getLinkForKickUser(kickUserId);
        if (link?.discordId) discordId = String(link.discordId);
      }
      if (!discordId && kickUsername) {
        const name = kickSubscriberStore.normalizeUsername(kickUsername);
        const fromGrant = kickSubscriberStore
          .listGrants(500)
          .find((g) => kickSubscriberStore.normalizeUsername(g.kickUsername) === name);
        if (fromGrant?.discordId) {
          discordId = String(fromGrant.discordId);
          kickUserId = kickUserId || fromGrant.kickUserId || null;
        }
      }
      if (!discordId && kickUsername) {
        const name = kickSubscriberStore.normalizeUsername(kickUsername);
        const fromRoster = kickSubscriberStore
          .listChatBadgeRoster(500)
          .find((r) => kickSubscriberStore.normalizeUsername(r.username) === name);
        if (fromRoster?.discordId) {
          discordId = String(fromRoster.discordId);
          kickUserId = kickUserId || fromRoster.kickUserId || null;
        }
      }
    }

    if (!discordId) {
      return res.status(400).json({
        success: false,
        error: kickUsername
          ? `@${kickUsername} has not linked Discord yet — they need to Link Discord on na5ty.com first.`
          : "discordId or kickUsername required",
      });
    }

    // Owner give always marks them eligible + ensures Discord role.
    if (kickUsername) {
      kickSubscriberStore.markSubscriberManual({
        username: kickUsername,
        userId: kickUserId,
      });
    }

    const ensured = await discord.ensureSubRole(discordId);
    kickSubscriberStore.recordGrant(discordId, {
      kickUsername: kickUsername || null,
      kickUserId,
      active: true,
      lastCheckedAt: new Date().toISOString(),
      revokeReason: null,
    });

    let hasRole = true;
    try {
      hasRole = await discord.memberHasSubRole(discordId);
    } catch {
      hasRole = Boolean(ensured?.ok);
    }

    res.json({
      success: true,
      discordId,
      kickUsername: kickUsername || null,
      alreadyHad: Boolean(ensured.alreadyHad),
      restored: Boolean(ensured.restored),
      hasRole,
      message: ensured.alreadyHad
        ? `@${kickUsername || discordId} already has the Discord subscriber role.`
        : `Gave Discord subscriber role to @${kickUsername || discordId}.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Owner: manually mark a Kick username as an active sub (Kick has no live sub roster API). */
app.post("/api/discord/mark-subscriber", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const username = String(req.body?.username || "").trim();
    if (!username) {
      return res.status(400).json({ success: false, error: "username required" });
    }
    const row = kickSubscriberStore.markSubscriberManual({
      username,
      userId: req.body?.userId || null,
      days: req.body?.days || null,
    });
    if (!row) {
      return res.status(400).json({ success: false, error: "Invalid username" });
    }
    res.json({
      success: true,
      subscriber: row,
      message: `Marked @${row.username} as an active Kick sub until ${new Date(row.expiresAt).toLocaleString()}. They can claim the Discord role now.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Owner: force a public thank-you / revoke test message into the Discord panel channel. */
app.post("/api/discord/announce-test", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    if (!discord.configured()) {
      return res.status(503).json({ success: false, error: "Discord not configured" });
    }
    const action =
      String(req.body?.action || "granted").trim() === "revoked" ? "revoked" : "granted";
    const result = await discord.announceSubRoleChange({
      kickName: user.profile?.username || "na5ty",
      action,
      reason: action === "granted" ? "owner" : "unlink",
    });
    res.json({
      success: Boolean(result.posted),
      ...result,
      message: result.posted
        ? `Posted public message in Discord: ${result.text}`
        : `Failed to post public message: ${result.error}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Public diagnostic — does not expose the key, only whether Discord buttons can work. */
app.get("/api/discord/interactions-health", (_req, res) => {
  const keyStatus = discord.publicKeyStatus();
  res.json({
    ok: keyStatus.valid,
    interactionsUrl: "https://na5ty.com/api/discord/interactions",
    publicKey: keyStatus,
    hint: keyStatus.valid
      ? "Public key looks valid. In Discord Developer Portal set Interactions Endpoint URL to https://na5ty.com/api/discord/interactions and Save."
      : "Railway DISCORD_PUBLIC_KEY is wrong. Paste the Public Key from Discord Developer Portal → your app → General Information (64 hex characters). You currently have something else (often the Application/Client ID).",
  });
});

/** Discord Interactions Endpoint — set in Developer Portal to https://na5ty.com/api/discord/interactions */
app.post("/api/discord/interactions", async (req, res) => {
  const verified = discord.verifyInteractionSignature(req);
  if (!verified.ok) {
    console.warn("[discord-interactions] verify failed:", verified.error);
    return res.status(401).send(verified.error || "invalid request signature");
  }

  const interaction = req.body;

  // Discord endpoint validation + keep-alive
  if (interaction?.type === discord.InteractionType.PING) {
    return res.json({ type: discord.InteractionResponseType.PONG });
  }

  // ACK within 3s, then grant role / reply via follow-up edit.
  if (
    interaction?.type === discord.InteractionType.MESSAGE_COMPONENT &&
    interaction?.data?.custom_id === discord.SUB_ROLE_BUTTON_ID
  ) {
    res.json(discord.deferredEphemeralAck());
    try {
      const result = await discord.resolveComponentInteraction(
        interaction,
        kickSubscriberStore
      );
      await discord.editInteractionReply(interaction, result);
    } catch (error) {
      console.warn("[discord-interactions] follow-up failed:", error.message);
      try {
        await discord.editInteractionReply(interaction, {
          content: `Something went wrong: ${error.message}`,
        });
      } catch (followErr) {
        console.warn(
          "[discord-interactions] follow-up retry failed:",
          followErr.message
        );
      }
    }
    return;
  }

  try {
    const response = await discord.handleInteraction(
      interaction,
      kickSubscriberStore
    );
    return res.json(response);
  } catch (error) {
    console.warn("[discord-interactions]", error.message);
    return res.json({
      type: discord.InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `Something went wrong: ${error.message}`,
        flags: 64,
      },
    });
  }
});

app.post("/api/discord/panel", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    if (!discord.configured()) {
      return res.status(503).json({
        success: false,
        error: "Discord is not fully configured on the server",
      });
    }
    const keyStatus = discord.publicKeyStatus();
    const channelId =
      String(req.body?.channelId || "").trim() ||
      discord.getConfig().panelChannelId;
    const posted = await discord.postSubRolePanel(channelId);
    kickSubscriberStore.setDiscordPanelMeta(posted);
    const warning = keyStatus.valid
      ? null
      : `Panel posted, but the Get Subscriber Role button will NOT work until Railway DISCORD_PUBLIC_KEY is fixed. ${keyStatus.error}. Copy Public Key (64 hex chars) from Discord Developer Portal → General Information — not the Application ID.`;
    res.json({
      success: true,
      panel: posted,
      publicKeyStatus: keyStatus,
      warning,
      message: warning
        ? `Posted panel, but button is broken: ${keyStatus.error}`
        : `Posted subscriber role panel in channel ${posted.channelId}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/discord/panel", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json({
    ok: true,
    channelId: discord.getConfig().panelChannelId,
    panel: kickSubscriberStore.getDiscordPanelMeta(),
    interactionsUrl: `${publicBaseUrl(req)}/api/discord/interactions`,
    publicKeyConfigured: Boolean(discord.getConfig().publicKey),
    publicKeyStatus: discord.publicKeyStatus(),
    botInviteUrl: discord.botInviteUrl(),
  });
});

app.get("/auth/discord", (req, res) => {
  if (!req.session.user || req.session.user.provider !== "kick") {
    return res.redirect("/auth/kick");
  }
  if (!discord.configured()) {
    return res.redirect("/?error=discord_not_configured");
  }

  const state = randomState();
  req.session.oauthState = {
    provider: "discord",
    state,
    redirectUri: discord.redirectUri(req),
    returnTo: "/#discord",
  };
  redirectWithSession(req, res, discord.authorizeUrl(req, state));
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    return res.redirect(
      `/#discord?error=${encodeURIComponent(errorDescription || error)}`
    );
  }

  const saved = req.session.oauthState;
  if (!saved || saved.provider !== "discord" || saved.state !== state) {
    return res.redirect("/#discord?error=invalid_state");
  }
  delete req.session.oauthState;

  if (!req.session.user || req.session.user.provider !== "kick") {
    return res.redirect("/auth/kick");
  }

  try {
    const tokens = await discord.exchangeCode(req, code);
    const discordUser = await discord.fetchOauthUser(tokens.access_token);
    kickSubscriberStore.linkDiscordAccount(
      req.session.user.profile.id,
      req.session.user.profile.username,
      discordUser
    );
    redirectWithSession(req, res, "/#discord");
  } catch (err) {
    redirectWithSession(
      req,
      res,
      `/#discord?error=${encodeURIComponent(err.message)}`
    );
  }
});

app.get("/api/admin/sign-ins", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  if (!dashboardAccess.isDashboardOwner(user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json({ entries: signInLog.getRecent(50) });
});

app.get("/api/leaderboards", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const accessToken = await kickApi.ensureAccessToken(req, config.kick);
    const channel = await kickApi.getChannel(accessToken).catch(() => null);
    const slug =
      channel?.slug ||
      user.profile?.username?.toLowerCase?.() ||
      String(user.profile?.username || "").toLowerCase();
    const force = req.query.refresh === "1" || req.query.refresh === "true";

    const [kicksLeaderboard, giftedSubLeaderboard] = await Promise.all([
      kickApi.getLeaderboard(accessToken, 25).catch((error) => ({
        week: [],
        month: [],
        lifetime: [],
        error: error.message,
      })),
      giftedSubLeaderboardApi.getGiftedSubLeaderboard(slug, 25, { force }),
    ]);

    res.json({
      slug,
      leaderboard: kicksLeaderboard,
      giftedSubLeaderboard,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/dashboard", async (req, res) => {
  if (!req.session.user || req.session.user.provider !== "kick") {
    return res.status(401).json({ error: "Not signed in with Kick" });
  }

  const user = req.session.user;
  const isOwner = dashboardAccess.isDashboardOwner(user);

  try {
    if (!isOwner) {
      const dashboard = await kickApi.getDashboard(req, config.kick);
      const stored = eventStore.getChannelData(user.profile.id);
      const kickUsername = user.profile?.username || dashboard.profile?.username || "";
      const kickRewards = kickUsername
        ? kickRewardsStore.getRewardsSummary(kickUsername)
        : null;
      const registration = kickUsername
        ? kickRewardsStore.getRegistration(kickUsername)
        : null;

      return res.json({
        role: "player",
        allowedPages: dashboardAccess.getAllowedPages(user),
        profile: dashboard.profile,
        channel: dashboard.channel,
        livestreamStats: dashboard.livestreamStats,
        chat: stored,
        kickRewards,
        registration,
        webhookReady: false,
        webhookError: null,
        webhookUrl: WEBHOOK_URL,
        webhookNote: null,
      });
    }

    // Do NOT re-register Kick webhooks on every dashboard poll (15s) — that burns API quota.
    // Registration happens on login, boot, explicit reregister, and a slow background tick.

    const dashboard = await kickApi.getDashboard(req, config.kick);
    const stored = eventStore.getChannelData(req.session.user.profile.id);
    const giftedSubLeaderboard = await giftedSubLeaderboardApi.getGiftedSubLeaderboard(
      dashboard.channel?.slug,
      25
    );
    const kickUsername =
      user.profile?.username || dashboard.profile?.username || "";
    const kickRewards = kickUsername
      ? kickRewardsStore.getRewardsSummary(kickUsername)
      : null;
    const registration = kickUsername
      ? kickRewardsStore.getRegistration(kickUsername)
      : null;

    res.json({
      ...dashboard,
      role: "owner",
      kickRewards,
      registration,
      discord: kickSubscriberStore.getPublicStatusForKickUser(
        req.session.user.profile.id,
        kickUsername
      ),
      allowedPages: dashboardAccess.getAllowedPages(user),
      giftedSubLeaderboard,
      spotify: {
        configured: spotify.isConfigured(),
        connected: Boolean(spotify.getToken(req.session.user.profile.id)),
        displayName: spotify.getToken(req.session.user.profile.id)?.displayName || null,
        redirectUri: spotifyRedirectUri(req),
        playback: await spotifyState.loadForBroadcaster(req.session.user.profile.id),
      },
      lighting: {
        hue: {
          ...hue.getPublicStatus(req.session.user.profile.id),
          defaultBridgeIp: process.env.HUE_BRIDGE_IP || "192.168.1.177",
        },
        govee: govee.getPublicStatus(req.session.user.profile.id),
        layout: lightingLayout.getLayout(req.session.user.profile.id),
        sync: {
          ...lightingSyncConfig.getSettings(req.session.user.profile.id),
          runtime: spotifyHueSync.getRuntimeStatus(),
          ready:
            hue.isConnected(req.session.user.profile.id) &&
            Boolean(spotify.getToken(req.session.user.profile.id)),
        },
      },
      chat: stored,
      bot: botConfig.getBotConfig(req.session.user.profile.id),
      workout: workoutState.loadForDisplay(),
      slots: slotsState.load(),
      slotsTimer: slotsTimerState.load(),
      drinking: drinkingState.load(),
      slotsUrls: {
        widget: `${BASE_URL}/slots/slots-widget.html?obs=1&v=7`,
        pickAlert: `${BASE_URL}/slots/slots-pick.html?obs=1&v=10`,
        timer: `${BASE_URL}/slots/slots-timer.html?obs=1&v=7`,
        controlPanel: `${BASE_URL}/slots/slots-control-panel.html`,
        controlWidget: `${BASE_URL}/slots/slots-control-panel.html?embed=1`,
      },
      widgetsUrls: {
        chatBox: `${BASE_URL}/widgets/chat-box.html?obs=1&broadcasterId=${DEFAULT_BROADCASTER_ID}`,
        streamAlerts: `${BASE_URL}/widgets/stream-alerts.html?obs=1`,
        nowPlaying: `${BASE_URL}/widgets/now-playing.html?obs=1`,
        camOverlay: `${BASE_URL}/widgets/cam-overlay.html?obs=1&v=12`,
        camSmoke: `${BASE_URL}/widgets/cam-smoke.html?obs=1&v=12`,
        camShadow: `${BASE_URL}/widgets/cam-drop-shadow.png`,
      },
      drinkingUrls: {
        beerCounter: `${BASE_URL}/drinking/beer-counter.html`,
        shotgunCam: `${BASE_URL}/drinking/shotgun-cam.html?obs=1`,
        shotgunAlert: `${BASE_URL}/drinking/shotgun-alert.html?obs=1`,
        sceneWidget: `${BASE_URL}/drinking/widget-scene.html`,
        controlPanel: `${BASE_URL}/drinking/control-panel.html`,
        controlWidget: `${BASE_URL}/drinking/control-panel.html?embed=1`,
      },
      stakeUrls: {
        raceLeaderboard: `${BASE_URL}/stake/stake-race.html`,
        affiliateLeaderboard: `${BASE_URL}/stake/stake-affiliate.html`,
      },
      obsUrls: {
        controlPanel: `${BASE_URL}/workout/control-panel.html`,
        controlWidget: `${BASE_URL}/workout/control-panel.html?embed=1`,
        sceneWidget: `${BASE_URL}/workout/widget-scene.html`,
        startingSoon: `${BASE_URL}/workout/starting-soon.html?obs=1&v=4`,
        startingSoonWidget: `${BASE_URL}/workout/starting-soon-widget.html`,
        treadmill: `${BASE_URL}/workout/treadmill-tracker.html?obs=1&v=14`,
        stats: `${BASE_URL}/workout/workout-stats.html?obs=1&v=14`,
        rules: `${BASE_URL}/workout/rules-banner.html?obs=1&v=12`,
        subAlert: `${BASE_URL}/workout/sub-alert.html?obs=1&v=14`,
        scene: `${BASE_URL}/workout/just-chatting.html?obs=1&v=14`,
      },
      obsHostNote:
        BASE_URL.includes("localhost") || BASE_URL.includes("127.0.0.1")
          ? "Local OBS only — for stream use https://na5ty.com workout URLs so dashboard + OBS share one bank."
          : "Use these na5ty.com links in OBS (do not mix with localhost).",
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: req.session.webhookError || null,
      webhookUrl: WEBHOOK_URL,
      webhookNote: buildWebhookNote(req),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function requireKickUser(req, res) {
  if (!req.session.user || req.session.user.provider !== "kick") {
    res.status(401).json({ error: "Not signed in with Kick" });
    return null;
  }
  return req.session.user;
}

function isLocalRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "");
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip === "::ffff:127.0.0.1" ||
    req.hostname === "localhost"
  );
}

app.get("/api/bot", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(botConfig.getBotConfig(user.profile.id));
});

app.post("/api/bot/commands", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const command = botConfig.addCommand(user.profile.id, req.body);
    res.json({ ok: true, command });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/bot/commands/:id", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    botConfig.deleteCommand(user.profile.id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/bot/timers", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const timer = botConfig.addTimer(user.profile.id, req.body);
    botEngine.refreshTimersForBroadcaster(user.profile.id, config.kick);
    res.json({ ok: true, timer });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/bot/timers/:id", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    botConfig.deleteTimer(user.profile.id, req.params.id);
    botEngine.stopTimer(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/bot/timers/:id/toggle", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const timer = botConfig.toggleTimer(
      user.profile.id,
      req.params.id,
      req.body.enabled
    );
    botEngine.refreshTimersForBroadcaster(user.profile.id, config.kick);
    res.json({ ok: true, timer });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/bot/test", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const message = req.body.message || "Bot test message!";
    await botEngine.sendChatMessage(user.profile.id, message, config.kick);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/test/sub", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const broadcasterId = user.profile.id;
  const eventType = req.body.eventType || "channel.subscription.new";
  const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
  const payload = {
    broadcaster_user_id: broadcasterId,
    subscriber: { username: req.body.username || "TestSub" },
    gifter: { username: req.body.username || "TestGifter" },
    quantity,
  };

  if (eventType === "channel.subscription.gifts") {
    payload.giftees = Array.from({ length: quantity }, (_, i) => ({
      username: `GiftRecipient${i + 1}`,
    }));
  }

  const resolvedQuantity = subscriptionUtils.parseSubscriptionQuantity(eventType, payload);

  eventStore.addSubscriptionEvent(broadcasterId, eventType, payload);
  try {
    kickSubscriberStore.recordSubscriptionEvent(eventType, payload);
  } catch (error) {
    console.warn("[discord-subs] test sub roster failed:", error.message);
  }
  if (subscriptionUtils.shouldCreditWorkout(eventType)) {
    botEngine.handleSubscriptionEvent(resolvedQuantity);
  }

  const alert = alertUtils.buildAlert(eventType, payload);
  if (alert) alertState.pushAlert(alert);

  res.json({
    ok: true,
    message: `Simulated ${resolvedQuantity} sub(s) — same path as a live Kick webhook`,
    workout: workoutState.loadForDisplay(),
  });
});

app.post("/api/test/chat", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const broadcasterId = user.profile.id;
  const payload = {
    message_id: `test-${Date.now()}`,
    content: req.body.message || "Test chat message from dashboard",
    sender: {
      username: req.body.username || "TestViewer",
      user_id: 0,
      is_moderator: false,
      is_subscriber: false,
    },
    broadcaster_user_id: broadcasterId,
  };

  const message = eventStore.addChatMessage(String(broadcasterId), payload);
  chatEvents.broadcastMessage(message);
  workoutState.incrementMessagesForBroadcaster(broadcasterId);

  botEngine
    .handleChatMessage(String(broadcasterId), payload, config.kick)
    .catch((error) => {
      console.error("Test chat command failed:", error.message);
    });

  res.json({
    ok: true,
    message: "Simulated chat message — commands processed like a live Kick webhook",
    drinking: drinkingState.load(),
    workout: workoutState.loadForDisplay(),
  });
});

app.get("/api/slots", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(slotsState.load());
});

app.get("/api/chat/messages", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const broadcasterId =
    req.query.broadcasterId ||
    tokenStore.getPrimaryBroadcasterId() ||
    workoutState.load().broadcasterUserId ||
    DEFAULT_BROADCASTER_ID;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));

  if (!broadcasterId) {
    return res.json({ messages: [], broadcasterId: null });
  }

  res.json({
    broadcasterId: String(broadcasterId),
    messages: eventStore.getRecentMessages(broadcasterId, limit),
  });
});

app.get("/api/chat/status", (req, res) => {
  const broadcasterId =
    req.query.broadcasterId ||
    tokenStore.getPrimaryBroadcasterId() ||
    workoutState.load().broadcasterUserId ||
    DEFAULT_BROADCASTER_ID;
  const messages = broadcasterId
    ? eventStore.getRecentMessages(broadcasterId, 1)
    : [];
  const token = broadcasterId
    ? tokenStore.getBroadcasterToken(broadcasterId)
    : null;
  const pusherOn = String(process.env.KICK_PUSHER_MONITOR || "1") !== "0";
  const ownerSlug = String(
    process.env.KICK_OWNER_SLUG || process.env.DEFAULT_BROADCASTER_SLUG || "na5ty"
  ).toLowerCase();
  const pusherStatus = pusherOn ? kickPusherMonitor.getStatus() : null;
  const ownerMonitor = (pusherStatus?.streamers || []).find(
    (row) => String(row.slug || "").toLowerCase() === ownerSlug
  );

  res.json({
    broadcasterId: broadcasterId ? String(broadcasterId) : null,
    messageCount: broadcasterId
      ? eventStore.getChannelData(broadcasterId).stats?.totalMessages ?? 0
      : 0,
    hasMessages: messages.length > 0,
    kickSignedInOnServer: Boolean(token?.accessToken),
    webhookConfigured: Boolean(process.env.WEBHOOK_URL),
    webhookUrl: WEBHOOK_URL,
    liveChatRequiresWebhooks: false,
    chatSource: pusherOn ? "pusher" : "webhook",
    pusherEnabled: pusherOn,
    pusherConnected: Boolean(ownerMonitor?.connected),
    pusherMessagesRecorded: ownerMonitor?.messagesRecorded || 0,
    pusherLastMessageAt: ownerMonitor?.lastMessageAt || null,
    pusherLastError: ownerMonitor?.lastError || null,
  });
});

app.get("/api/webhooks/debug", async (req, res) => {
  const broadcasterId = DEFAULT_BROADCASTER_ID;
  const token = tokenStore.getBroadcasterToken(broadcasterId);

  let subscribedEvents = [];
  let subscriptionError = null;

  if (token?.accessToken) {
    try {
      const accessToken = await kickApi.ensureAccessTokenForBroadcaster(
        broadcasterId,
        config.kick
      );
      const subs = await kickApi.getEventSubscriptions(accessToken, broadcasterId);
      subscribedEvents = subs.map((sub) => sub.event || sub.name).filter(Boolean);
    } catch (error) {
      subscriptionError = error.message;
    }
  }

  const storedByBroadcaster = eventStore.getMessageCountsByBroadcaster();
  const channelMessages = eventStore.getRecentMessages(broadcasterId, 10);

  res.json({
    ok: true,
    webhookUrl: WEBHOOK_URL,
    expectedBroadcasterId: broadcasterId,
    kickSignedInOnServer: Boolean(token?.accessToken),
    chatWebhookActive: subscribedEvents.includes("chat.message.sent"),
    subscribedEvents,
    subscriptionError,
    messageCountForChannel: eventStore.getChannelData(broadcasterId).stats?.totalMessages ?? 0,
    storedByBroadcaster,
    recentStoredMessages: channelMessages,
    webhookState: webhookState.getWebhookState(),
    clientIdPrefix: config.kick.clientId
      ? `${config.kick.clientId.slice(0, 6)}…${config.kick.clientId.slice(-4)}`
      : null,
    expectedClientIdPrefix: "01KWJ2…C2GKV",
    ...webhookDebug.getDebugSnapshot(),
    hints: buildWebhookDebugHints({
      subscribedEvents,
      storedByBroadcaster,
      broadcasterId,
      debug: webhookDebug.getDebugSnapshot(),
    }),
  });
});

function buildWebhookDebugHints({ subscribedEvents, storedByBroadcaster, broadcasterId, debug }) {
  const hints = [];
  const pusherOn = String(process.env.KICK_PUSHER_MONITOR || "1") !== "0";

  if (!subscribedEvents.includes("chat.message.sent")) {
    if (pusherOn) {
      hints.push("chat.message.sent webhook skipped on purpose — partner/owner chat is read via Pusher");
    } else {
      hints.push("chat.message.sent is not subscribed — sign in at na5ty.com");
    }
  }

  if (debug.kickHits === 0 && debug.totalHits > 0) {
    hints.push(
      "Hits seen but none from Kick (missing Kick-Event-* headers) — only manual tests reached the server so far"
    );
  }

  if (debug.kickHits === 0) {
    hints.push(
      "Kick has not POSTed yet. Toggle webhooks OFF→Save→ON→Save in Kick Developer, sign out/in at na5ty.com, then chat. If still 0, check Cloudflare Security → Events for blocked POSTs to /webhooks/kick"
    );
  }

  if (debug.totalRejected > 0 && debug.lastRejection?.reason === "invalid_signature") {
    hints.push("Webhooks are arriving but signatures fail — check Railway logs for rejected events");
  }

  if (debug.totalRejected > 0 && debug.lastRejection?.reason?.startsWith("missing_")) {
    hints.push("Webhooks arrive without Kick signature headers — proxy may be stripping headers");
  }

  const otherChannels = Object.keys(storedByBroadcaster).filter(
    (id) => id !== broadcasterId && id !== "unknown"
  );
  if (otherChannels.length) {
    hints.push(`Messages stored under other broadcaster IDs: ${otherChannels.join(", ")}`);
  }

  if (storedByBroadcaster.unknown > 0) {
    hints.push('Some chat stored under "unknown" — broadcaster ID missing from Kick payload');
  }

  if (debug.totalChatStored > 0 && (storedByBroadcaster[broadcasterId] || 0) === 0) {
    hints.push("Chat webhooks stored but not under your channel ID — check OBS broadcasterId param");
  }

  if (!hints.length) {
    hints.push("Type in Kick chat and refresh — lastChatAt should update within a few seconds");
  }

  return hints;
}

app.get("/api/webhooks/health", async (req, res) => {
  const broadcasterId = DEFAULT_BROADCASTER_ID;
  const token = tokenStore.getBroadcasterToken(broadcasterId);
  const messageCount =
    eventStore.getChannelData(broadcasterId).stats?.totalMessages ?? 0;

  let subscribedEvents = webhookSubscription.getCachedEvents(broadcasterId);
  let chatWebhookActive = subscribedEvents.includes("chat.message.sent");
  let subscriptionError = null;

  if (token?.accessToken && !webhookSubscription.isRateLimited(broadcasterId)) {
    const shouldRefresh = webhookSubscription.shouldAttempt(broadcasterId, {
      chatActive: subscribedEvents.length > 0,
    });
    if (shouldRefresh || !subscribedEvents.length) {
      try {
        const accessToken = await kickApi.ensureAccessTokenForBroadcaster(
          broadcasterId,
          config.kick
        );
        const subs = await kickApi.getEventSubscriptions(accessToken, broadcasterId);
        subscribedEvents = subs.map((sub) => sub.event || sub.name).filter(Boolean);
        chatWebhookActive = subscribedEvents.includes("chat.message.sent");
        webhookSubscription.noteResult(broadcasterId, {
          events: subscribedEvents,
          chatActive: chatWebhookActive,
        });
      } catch (error) {
        subscriptionError = error.message;
        if (/rate limit/i.test(error.message)) {
          webhookSubscription.noteResult(broadcasterId, {
            error: error.message,
            retryAfter: error.retryAfter,
          });
        }
      }
    }
  } else if (webhookSubscription.isRateLimited(broadcasterId)) {
    subscriptionError = "Rate limit exceeded";
  }

  res.json({
    ok: true,
    webhookUrl: WEBHOOK_URL,
    kickSignedInOnServer: Boolean(token?.accessToken),
    messageCount,
    subscribedEvents,
    chatWebhookActive,
    subscriptionError,
    debug: webhookDebug.getDebugSnapshot({
      storedByBroadcaster: eventStore.getMessageCountsByBroadcaster(),
      recentStoredMessages: eventStore.getRecentMessagesAll(8),
    }),
    setup: [
      `Kick Developer → Enable Webhooks → Webhook URL = ${WEBHOOK_URL}`,
      "Redirect URLs are only for sign-in — do not put the webhook URL there",
      "Sign in at na5ty.com — webhooks register automatically on login",
      "Live chat works when viewers type in Kick chat",
    ],
  });
});

app.post("/api/webhooks/reregister", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const broadcasterId = user.profile.id;
  if (webhookSubscription.isRateLimited(broadcasterId)) {
    return res.status(429).json({
      ok: false,
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: "Rate limit exceeded",
      retryAfter: webhookSubscription.rateLimitRetryAt(broadcasterId),
      message: "Kick API rate limit — wait 10–15 minutes before re-registering.",
    });
  }

  await setupKickSubscriptions(req, { force: true });

  try {
    const accessToken = await kickApi.ensureAccessToken(req, config.kick);
    const subs = await kickApi.getEventSubscriptions(accessToken, user.profile.id);
    const events = subscriptionEventsFromList(subs);

    res.json({
      ok: Boolean(req.session.webhookReady),
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: req.session.webhookError || null,
      subscribedEvents: events,
      chatWebhookActive: events.includes("chat.message.sent"),
    });
  } catch (error) {
    if (/rate limit/i.test(error.message)) {
      webhookSubscription.noteResult(broadcasterId, {
        error: error.message,
        retryAfter: error.retryAfter,
      });
    }
    res.status(500).json({
      ok: false,
      webhookReady: false,
      webhookError: error.message,
    });
  }
});

app.get("/api/webhooks/status", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const broadcasterId = user.profile.id;
  const cached = webhookSubscription.getCachedEvents(broadcasterId);

  if (webhookSubscription.isRateLimited(broadcasterId)) {
    return res.json({
      webhookUrl: WEBHOOK_URL,
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: "Rate limit exceeded",
      subscribedEvents: cached,
      chatWebhookActive: cached.includes("chat.message.sent"),
      kickDeveloperMustMatch: WEBHOOK_URL,
      rateLimited: true,
      retryAfter: webhookSubscription.rateLimitRetryAt(broadcasterId),
    });
  }

  // Prefer cache so status polling does not burn Kick quota.
  if (
    cached.length &&
    !webhookSubscription.shouldAttempt(broadcasterId, { chatActive: true })
  ) {
    return res.json({
      webhookUrl: WEBHOOK_URL,
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: req.session.webhookError || null,
      subscribedEvents: cached,
      chatWebhookActive: cached.includes("chat.message.sent"),
      kickDeveloperMustMatch: WEBHOOK_URL,
      cached: true,
    });
  }

  try {
    const accessToken = await kickApi.ensureAccessToken(req, config.kick);
    const subs = await kickApi.getEventSubscriptions(accessToken, broadcasterId);
    const events = subscriptionEventsFromList(subs);
    webhookSubscription.noteResult(broadcasterId, {
      events,
      chatActive: events.includes("chat.message.sent"),
    });

    res.json({
      webhookUrl: WEBHOOK_URL,
      webhookReady: Boolean(req.session.webhookReady),
      webhookError: req.session.webhookError || null,
      subscribedEvents: events,
      chatWebhookActive: events.includes("chat.message.sent"),
      kickDeveloperMustMatch: WEBHOOK_URL,
    });
  } catch (error) {
    if (/rate limit/i.test(error.message)) {
      webhookSubscription.noteResult(broadcasterId, {
        error: error.message,
        retryAfter: error.retryAfter,
      });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/chat/events", (req, res) => {
  chatEvents.subscribe(res);
});

app.get("/api/alerts/state", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(alertState.load());
});

app.get("/api/alerts/events", (req, res) => {
  alertEvents.subscribe(res);
  const state = alertState.load();
  if (state.alertNonce > 0 && state.lastAlert) {
    res.write(`data: ${JSON.stringify({ event: "alert", ...state })}\n\n`);
  }
});

function handleTestAlert(req, res) {
  const started = Date.now();
  const type = req.body?.type || req.query?.type || "sub";
  const quantity = req.body?.quantity ?? req.query?.quantity;
  const username = req.body?.username || req.query?.username || "TestViewer";
  const alert = alertUtils.buildTestAlert(type, { username, quantity });

  if (!alert) {
    console.warn(`[test-alert] reject unknown type=${type}`);
    return res.status(400).json({ error: "Unknown alert type" });
  }

  const state = alertState.pushAlert(alert);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, alertNonce: state.alertNonce, lastAlert: state.lastAlert });
  console.log(
    `[test-alert] ${req.method} type=${type} nonce=${state.alertNonce} ${Date.now() - started}ms`
  );
}

app.post("/api/test/alert", (req, res) => {
  handleTestAlert(req, res);
});

app.get("/api/test/alert", (req, res) => {
  handleTestAlert(req, res);
});

app.get("/api/slots-timer", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(slotsTimerState.load());
});

app.get("/api/slots-timer/events", (req, res) => {
  slotsTimerEvents.subscribe(res, slotsTimerState.load());
});

app.post("/api/slots-timer", (req, res) => {
  try {
    if (req.body?.action) {
      const result = slotsTimerState.applyAction(req.body);
      if (result.error) return res.status(400).json({ error: result.error });
      slotsTimerEvents.broadcastTimer(result.state);
      return res.json(result.state);
    }
    const state = slotsTimerState.save(req.body);
    slotsTimerEvents.broadcastTimer(state);
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/slots/events", (req, res) => {
  slotsEvents.subscribe(res);
});

app.get("/api/drinking", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(drinkingState.load());
});

app.get("/api/drinking/events", (req, res) => {
  drinkingEvents.subscribe(res);
});

app.post("/api/drinking", (req, res) => {
  try {
    const { action, count, goal, by } = req.body || {};
    if (!action) {
      return res.json(drinkingState.save(req.body));
    }

    const result = drinkingState.applyAction({ action, count, goal, by });
    if (result.error) return res.status(400).json({ error: result.error });

    if (action === "add") {
      drinkingEvents.broadcastShotgun(result.state);
    } else if (action === "cheer") {
      drinkingEvents.broadcastCheers(result.state);
    }

    return res.json(result.state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function broadcastSlotsPick(state) {
  slotsEvents.broadcastPick(state);
}

async function pickSlotsAndBroadcast(broadcasterUserId) {
  const result = slotsState.pickRandom();
  if (result.error) {
    return result;
  }

  await slotsProfiles.enrichSlotsPick(result.state, config.kick, broadcasterUserId);
  broadcastSlotsPick(result.state);
  return result;
}

function testUserMeta(user) {
  return {
    userId: user?.profile?.id ? String(user.profile.id) : null,
    profilePicture: user?.profile?.profileImage || null,
  };
}

app.post("/api/slots", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const { action, slotName, username } = req.body;

    if (action === "pick") {
      const result = await pickSlotsAndBroadcast(user.profile.id);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, slots: result.state, pick: result.pick });
    }

    if (action === "clear") {
      return res.json({ ok: true, slots: slotsState.clearQueue() });
    }

    if (action === "clearPick") {
      return res.json({ ok: true, slots: slotsState.clearLastPick() });
    }

    if (action === "add") {
      const result = slotsState.addRequest(
        username || "TestUser",
        slotName,
        req.body.userMeta || testUserMeta(user)
      );
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, slots: result.state, request: result.request });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/test/slots-request", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const result = slotsState.addRequest(
    req.body.username || "TestViewer",
    req.body.slotName || "Test Slot",
    testUserMeta(user)
  );
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({
    ok: true,
    message: "Simulated !sr request",
    slots: result.state,
  });
});

app.post("/api/test/slots-pick", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const result = await pickSlotsAndBroadcast(user.profile.id);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({
    ok: true,
    message: `Picked ${result.pick.slotName} for ${result.pick.username}`,
    slots: result.state,
    pick: result.pick,
  });
});

app.get("/api/stake/status", async (_req, res) => {
  try {
    res.json(await stakeApi.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/stake/races", async (_req, res) => {
  try {
    if (!stakeApi.isConfigured()) {
      return res.status(400).json({ error: "Stake.us access token not configured" });
    }
    res.json(await stakeApi.getRaces());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/stake/leaderboard", async (req, res) => {
  try {
    if (!stakeApi.isConfigured()) {
      return res.status(400).json({ error: "Stake.us access token not configured" });
    }

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const raceId = req.query.raceId;

    const data = raceId
      ? await stakeApi.getRaceLeaderboard(String(raceId), limit)
      : await stakeApi.getActiveLeaderboard(limit);

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/stake/affiliate/leaderboard", async (req, res) => {
  try {
    if (!stakeApi.isConfigured()) {
      return res.status(400).json({ error: "Stake.us access token not configured" });
    }

    const data = await stakeAffiliate.getAffiliateLeaderboard({
      code: req.query.code,
      period: req.query.period || "month",
      limit: req.query.limit,
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/state", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(workoutState.loadForDisplay());
});

app.get("/api/workout/events", (req, res) => {
  workoutEvents.subscribe(res);
});

app.post("/api/state", (req, res) => {
  try {
    if (req.body?.action === "restoreLastGood") {
      const result = workoutState.restoreLastGood();
      if (result.error) {
        return res.status(400).json({ error: result.error });
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json(workoutState.loadForDisplay());
    }
    workoutState.save(req.body, { clientSync: true });
    res.setHeader("Cache-Control", "no-store");
    res.json(workoutState.loadForDisplay());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/workout", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(workoutState.load());
});

app.post("/api/workout", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const { action, ...fields } = req.body;
    let state = workoutState.load();

    if (action === "addSub") state = workoutState.addSub(fields.count || 1);
    else if (action === "addMinutes") state = workoutState.addMinutes(fields.count || 1);
    else if (action === "setTotals") state = workoutState.setTotals(fields.subs, fields.minutes);
    else if (action === "start") {
      const result = workoutState.startTreadmill();
      if (result.error) return res.status(400).json({ error: result.error });
      state = result.state;
    } else if (action === "stop") state = workoutState.stopTreadmill();
    else if (action === "reset") state = workoutState.resetSession();
    else if (action === "restoreLastGood") {
      const result = workoutState.restoreLastGood();
      if (result.error) return res.status(400).json({ error: result.error });
      state = result.state;
    } else state = workoutState.save(fields);

    res.json({ ok: true, workout: state });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

function spotifyRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) {
    return process.env.SPOTIFY_REDIRECT_URI;
  }
  const host = String(req.get("host") || "127.0.0.1:3000").replace(/^localhost/i, "127.0.0.1");
  return `${req.protocol}://${host}/auth/spotify/callback`;
}

function dashboardReturnUrl(req) {
  const referer = req.get("referer");
  if (referer && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?/i.test(referer)) {
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}`;
    } catch {
      /* ignore */
    }
  }
  return BASE_URL;
}

function resolveSpotifyBroadcasterId(req, res) {
  if (req.session.user?.provider === "kick") {
    return String(req.session.user.profile.id);
  }

  const primaryId = tokenStore.getPrimaryBroadcasterId();
  if (primaryId) {
    return String(primaryId);
  }

  res.redirect(
    `/?error=${encodeURIComponent("Sign in with Kick on this site first, then connect Spotify")}`
  );
  return null;
}

app.get("/auth/spotify", (req, res) => {
  if (!spotify.isConfigured()) {
    return res.redirect("/?error=spotify_not_configured");
  }

  const broadcasterId = resolveSpotifyBroadcasterId(req, res);
  if (!broadcasterId) return;

  const redirectUri = spotifyRedirectUri(req);
  const state = randomState();
  const returnTo = dashboardReturnUrl(req);

  spotifyOAuthPending.prune();
  spotifyOAuthPending.save(state, {
    broadcasterId,
    redirectUri,
    returnTo,
  });

  res.redirect(spotify.getAuthorizeUrl(state, redirectUri));
});

app.get("/auth/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const pending = state ? spotifyOAuthPending.take(String(state)) : null;
  const returnTo = pending?.returnTo || BASE_URL;

  if (error) {
    return res.redirect(`${returnTo}/?error=${encodeURIComponent(String(error))}`);
  }

  if (!pending) {
    return res.redirect(`${returnTo}/?error=invalid_spotify_state`);
  }

  try {
    const tokens = await spotify.exchangeCode(code, pending.redirectUri);
    const spotifyTokens = require("./lib/spotify-tokens");
    spotifyTokens.saveToken(pending.broadcasterId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scope: tokens.scope || "",
      displayName: null,
    });
    const profile = await spotify.getProfile(pending.broadcasterId).catch(() => null);
    if (profile?.display_name) {
      spotifyTokens.updateToken(pending.broadcasterId, {
        displayName: profile.display_name,
      });
    }
    await spotifyState.refreshPlayback(pending.broadcasterId, { force: true });
    res.redirect(`${returnTo}/?spotify=connected`);
  } catch (err) {
    res.redirect(`${returnTo}/?error=${encodeURIComponent(err.message)}`);
  }
});

app.post("/auth/spotify/disconnect", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  spotify.deleteToken(user.profile.id);
  res.json({ ok: true });
});

app.get("/api/lighting/hue/status", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(hue.getPublicStatus(user.profile.id));
});

app.post("/api/lighting/hue/discover", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const bridges = await hue.discoverBridges(user.profile.id);
    res.json({ bridges });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/lighting/hue/connect", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const bridgeIp = String(req.body?.bridgeIp || "").trim();
  if (!bridgeIp) {
    return res.status(400).json({ error: "Bridge IP is required" });
  }

  try {
    const config = await hue.connectBridge(user.profile.id, bridgeIp);
    res.json({
      ok: true,
      ...hue.getPublicStatus(user.profile.id),
      bridgeName: config.bridgeName,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/hue/disconnect", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  hue.disconnectBridge(user.profile.id);
  res.json({ ok: true });
});

app.get("/api/lighting/hue/devices", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    res.json(await hue.listDevices(user.profile.id));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/lighting/hue/selection", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const config = hue.saveSelection(user.profile.id, {
      lightIds: req.body?.lightIds,
      groupId: req.body?.groupId,
    });
    res.json({
      ok: true,
      selectedLightIds: config.selectedLightIds || [],
      selectedGroupId: config.selectedGroupId || null,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/hue/test", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const action = String(req.body?.action || "pulse").toLowerCase();
  if (!["on", "off", "pulse"].includes(action)) {
    return res.status(400).json({ error: "Invalid test action" });
  }

  try {
    spotifyHueSync.pauseManualControl(action === "off" ? 180000 : 15000);
    const result =
      action === "off"
        ? await hue.resetLights(user.profile.id)
        : await hue.testLights(user.profile.id, action);
    res.json({ ok: true, action, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/hue/reset", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    spotifyHueSync.pauseManualControl(180000);
    const result = await hue.resetLights(user.profile.id);
    const goveeOff = await govee.allOff(user.profile.id).catch(() => ({ off: 0 }));
    res.json({ ok: true, ...result, goveeOff: goveeOff.off || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/lighting/govee/status", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(govee.getPublicStatus(user.profile.id));
});

app.post("/api/lighting/govee/discover", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    if (Array.isArray(req.body?.scanIps)) {
      govee.saveScanIps(user.profile.id, req.body.scanIps);
    }
    const result = await govee.discover(user.profile.id);
    res.json({
      ok: true,
      ...govee.listDevices(user.profile.id),
      discoveredNow: result.discovered,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
      ...govee.listDevices(user.profile.id),
    });
  }
});

app.get("/api/lighting/govee/devices", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(govee.listDevices(user.profile.id));
});

app.put("/api/lighting/govee/selection", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const config = govee.saveSelection(user.profile.id, req.body?.deviceKeys || []);
    res.json({
      ok: true,
      selectedDevices: config.selectedDevices || [],
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/govee/test", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const action = String(req.body?.action || "pulse").toLowerCase();
  if (!["on", "off", "pulse"].includes(action)) {
    return res.status(400).json({ error: "Invalid test action" });
  }

  try {
    spotifyHueSync.pauseManualControl(action === "off" ? 180000 : 15000);
    const result = await govee.testDevices(user.profile.id, action);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/lighting/layout", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json(lightingLayout.getLayout(user.profile.id));
});

app.put("/api/lighting/layout", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const layout = lightingLayout.saveLayout(user.profile.id, {
      flashPattern: req.body?.flashPattern,
      lights: req.body?.lights,
    });
    res.json({ ok: true, ...layout });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/layout/sync", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const layout = lightingLayout.syncLayoutFromDevices(user.profile.id);
    res.json({ ok: true, ...layout });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/layout/test", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    spotifyHueSync.pauseManualControl(15000);
    const result = await lightingLayout.testPattern(user.profile.id, Number(req.body?.beats) || 4);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/layout/identify", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const lightId = String(req.body?.lightId || "").trim();
  if (!lightId) {
    res.status(400).json({ error: "lightId is required" });
    return;
  }

  try {
    const holdMs = Number(req.body?.holdMs) || 4000;
    spotifyHueSync.pauseManualControl(holdMs + 2000);
    const result = await lightingLayout.identifyLight(user.profile.id, lightId, holdMs);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/layout/split-strip", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const lightId = String(req.body?.lightId || "").trim();
  if (!lightId) {
    res.status(400).json({ error: "lightId is required" });
    return;
  }

  try {
    const layout = await Promise.resolve(
      lightingLayout.splitGoveeStrip(user.profile.id, lightId, Number(req.body?.parts) || 2)
    );
    res.json({ ok: true, ...layout });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/layout/map-colors", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const holdMs = Number(req.body?.holdMs) || 10000;
    spotifyHueSync.pauseManualControl(holdMs + 3000);
    const result = await lightingLayout.mapLayoutColors(user.profile.id, holdMs);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/chat-off", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  try {
    const result = await spotifyHueSync.setChatLightsOff(user.profile.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/lighting/chat-on", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  try {
    const result = await spotifyHueSync.setChatLightsOn(user.profile.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/lighting/sync/settings", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;
  res.json({
    ...lightingSyncConfig.getSettings(user.profile.id),
    runtime: spotifyHueSync.getRuntimeStatus(),
  });
});

app.put("/api/lighting/sync/settings", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  const settings = lightingSyncConfig.saveSettings(user.profile.id, {
    moodEnabled:
      req.body?.moodEnabled !== undefined ? Boolean(req.body.moodEnabled) : undefined,
    beatEnabled:
      req.body?.beatEnabled !== undefined ? Boolean(req.body.beatEnabled) : undefined,
    bpmOffset:
      req.body?.bpmOffset !== undefined ? Number(req.body.bpmOffset) || 0 : undefined,
    beatPhaseMs:
      req.body?.beatPhaseMs !== undefined ? Number(req.body.beatPhaseMs) || 0 : undefined,
    audioSyncEnabled:
      req.body?.audioSyncEnabled !== undefined
        ? Boolean(req.body.audioSyncEnabled)
        : undefined,
    audioSensitivity:
      req.body?.audioSensitivity !== undefined
        ? Number(req.body.audioSensitivity) || 6
        : undefined,
  });
  spotifyHueSync.resetSession(user.profile.id);
  spotifyHueSync.syncAudioCapture(user.profile.id).catch((error) => {
    console.warn("[lighting] audio capture:", error.message);
  });

  res.json({
    ok: true,
    ...settings,
    runtime: spotifyHueSync.getRuntimeStatus(),
  });
});

app.post("/api/lighting/sync/calibrate", (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const saved = spotifyHueSync.saveCalibrationForCurrentTrack(user.profile.id);
    res.json({
      ok: true,
      calibration: saved,
      runtime: spotifyHueSync.getRuntimeStatus(),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/spotify/state", async (req, res) => {
  const user = requireKickUser(req, res);
  if (!user) return;

  try {
    const state = await spotifyState.loadForBroadcaster(user.profile.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      configured: spotify.isConfigured(),
      connected: Boolean(spotify.getToken(user.profile.id)),
      ...state,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/spotify/events", (req, res) => {
  spotifyEvents.subscribe(res);
});

app.get("/api/spotify/now-playing", async (_req, res) => {
  const broadcasterId = tokenStore.getPrimaryBroadcasterId();
  if (!broadcasterId) {
    return res.json({
      connected: false,
      isPlaying: false,
      track: null,
      error: "Sign in with Kick and connect Spotify in the dashboard",
    });
  }

  try {
    const state = await spotifyState.loadForNowPlaying(broadcasterId);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/auth/kick", (req, res) => {
  if (!config.kick.clientId) {
    return res.redirect("/?error=kick_not_configured");
  }

  const state = randomState();
  const pkce = createPkcePair();
  const redirectUri = kickRedirectUri(req);
  req.session.oauthState = {
    provider: "kick",
    state,
    codeVerifier: pkce.verifier,
    redirectUri,
  };

  const params = new URLSearchParams({
    client_id: config.kick.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.kick.scope,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });

  redirectWithSession(req, res, `${config.kick.authorizeUrl}?${params}`);
});

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.redirect(
      `/?error=${encodeURIComponent(errorDescription || error)}`
    );
  }

  const saved = req.session.oauthState;
  if (
    !saved ||
    saved.provider !== "kick" ||
    saved.state !== state ||
    !saved.codeVerifier
  ) {
    return res.redirect("/?error=invalid_state");
  }

  const codeVerifier = saved.codeVerifier;
  const redirectUri = saved.redirectUri || kickRedirectUri(req);
  delete req.session.oauthState;

  try {
    const tokens = await exchangeForm(config.kick.tokenUrl, {
      grant_type: "authorization_code",
      client_id: config.kick.clientId,
      client_secret: config.kick.clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });

    const userResponse = await fetch(config.kick.userUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    const userData = await userResponse.json();
    if (!userResponse.ok || !userData.data?.[0]) {
      throw new Error("Failed to load Kick profile");
    }

    const kickUser = userData.data[0];
    const userId = String(kickUser.user_id);
    const signInEntry = {
      broadcasterId: userId,
      username: kickUser.name,
      displayName: kickUser.name,
      profileImage: kickUser.profile_picture,
      ip: req.ip,
    };

    if (!isAllowedBroadcaster(userId, kickUser.name)) {
      signInLog.recordSignIn({ ...signInEntry, allowed: false });
      return res.redirect("/?error=access_denied");
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    saveUserSession(
      req,
      {
        id: userId,
        username: kickUser.name,
        displayName: kickUser.name,
        email: kickUser.email || null,
        profileImage: kickUser.profile_picture,
        profileUrl: `https://kick.com/${kickUser.name}`,
      },
      tokens
    );

    const isOwner = dashboardAccess.isDashboardOwner({
      profile: { id: userId, username: kickUser.name },
    });
    req.session.dashboardRole = isOwner ? "owner" : "player";

    signInLog.recordSignIn({ ...signInEntry, allowed: true });

    try {
      kickRewardsStore.registerKickUsername(kickUser.name, {
        displayName: kickUser.name,
      });
    } catch (error) {
      console.warn("[kick-rewards] register on login:", error.message);
    }

    if (isOwner) {
      try {
        await setupKickSubscriptions(req);
      } catch (error) {
        req.session.webhookReady = false;
        req.session.webhookError = error.message;
      }

      try {
        workoutState.setBroadcaster(kickUser.user_id);
        botEngine.refreshTimersForBroadcaster(kickUser.user_id, config.kick);
      } catch (error) {
        console.warn("[auth] post-login setup:", error.message);
      }
    }

    redirectWithSession(req, res, isOwner ? "/" : "/#only-pixels");
  } catch (err) {
    redirectWithSession(req, res, `/?error=${encodeURIComponent(err.message)}`);
  }
});

app.get("/webhooks/kick", (_req, res) => {
  res.json({
    ok: true,
    endpoint: "kick-webhook",
    url: WEBHOOK_URL,
    note: "Kick POSTs chat/events here. Enable Webhooks in Kick Developer must point to this URL.",
  });
});

app.post("/webhooks/kick", (req, res) => {
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ])
  );

  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const eventType = headers["kick-event-type"] || req.body?.event || "";
  const inspection = webhook.inspectKickWebhook(rawBody, headers);
  const isValid = inspection.valid;

  if (!isValid && process.env.NODE_ENV === "production") {
    webhookDebug.recordHit({
      eventType,
      headers,
      valid: false,
      reason: inspection.reason,
      payload: req.body,
    });
    console.warn(
      `[webhook] rejected ${eventType}: ${inspection.reason}`,
      {
        hasMessageId: Boolean(headers["kick-event-message-id"]),
        hasTimestamp: Boolean(headers["kick-event-message-timestamp"]),
        hasSignature: Boolean(headers["kick-event-signature"]),
      }
    );
    return res.status(401).json({ error: "Invalid signature", reason: inspection.reason });
  }

  const payload = extractWebhookPayload(req.body);
  const broadcasterUserId = resolveWebhookBroadcasterId(payload);

  if (eventType === "chat.message.sent") {
    const channelId = String(broadcasterUserId || "unknown");
    const message = eventStore.addChatMessage(channelId, payload);
    chatEvents.broadcastMessage(message);
    workoutState.incrementMessagesForBroadcaster(channelId);
    webhookDebug.recordHit({
      eventType,
      headers,
      valid: true,
      payload,
      channelId,
      stored: true,
    });
    console.log(`Chat webhook: [${channelId}] ${payload.sender?.username || "?"}: ${(payload.content || "").slice(0, 80)}`);
    const resolved = kickRewardsStore.resolveStreamerForWebhook(payload, channelId);
    if (resolved?.slug && payload.sender?.username) {
      if (resolved.broadcasterId) {
        kickRewardsStore.upsertMonitoredStreamer(resolved.slug, resolved.broadcasterId);
      }
      kickRewardsStore.recordChatMessage({
        streamer: resolved.slug,
        username: payload.sender.username,
        content: payload.content || "",
        createdAt: payload.created_at || new Date().toISOString(),
      });
    } else if (payload.sender?.username) {
      console.warn(
        `[kick-rewards] chat ignored — unknown monitored streamer for channel ${channelId}`
      );
    }
    botEngine
      .handleChatMessage(channelId, payload, config.kick)
      .catch((error) => {
        console.error("Command handler failed:", error.message);
      });
  } else {
    webhookDebug.recordHit({
      eventType,
      headers,
      valid: true,
      payload,
      channelId: broadcasterUserId ? String(broadcasterUserId) : null,
      stored: false,
    });
  }

  if (eventType.startsWith("channel.subscription")) {
    const quantity = subscriptionUtils.parseSubscriptionQuantity(eventType, payload);
    eventStore.addSubscriptionEvent(
      broadcasterUserId || "unknown",
      eventType,
      payload
    );
    try {
      kickSubscriberStore.recordSubscriptionEvent(eventType, payload);
    } catch (error) {
      console.warn("[discord-subs] failed to record sub roster:", error.message);
    }
    if (subscriptionUtils.shouldCreditWorkout(eventType)) {
      botEngine.handleSubscriptionEvent(quantity);
      const gifter =
        payload.gifter?.username || payload.subscriber?.username || "?";
      if (eventType === "channel.subscription.gifts") {
        const gifteeCount = subscriptionUtils.countGiftRecipients(payload);
        console.log(
          `Sub webhook: ${eventType} ×${quantity} (${gifter}) giftees=${gifteeCount}`
        );
        const slug =
          payload.channel?.slug ||
          payload.broadcaster?.channel_slug ||
          payload.broadcaster?.username;
        giftedSubLeaderboardApi.clearCache(slug);
      } else {
        console.log(`Sub webhook: ${eventType} ×${quantity} (${gifter})`);
      }
    }
    const alert = alertUtils.buildAlert(eventType, payload);
    if (alert) alertState.pushAlert(alert);
  } else if (eventType === "channel.followed" || eventType === "kicks.gifted") {
    const alert = alertUtils.buildAlert(eventType, payload);
    if (alert) {
      alertState.pushAlert(alert);
      console.log(
        `Alert webhook: ${eventType} (${alert.username})`
      );
    }
    if (eventType === "kicks.gifted") {
      const slug =
        payload.channel?.slug ||
        payload.broadcaster?.channel_slug ||
        payload.broadcaster?.username ||
        kickRewardsStore.broadcasterIdToStreamer(broadcasterUserId);
      giftedSubLeaderboardApi.clearCache(slug);
      if (slug && payload.sender?.username) {
        kickRewardsStore.recordKicksGifted({
          streamer: slug,
          donor: payload.sender.username,
          amount: payload.gift?.amount || payload.amount,
          createdAt: payload.created_at || new Date().toISOString(),
        });
      }
    }
  }

  res.status(200).json({ ok: true });
});

webhook.loadPublicKey().then(async () => {
  eventStore.migrateMessageStats();
  const { changed, previousUrl } = webhookState.noteWebhookUrl(WEBHOOK_URL);
  if (changed) {
    console.log(
      `[webhooks] URL changed ${previousUrl} -> ${WEBHOOK_URL} — re-registering subscriptions`
    );
  }

  // One-time cleanup: delete leftover chat.message.sent webhooks (Pusher owns chat now).
  // Skip on every restart — repeated purge list/delete storms Kick rate limits.
  try {
    const token = tokenStore.getBroadcasterToken(DEFAULT_BROADCASTER_ID);
    const shouldPurge =
      Boolean(token?.accessToken) &&
      typeof kickApi.purgeChatMessageSubscriptions === "function" &&
      (changed || webhookState.shouldPurgeChatMessageSubscriptions());
    if (shouldPurge) {
      const accessToken = await kickApi.ensureAccessTokenForBroadcaster(
        DEFAULT_BROADCASTER_ID,
        config.kick
      );
      const purged = await kickApi.purgeChatMessageSubscriptions(accessToken);
      webhookState.noteChatMessagePurged();
      if (purged.deleted > 0) {
        console.log(`[webhooks] purged ${purged.deleted} leftover chat.message.sent subscription(s)`);
      } else {
        console.log("[webhooks] no leftover chat.message.sent subscriptions");
      }
    } else {
      console.log("[webhooks] chat.message.sent purge skipped (already done)");
    }
  } catch (error) {
    console.warn("[webhooks] chat purge skipped:", error.message);
  }

  await ensureStoredWebhookSubscriptions({ webhookUrlChanged: changed });

  if (discord.configured()) {
    discordSubRoleRecheck.startRecheckLoop(kickSubscriberStore);
    discordRoleWatch.start(kickSubscriberStore);
    discordGateway.start(kickSubscriberStore);
    // Stop RoleLogic from stripping Kick Supporter (strip perms + demote).
    if (String(process.env.DISCORD_BLOCK_ROLELOGIC || "1").trim() !== "0") {
      const runRoleLogicBlock = (why) =>
        discord
          .blockRoleLogicFromManagingSubRole()
          .then((result) => {
            if (result.alreadySafe || result.skipped) {
              console.log(
                `[discord] RoleLogic block (${why}): ${result.message || result.reason}`
              );
            } else if (result.ok) {
              console.log(`[discord] RoleLogic block (${why}): ${result.message}`);
            } else {
              console.warn(
                `[discord] RoleLogic block failed (${why}): ${result.error || result.message || "unknown"}`
              );
            }
          })
          .catch((error) => {
            console.warn(`[discord] RoleLogic block error (${why}):`, error.message);
          });

      runRoleLogicBlock("boot");
      // RoleLogic re-asserts hierarchy / perms on its sync loop — keep clamping it.
      const ROLELOGIC_REBLOCK_MS = Math.max(
        5 * 60 * 1000,
        Number(process.env.DISCORD_ROLELOGIC_REBLOCK_MS || 10 * 60 * 1000) ||
          10 * 60 * 1000
      );
      const reblockTimer = setInterval(
        () => runRoleLogicBlock("timer"),
        ROLELOGIC_REBLOCK_MS
      );
      if (typeof reblockTimer.unref === "function") reblockTimer.unref();
    }
  } else {
    console.log("[discord-recheck] skipped — Discord not fully configured");
  }

  // Slow background retry for missing sub/gift webhooks — not tied to dashboard polling.
  const WEBHOOK_RETRY_MS = Math.max(
    5 * 60 * 1000,
    Number(process.env.KICK_WEBHOOK_RETRY_MS || 15 * 60 * 1000) || 15 * 60 * 1000
  );
  setInterval(() => {
    ensureStoredWebhookSubscriptions({ webhookUrlChanged: false }).catch((error) => {
      console.warn("[webhooks] background ensure failed:", error.message);
    });
  }, WEBHOOK_RETRY_MS);

  await bootstrapKickRewardPartners();
  if (typeof kickRewardsStore.dedupePartnerSlugVariants === "function") {
    kickRewardsStore.dedupePartnerSlugVariants();
  }
  if (typeof kickRewardsStore.pruneChatPriorityToActive === "function") {
    kickRewardsStore.pruneChatPriorityToActive();
  }
  if (String(process.env.KICK_PUSHER_MONITOR || "1") !== "0") {
    kickPusherMonitor.refreshTargets();
    kickPusherMonitor.start();
  } else {
    console.log("[pusher-monitor] disabled (KICK_PUSHER_MONITOR=0)");
  }
  const primaryId = tokenStore.getPrimaryBroadcasterId();
  if (primaryId) {
    workoutState.setBroadcaster(primaryId);
  }
  botEngine.reloadTimers(config.kick);
  spotifyHueSync.start();
  goveeLan.init().then((status) => {
    if (status.listening) {
      console.log("[govee-lan] listening on UDP 4002");
    } else if (status.initError) {
      console.warn("[govee-lan] NOT listening:", status.initError);
      console.warn("[govee-lan] Govee test + beat sync will not work until you restart with start-everything.bat");
    }
  }).catch((error) => {
    console.warn("[govee-lan] init failed:", error.message);
    console.warn("[govee-lan] Restart with start-everything.bat to free UDP port 4002");
  });

  const flushPersistentStores = () => {
    try {
      eventStore.flushSync?.();
    } catch (error) {
      console.warn("[shutdown] event store flush:", error.message);
    }
    try {
      kickRewardsStore.flushSync?.();
    } catch (error) {
      console.warn("[shutdown] rewards store flush:", error.message);
    }
    try {
      kickSubscriberStore.flushSync?.();
    } catch (error) {
      console.warn("[shutdown] subscriber store flush:", error.message);
    }
  };

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal || "exit"} — flushing stores`);
    try {
      kickPusherMonitor.stop?.();
    } catch {
      /* ignore */
    }
    try {
      discordRoleWatch.stop?.();
    } catch {
      /* ignore */
    }
    try {
      discordGateway.stop?.();
    } catch {
      /* ignore */
    }
    flushPersistentStores();
    goveeLan.closeSharedSocket();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("exit", () => shutdown("exit"));

  process.on("unhandledRejection", (reason) => {
    const message = reason?.stack || reason?.message || String(reason);
    console.error("[process] unhandledRejection:", message);
  });
  process.on("uncaughtException", (error) => {
    console.error("[process] uncaughtException:", error?.stack || error);
    try {
      flushPersistentStores();
    } catch {
      /* ignore */
    }
    // Exit so Railway ALWAYS restart policy brings us back cleanly.
    const exitTimer = setTimeout(() => process.exit(1), 250);
    if (typeof exitTimer.unref === "function") exitTimer.unref();
  });

  const audioBroadcasterId = tokenStore.getPrimaryBroadcasterId();
  if (audioBroadcasterId) {
    spotifyHueSync.syncAudioCapture(audioBroadcasterId).catch((error) => {
      console.warn("[lighting] audio capture on boot:", error.message);
    });
  }
  process.env.BOOT_STARTED_AT = new Date().toISOString();
  app.listen(PORT, () => {
    console.log(`Server running at ${BASE_URL}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}`);
    console.log(`Workout OBS overlays: ${BASE_URL}/workout/control-panel.html`);
    console.log(`Slots timer OBS: http://127.0.0.1:${PORT}/slots/slots-timer.html?obs=1&v=7`);
    console.log(`Slots widget OBS: http://127.0.0.1:${PORT}/slots/slots-widget.html?obs=1&v=7`);
    console.log(`Drinking OBS overlays: ${BASE_URL}/drinking/shotgun-cam.html`);
    console.log(`Widget OBS overlays: ${BASE_URL}/widgets/chat-box.html?obs=1`);
    console.log(`Stream alerts: ${BASE_URL}/widgets/stream-alerts.html?obs=1`);
    console.log(`Cam overlay: ${BASE_URL}/widgets/cam-overlay.html?obs=1`);
    if (!config.kick.clientId) console.warn("KICK_CLIENT_ID is not set");
  });
});
