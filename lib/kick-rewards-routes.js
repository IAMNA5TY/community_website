const express = require("express");
const kickRewardsStore = require("./kick-rewards-store");
const kickApi = require("./kick");
const tokenStore = require("./token-store");
const { subscribeMonitoredStreamerWebhooks } = require("./monitored-webhooks");
const kickPusherMonitor = require("./kick-pusher-monitor");

function createKickRewardsRouter(config) {
  const router = express.Router();

  function optionalApiKey(req, res, next) {
    const required = String(process.env.KICK_REWARDS_API_KEY || "").trim();
    if (!required) return next();
    const provided = req.get("x-api-key") || req.get("X-API-Key") || "";
    if (provided !== required) {
      return res.status(401).json({ success: false, error: "Invalid API key" });
    }
    next();
  }

  function parseExtraSlugs(req) {
    return String(req.query.slugs || "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
  }

  function resolveStreamerSlugs(req) {
    return kickRewardsStore.mergeStreamerSlugs(parseExtraSlugs(req));
  }

  async function fetchChannelStatuses(slugs) {
    const uniqueSlugs = kickRewardsStore.mergeStreamerSlugs(slugs);
    const statusBySlug = new Map(
      uniqueSlugs.map((slug) => [
        slug,
        {
          username: slug,
          slug,
          display_name: slug,
          streamer_name: slug,
          is_live: false,
        },
      ])
    );

    const token = tokenStore.getBroadcasterToken(
      process.env.DEFAULT_BROADCASTER_ID || "1183030"
    );
    const accessToken = token?.accessToken;

    if (accessToken) {
      const ids = [];
      const slugOnly = [];
      const resolvedFromApi = new Set();

      for (const slug of uniqueSlugs) {
        const broadcasterId = kickRewardsStore.getBroadcasterIdForSlug(slug);
        if (broadcasterId) {
          ids.push(Number(broadcasterId));
        } else {
          slugOnly.push(slug);
        }
      }

      for (let i = 0; i < ids.length; i += 50) {
        const channels = await kickApi.getChannelsByBroadcasterIds(
          accessToken,
          ids.slice(i, i + 50)
        );
        for (const channel of channels) {
          const slug = String(channel.slug || "").toLowerCase();
          if (!slug || !statusBySlug.has(slug)) continue;
          resolvedFromApi.add(slug);
          statusBySlug.set(slug, {
            username: slug,
            slug,
            display_name: channel.slug || slug,
            streamer_name: channel.slug || slug,
            is_live: Boolean(channel.stream?.is_live),
          });
        }
      }

      for (let i = 0; i < slugOnly.length; i += 50) {
        const channels = await kickApi.getChannelsBySlugs(
          accessToken,
          slugOnly.slice(i, i + 50)
        );
        for (const channel of channels) {
          const slug = String(channel.slug || "").toLowerCase();
          if (!slug || !statusBySlug.has(slug)) continue;
          resolvedFromApi.add(slug);
          statusBySlug.set(slug, {
            username: slug,
            slug,
            display_name: channel.slug || slug,
            streamer_name: channel.slug || slug,
            is_live: Boolean(channel.stream?.is_live),
          });
        }
      }

      const needsFallback = uniqueSlugs.filter((slug) => !resolvedFromApi.has(slug));
      await Promise.all(
        needsFallback.map(async (slug) => {
          const channel = await kickApi.getChannelLiveBySlugV2(slug);
          if (!channel) return;
          statusBySlug.set(slug, {
            username: slug,
            slug,
            display_name: channel.slug || slug,
            streamer_name: channel.slug || slug,
            is_live: Boolean(channel.stream?.is_live),
          });
        })
      );
    } else {
      await Promise.all(
        uniqueSlugs.map(async (slug) => {
          const channel = await kickApi.getChannelLiveBySlugV2(slug);
          if (!channel) return;
          statusBySlug.set(slug, {
            username: slug,
            slug,
            display_name: channel.slug || slug,
            streamer_name: channel.slug || slug,
            is_live: Boolean(channel.stream?.is_live),
          });
        })
      );
    }

    return uniqueSlugs.map((slug) => statusBySlug.get(slug));
  }

  router.use(optionalApiKey);

  router.get("/test-connection", (_req, res) => {
    res.json({
      success: true,
      api_version: "na5ty.com-kick-rewards-1",
      stats: kickRewardsStore.getStats(),
      monitored: kickRewardsStore.listMonitoredChannels(),
    });
  });

  router.get("/monitored-streamers", (_req, res) => {
    res.json({
      success: true,
      streamers: kickRewardsStore.listMonitoredChannels(),
    });
  });

  router.post("/monitored-streamers", async (req, res) => {
    try {
      const slug = req.body.slug || req.body.username;
      let broadcasterId =
        req.body.broadcasterId || req.body.broadcaster_user_id || null;

      if (!broadcasterId) {
        const token = tokenStore.getBroadcasterToken(
          process.env.DEFAULT_BROADCASTER_ID || "1183030"
        );
        if (token?.accessToken && slug) {
          const channels = await kickApi.getChannelsBySlugs(token.accessToken, [slug]);
          if (channels[0]?.broadcaster_user_id) {
            broadcasterId = String(channels[0].broadcaster_user_id);
          }
        }
      }

      const entry = kickRewardsStore.upsertMonitoredStreamer(slug, broadcasterId);
      if (entry.broadcasterId) {
        subscribeMonitoredStreamerWebhooks(entry.broadcasterId, config).catch((error) => {
          console.warn("[kick-rewards] partner webhook subscribe failed:", error.message);
        });
      }
      kickPusherMonitor.refreshTargets();
      res.json({ success: true, streamer: entry });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post("/monitored-streamers/bulk", async (req, res) => {
    try {
      const list = Array.isArray(req.body.streamers)
        ? req.body.streamers
        : String(req.body.slugs || "")
            .split(",")
            .map((slug) => slug.trim())
            .filter(Boolean);

      const added = [];
      for (const slug of list) {
        added.push(kickRewardsStore.upsertMonitoredStreamer(slug));
      }

      kickPusherMonitor.refreshTargets();
      res.json({ success: true, count: added.length, streamers: added });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post("/monitored-streamers/sync", async (req, res) => {
    try {
      const list = Array.isArray(req.body.streamers)
        ? req.body.streamers
        : String(req.body.slugs || "")
            .split(",")
            .map((slug) => slug.trim())
            .filter(Boolean);

      const broadcasterIdsBySlug = {};
      const token = tokenStore.getBroadcasterToken(
        process.env.DEFAULT_BROADCASTER_ID || "1183030"
      );
      if (token?.accessToken) {
        for (let i = 0; i < list.length; i += 50) {
          const channels = await kickApi.getChannelsBySlugs(
            token.accessToken,
            list.slice(i, i + 50)
          );
          for (const channel of channels) {
            const slug = String(channel.slug || "").toLowerCase();
            const broadcasterId = channel.broadcaster_user_id
              ? String(channel.broadcaster_user_id)
              : null;
            if (slug && broadcasterId) {
              broadcasterIdsBySlug[slug] = broadcasterId;
            }
          }
        }
      }

      const streamers = kickRewardsStore.mergeMonitoredStreamers(
        list,
        broadcasterIdsBySlug
      );
      kickPusherMonitor.refreshTargets();
      res.json({ success: true, count: streamers.length, streamers });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get("/monitor/status", (_req, res) => {
    res.json({
      success: true,
      stats: kickRewardsStore.getStats(),
      pusher: kickPusherMonitor.getStatus(),
      monitored: kickRewardsStore.listMonitoredChannels(),
    });
  });

  router.get("/monitor/chat-debug/:streamer", (req, res) => {
    const hours = Math.max(1, parseInt(req.query.hours, 10) || 24);
    const slug = String(req.params.streamer || "").trim();
    if (!slug) {
      return res.status(400).json({ success: false, error: "Streamer slug required" });
    }
    const pusherStatus = kickPusherMonitor.getStatus();
    const slugLower = slug.toLowerCase();
    const streamMonitor = (pusherStatus.streamers || []).find(
      (row) => row.slug === slugLower
    );
    res.json({
      success: true,
      ...kickRewardsStore.getChatDebug(slug, { hours }),
      pusher_connected: Boolean(streamMonitor?.connected),
      pusher_chatroom_id: streamMonitor?.chatroomId || null,
      pusher_messages_recorded: streamMonitor?.messagesRecorded || 0,
      pusher_last_message_at: streamMonitor?.lastMessageAt || null,
      pusher_last_error: streamMonitor?.lastError || null,
      pusher_recent_log: streamMonitor?.recentDebugLog || [],
      debug_slugs: String(
        process.env.KICK_CHAT_DEBUG_SLUGS ||
          "andy1993,vikinggaming94,d0sil,devilmaykill579,lonewolfclyde"
      )
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    });
  });

  router.get("/channels", async (req, res) => {
    const channels = await fetchChannelStatuses(resolveStreamerSlugs(req));
    res.json({ success: true, channels, streamers: channels });
  });

  router.get("/streams/live", async (req, res) => {
    const channels = await fetchChannelStatuses(resolveStreamerSlugs(req));
    const streams = channels.filter((channel) => channel.is_live);
    res.json({ success: true, streams });
  });

  router.get("/channels/:streamer/chatters", (req, res) => {
    const hours = Math.max(0, parseInt(req.query.hours, 10) || 24);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 200);
    res.json(kickRewardsStore.getChatters(req.params.streamer, { hours, limit }));
  });

  router.get("/channels/:streamer/kick_chat_controls", (req, res) => {
    const init = req.query.init === "1" || req.query.init === "true";
    const afterId = parseInt(req.query.after_id, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 20;
    res.json(
      kickRewardsStore.getControlEvents(req.params.streamer, { afterId, limit, init })
    );
  });

  router.get("/channels/:streamer/gift_kicks", (req, res) => {
    const donor = req.query.donor || "";
    const hours = Math.max(0, parseInt(req.query.hours, 10) || 0);
    res.json(kickRewardsStore.sumGiftKicks(req.params.streamer, donor, hours));
  });

  router.get("/channels/:streamer/viewer_earn_totals", (req, res) => {
    const donor = req.query.donor || "";
    res.json(kickRewardsStore.getViewerEarnTotals(req.params.streamer, donor));
  });

  router.post("/rewards/register", (req, res) => {
    try {
      const kickUsername = req.body.kickUsername || req.body.username;
      const entry = kickRewardsStore.registerKickUsername(kickUsername, {
        displayName: req.body.displayName,
        gameLicense: req.body.gameLicense,
      });
      res.json({
        success: true,
        registration: entry,
        linkCode: entry.linkCode,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post("/rewards/link-game", (req, res) => {
    try {
      const entry = kickRewardsStore.linkGameLicense(
        req.body.linkCode || req.body.code,
        req.body.gameLicense || req.body.license
      );
      res.json({
        success: true,
        registration: entry,
        kickUsername: entry.kickUsername,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get("/rewards/game-link/:license", (req, res) => {
    const entry = kickRewardsStore.getRegistrationByLicense(req.params.license);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Not linked" });
    }
    res.json({ success: true, registration: entry, kickUsername: entry.kickUsername });
  });

  router.get("/rewards/register/:kickUsername", (req, res) => {
    const entry = kickRewardsStore.getRegistration(req.params.kickUsername);
    if (!entry) {
      return res.status(404).json({ success: false, error: "Not registered" });
    }
    res.json({ success: true, registration: entry });
  });

  router.get("/rewards/summary/:kickUsername", (req, res) => {
    res.json({
      success: true,
      ...kickRewardsStore.getRewardsSummary(req.params.kickUsername),
    });
  });

  return router;
}

module.exports = {
  createKickRewardsRouter,
};
