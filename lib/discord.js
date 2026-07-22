const crypto = require("crypto");

const DISCORD_API = "https://discord.com/api/v10";
const SUB_ROLE_BUTTON_ID = "na5ty_sub_role_claim";
const DEFAULT_PANEL_CHANNEL_ID = "1514862613576679444";

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
};

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
};

function configured() {
  return Boolean(
    process.env.DISCORD_CLIENT_ID &&
      process.env.DISCORD_CLIENT_SECRET &&
      process.env.DISCORD_BOT_TOKEN &&
      process.env.DISCORD_GUILD_ID &&
      process.env.DISCORD_SUB_ROLE_ID
  );
}

function getConfig() {
  return {
    clientId: String(process.env.DISCORD_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.DISCORD_CLIENT_SECRET || "").trim(),
    botToken: String(process.env.DISCORD_BOT_TOKEN || "").trim(),
    guildId: String(process.env.DISCORD_GUILD_ID || "").trim(),
    subRoleId: String(process.env.DISCORD_SUB_ROLE_ID || "").trim(),
    publicKey: String(process.env.DISCORD_PUBLIC_KEY || "").trim(),
    panelChannelId: String(
      process.env.DISCORD_SUB_PANEL_CHANNEL_ID || DEFAULT_PANEL_CHANNEL_ID
    ).trim(),
    siteUrl: String(process.env.BASE_URL || process.env.PUBLIC_BASE_URL || "https://na5ty.com")
      .trim()
      .replace(/\/$/, ""),
    redirectUri:
      String(process.env.DISCORD_REDIRECT_URI || "").trim() || null,
  };
}

function redirectUri(req) {
  const fromEnv = String(process.env.DISCORD_REDIRECT_URI || "").trim();
  if (fromEnv) return fromEnv;
  const proto =
    req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "https";
  const host =
    req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "na5ty.com";
  return `${proto}://${host}/auth/discord/callback`;
}

function authorizeUrl(req, state) {
  const cfg = getConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: redirectUri(req),
    state,
    prompt: "consent",
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

async function exchangeCode(req, code) {
  const cfg = getConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(req),
  });

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Discord token HTTP ${response.status}`);
  }
  return data;
}

async function fetchOauthUser(accessToken) {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Discord user HTTP ${response.status}`);
  }
  return data;
}

