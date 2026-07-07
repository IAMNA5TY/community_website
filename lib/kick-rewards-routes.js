const express = require("express");
const kickRewardsStore = require("./kick-rewards-store");
const kickApi = require("./kick");
const tokenStore = require("./token-store");

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

  router.use(optionalApiKey);

  router.get("/test-connection", (_req, res) => {
    res.json({
      success: true,
      api_version: "na5ty.com-kick-rewards-1",
      stats: kickRewardsStore.getStats(),
    });
  });

  router.get("/channels", async (_req, res) => {
    const streamers = kickRewardsStore.getMonitoredStreamers();
    const channels = [];

    for (const slug of streamers) {
      let isLive = false;
      let displayName = slug;
      try {
        const token = tokenStore.getBroadcasterToken(
          process.env.DEFAULT_BROADCASTER_ID || "1183030"
        );
        if (token?.accessToken) {
          const channel = await kickApi
            .getChannel(token.accessToken)
            .catch(() => null);
          if (channel && String(channel.slug || "").toLowerCase() === slug) {
            isLive = Boolean(channel.stream?.is_live);
            displayName = channel.slug || slug;
          }
        }
      } catch {
        // keep defaults
      }

      channels.push({
        username: slug,
        slug,
        display_name: displayName,
        streamer_name: displayName,
        is_live: isLive,
      });
    }

    res.json({ success: true, channels, streamers: channels });
  });

  router.get("/streams/live", async (_req, res) => {
    const streamers = kickRewardsStore.getMonitoredStreamers();
    const streams = [];

    for (const slug of streamers) {
      let isLive = false;
      let displayName = slug;
      try {
        const token = tokenStore.getBroadcasterToken(
          process.env.DEFAULT_BROADCASTER_ID || "1183030"
        );
        if (token?.accessToken) {
          const channel = await kickApi
            .getChannel(token.accessToken)
            .catch(() => null);
          if (channel && String(channel.slug || "").toLowerCase() === slug) {
            isLive = Boolean(channel.stream?.is_live);
            displayName = channel.slug || slug;
          }
        }
      } catch {
        // keep defaults
      }

      if (isLive) {
        streams.push({
          username: slug,
          slug,
          display_name: displayName,
          streamer_name: displayName,
          is_live: true,
        });
      }
    }

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