async function botFetch(pathname, options = {}) {
  const cfg = getConfig();
  if (!cfg.botToken) throw new Error("DISCORD_BOT_TOKEN is not configured");

  const response = await fetch(`${DISCORD_API}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bot ${cfg.botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data.message ||
      data.error_description ||
      `Discord API HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

async function addSubRole(discordUserId) {
  const cfg = getConfig();
  if (!cfg.guildId || !cfg.subRoleId) {
    throw new Error("DISCORD_GUILD_ID / DISCORD_SUB_ROLE_ID not configured");
  }
  await botFetch(
    `/guilds/${cfg.guildId}/members/${discordUserId}/roles/${cfg.subRoleId}`,
    { method: "PUT" }
  );
  return { ok: true, discordUserId, roleId: cfg.subRoleId };
}

async function removeSubRole(discordUserId) {
  const cfg = getConfig();
  if (!cfg.guildId || !cfg.subRoleId) {
    throw new Error("DISCORD_GUILD_ID / DISCORD_SUB_ROLE_ID not configured");
  }
  try {
    await botFetch(
      `/guilds/${cfg.guildId}/members/${discordUserId}/roles/${cfg.subRoleId}`,
      { method: "DELETE" }
    );
  } catch (error) {
    // Already missing role / not in server is fine for cleanup.
    if (error.status === 404) return { ok: true, skipped: true };
    throw error;
  }
  return { ok: true, discordUserId, roleId: cfg.subRoleId };
}

function buildSubRolePanelPayload() {
  const cfg = getConfig();
  const site = cfg.siteUrl || "https://na5ty.com";
  return {
    embeds: [
      {
        title: "Subscriber role for na5ty",
        description:
          "To get the subscriber role for **na5ty**, click **Get Subscriber Role** below.\n\n" +
          "One-time setup: sign in with Kick on [na5ty.com](" +
          site +
          "/#discord) and tap **Link Discord**. After that you can claim from this panel in the Discord app — no browser Discord login needed.\n\n" +
          "Questions? Ask in Discord or check the Discord Sub Role page on na5ty.com.",
        color: 0x53fc18,
        footer: { text: "Powered by na5ty.com" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Get Subscriber Role",
            custom_id: SUB_ROLE_BUTTON_ID,
          },
          {
            type: 2,
            style: 5,
            label: "Open na5ty.com",
            url: `${site}/#discord`,
          },
        ],
      },
    ],
  };
}

async function postSubRolePanel(channelId = null) {
  const cfg = getConfig();
  const targetChannel = String(channelId || cfg.panelChannelId || "").trim();
  if (!targetChannel) throw new Error("DISCORD_SUB_PANEL_CHANNEL_ID is missing");
  if (!cfg.botToken) throw new Error("DISCORD_BOT_TOKEN is not configured");

  const message = await botFetch(`/channels/${targetChannel}/messages`, {
    method: "POST",
    body: JSON.stringify(buildSubRolePanelPayload()),
  });

  return {
    channelId: targetChannel,
    messageId: String(message.id),
    postedAt: new Date().toISOString(),
  };
}

function ed25519PublicKeyFromHex(publicKeyHex) {
  const raw = Buffer.from(String(publicKeyHex || "").trim(), "hex");
  if (raw.length !== 32) {
    throw new Error("DISCORD_PUBLIC_KEY must be a 32-byte hex string");
  }
  // SPKI DER prefix for raw Ed25519 public keys
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function verifyInteractionSignature(req) {
  const cfg = getConfig();
  if (!cfg.publicKey) {
    return { ok: false, error: "DISCORD_PUBLIC_KEY is not configured" };
  }

  const signature = req.get("x-signature-ed25519");
  const timestamp = req.get("x-signature-timestamp");
  const rawBody = req.rawBody;
  if (!signature || !timestamp || !rawBody) {
    return { ok: false, error: "Missing Discord signature headers or body" };
  }

  try {
    const message = Buffer.concat([
      Buffer.from(String(timestamp), "utf8"),
      Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8"),
    ]);
    const ok = crypto.verify(
      null,
      message,
      ed25519PublicKeyFromHex(cfg.publicKey),
      Buffer.from(signature, "hex")
    );
    return ok ? { ok: true } : { ok: false, error: "Invalid Discord signature" };
  } catch (error) {
    return { ok: false, error: error.message || "Signature verification failed" };
  }
}

function ephemeralMessage(content, extraComponents = null) {
  const payload = {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: 64,
    },
  };
  if (extraComponents?.length) {
    payload.data.components = extraComponents;
  }
  return payload;
}

async function handleSubRoleButton(interaction, kickSubscriberStore) {
  const cfg = getConfig();
  const discordUser = interaction.member?.user || interaction.user || {};
  const discordId = String(discordUser.id || "").trim();
  if (!discordId) {
    return ephemeralMessage("Could not read your Discord user id.");
  }

  const link = kickSubscriberStore.getLinkForDiscordId(discordId);
  if (!link?.kickUserId) {
    const site = cfg.siteUrl || "https://na5ty.com";
    return ephemeralMessage(
      "Your Discord is not linked to a Kick login on na5ty.com yet.\n\n" +
        "1. Open na5ty.com and sign in with Kick\n" +
        "2. Go to **Discord Sub Role** → **Link Discord**\n" +
        "3. Come back here and tap **Get Subscriber Role** again",
      [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Link on na5ty.com",
              url: `${site}/#discord`,
            },
          ],
        },
      ]
    );
  }

  const eligibility = kickSubscriberStore.isEligibleForSubRole(
    link.kickUserId,
    link.kickUsername
  );
  if (!eligibility.eligible) {
    return ephemeralMessage(
      `No active Kick sub found for **@${link.kickUsername || "unknown"}** yet.\n` +
        "Stay subscribed to na5ty and send a chat message (or wait for a renew webhook), then try again."
    );
  }

  try {
    await addSubRole(discordId);
    const sub =
      kickSubscriberStore.getSubscriber(link.kickUsername) ||
      kickSubscriberStore.getSubscriber(link.kickUserId);
    kickSubscriberStore.recordGrant(discordId, {
      kickUsername: link.kickUsername,
      kickUserId: link.kickUserId,
      active: true,
      expiresAt: sub?.expiresAt || null,
    });
    return ephemeralMessage(
      "**Your Discord account is now connected to na5ty and you got the subscriber role for na5ty!**"
    );
  } catch (error) {
    return ephemeralMessage(
      `Could not grant the role: ${error.message || "unknown Discord error"}`
    );
  }
}

async function handleInteraction(interaction, kickSubscriberStore) {
  if (interaction?.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }

  if (interaction?.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id;
    if (customId === SUB_ROLE_BUTTON_ID) {
      return handleSubRoleButton(interaction, kickSubscriberStore);
    }
    return ephemeralMessage("Unknown button.");
  }

  return ephemeralMessage("Unsupported Discord interaction.");
}

module.exports = {
  configured,
  getConfig,
  redirectUri,
  authorizeUrl,
  exchangeCode,
  fetchOauthUser,
  addSubRole,
  removeSubRole,
  postSubRolePanel,
  buildSubRolePanelPayload,
  verifyInteractionSignature,
  handleInteraction,
  SUB_ROLE_BUTTON_ID,
  DEFAULT_PANEL_CHANNEL_ID,
  InteractionType,
  InteractionResponseType,
};
