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
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
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

function normalizePublicKey(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^0x/i, "")
    .replace(/\s+/g, "");
}

function getConfig() {
  return {
    clientId: String(process.env.DISCORD_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.DISCORD_CLIENT_SECRET || "").trim(),
    botToken: String(process.env.DISCORD_BOT_TOKEN || "").trim(),
    guildId: String(process.env.DISCORD_GUILD_ID || "").trim(),
    subRoleId: String(process.env.DISCORD_SUB_ROLE_ID || "").trim(),
    publicKey: normalizePublicKey(process.env.DISCORD_PUBLIC_KEY),
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

function publicKeyStatus() {
  const key = getConfig().publicKey;
  if (!key) {
    return { configured: false, valid: false, length: 0, error: "DISCORD_PUBLIC_KEY is missing" };
  }
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    return {
      configured: true,
      valid: false,
      length: key.length,
      error: "DISCORD_PUBLIC_KEY must be hex (from Discord app → General Information → Public Key)",
    };
  }
  if (key.length !== 64) {
    return {
      configured: true,
      valid: false,
      length: key.length,
      error: `DISCORD_PUBLIC_KEY must be 64 hex chars (got ${key.length})`,
    };
  }
  return { configured: true, valid: true, length: 64, error: null };
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

function friendlyDiscordError(data = {}, status = 0, context = "") {
  const code = Number(data.code) || 0;
  const base =
    data.message || data.error_description || `Discord API HTTP ${status}`;
  const where = context ? ` (${context})` : "";

  if (code === 50001 || /missing access/i.test(String(base))) {
    return (
      `Missing Access${where}: the Discord bot cannot see or post in that channel. ` +
      `In Discord: open the channel → Edit Channel → Permissions → add your bot role → ` +
      `allow View Channel, Send Messages, and Embed Links. ` +
      `Also confirm the channel ID is correct (right-click channel → Copy Channel ID).`
    );
  }
  if (code === 50013 || /missing permissions/i.test(String(base))) {
    if (/\/roles\//i.test(String(context))) {
      return (
        `Missing Permissions${where}: the bot cannot assign that role. ` +
        `In Discord Server Settings → Roles: (1) enable Manage Roles for the bot, ` +
        `(2) drag the bot's role ABOVE the subscriber role in the list. ` +
        `Discord blocks bots from granting roles higher than or equal to their own.`
      );
    }
    return (
      `Missing Permissions${where}: give the bot Send Messages + Embed Links ` +
      `(and Manage Roles for claims) in that channel/server.`
    );
  }
  if (code === 10003) {
    return `Unknown Channel${where}: that channel ID does not exist or the bot is not in that server.`;
  }
  return `${base}${where}`;
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
    const err = new Error(friendlyDiscordError(data, response.status, pathname));
    err.status = response.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Bot invite with View Channel + Send Messages + Embed Links + Manage Roles + Read History */
function botInviteUrl() {
  const cfg = getConfig();
  if (!cfg.clientId) return null;
  const permissions = String(
    1024 + // View Channel
      2048 + // Send Messages
      16384 + // Embed Links
      65536 + // Read Message History
      268435456 // Manage Roles
  );
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    permissions,
    scope: "bot applications.commands",
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
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

  // Probe channel first so wrong ID / no access is clearer than a bare Missing Access.
  try {
    await botFetch(`/channels/${targetChannel}`);
  } catch (error) {
    const invite = botInviteUrl();
    const hint = invite ? ` Re-invite bot if needed: ${invite}` : "";
    error.message = `${error.message}${hint}`;
    throw error;
  }

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
  const raw = Buffer.from(normalizePublicKey(publicKeyHex), "hex");
  if (raw.length !== 32) {
    throw new Error(
      `DISCORD_PUBLIC_KEY must be 64 hex chars (32 bytes); got ${raw.length || 0} bytes`
    );
  }
  // SPKI DER prefix for raw Ed25519 public keys
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function verifyInteractionSignature(req) {
  const keyStatus = publicKeyStatus();
  if (!keyStatus.valid) {
    return { ok: false, error: keyStatus.error || "DISCORD_PUBLIC_KEY is invalid" };
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
      ed25519PublicKeyFromHex(getConfig().publicKey),
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

function deferredEphemeralAck() {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 },
  };
}

async function editInteractionReply(interaction, payload = {}) {
  const cfg = getConfig();
  const appId = String(interaction?.application_id || cfg.clientId || "").trim();
  const token = String(interaction?.token || "").trim();
  if (!appId || !token) {
    throw new Error("Missing interaction application_id/token for follow-up");
  }

  const body = {
    content: payload.content || "Done.",
    flags: 64,
  };
  if (payload.components) body.components = payload.components;

  const response = await fetch(
    `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Discord follow-up HTTP ${response.status}`);
  }
  return data;
}

/** Public (or ephemeral) follow-up message tied to the button click. */
async function createInteractionFollowup(interaction, payload = {}) {
  const cfg = getConfig();
  const appId = String(interaction?.application_id || cfg.clientId || "").trim();
  const token = String(interaction?.token || "").trim();
  if (!appId || !token) {
    throw new Error("Missing interaction application_id/token for follow-up");
  }

  const body = {
    content: String(payload.content || "").slice(0, 1900) || "Done.",
  };
  if (payload.ephemeral) body.flags = 64;
  if (payload.components) body.components = payload.components;

  const response = await fetch(`${DISCORD_API}/webhooks/${appId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Discord public follow-up HTTP ${response.status}`);
  }
  return data;
}

async function postChannelMessage(channelId, content) {
  const id = String(channelId || "").trim();
  if (!id) throw new Error("Missing channel id");
  return botFetch(`/channels/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: String(content || "").slice(0, 1900) }),
  });
}

async function postPublicThankYou(interaction, kickName, channelId) {
  const text = `Thank you **${kickName}** for being a sub of na5ty!`;
  // Prefer interaction follow-up so it clearly posts in the same channel beside the private reply.
  try {
    await createInteractionFollowup(interaction, { content: text });
    return;
  } catch (error) {
    console.warn("[discord] public follow-up failed:", error.message || error);
  }
  if (channelId) {
    try {
      await postChannelMessage(channelId, text);
    } catch (error) {
      console.warn("[discord] thank-you channel message failed:", error.message || error);
    }
  }
}

async function handleSubRoleButton(interaction, kickSubscriberStore) {
  const cfg = getConfig();
  const discordUser = interaction.member?.user || interaction.user || {};
  const discordId = String(discordUser.id || "").trim();
  const channelId = String(interaction.channel_id || "").trim();
  const subscribeUrl = "https://kick.com/na5ty/subscribe";

  if (!discordId) {
    return {
      content: "Could not read your Discord user id.",
      components: null,
    };
  }

  const link = kickSubscriberStore.getLinkForDiscordId(discordId);
  if (!link?.kickUserId) {
    const site = cfg.siteUrl || "https://na5ty.com";
    return {
      content:
        "Your Discord is not linked to a Kick login on na5ty.com yet.\n\n" +
        "1. Open na5ty.com and sign in with Kick\n" +
        "2. Go to **Discord Sub Role** → **Link Discord**\n" +
        "3. Come back here and tap **Get Subscriber Role** again",
      components: [
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
      ],
    };
  }

  const kickName = link.kickUsername || "unknown";
  const eligibility = kickSubscriberStore.isEligibleForSubRole(
    link.kickUserId,
    link.kickUsername
  );
  if (!eligibility.eligible) {
    return {
      content:
        `No active Kick sub found for **@${kickName}** yet.\n\n` +
        `You can get the subscriber role by going to ${subscribeUrl} — or wait on a gifted sub — then tap **Get Subscriber Role** again.`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Subscribe on Kick",
              url: subscribeUrl,
            },
          ],
        },
      ],
    };
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
      lastCheckedAt: new Date().toISOString(),
      revokeReason: null,
    });

    if (eligibility.reason === "owner") {
      return {
        content:
          "**You're signed in as the na5ty channel owner** — Discord is linked and you got the subscriber role (owners can't sub to themselves on Kick, so owner access is allowed).",
        components: null,
      };
    }

    // Public thank-you in the same channel + private confirmation below.
    await postPublicThankYou(interaction, kickName, channelId);

    return {
      content:
        `**Thanks @${kickName}!** Your Discord is connected and you got the subscriber role for na5ty.`,
      components: null,
    };
  } catch (error) {
    return {
      content: `Could not grant the role: ${error.message || "unknown Discord error"}`,
      components: null,
    };
  }
}

async function handleInteraction(interaction, kickSubscriberStore) {
  if (interaction?.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }

  if (interaction?.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id;
    if (customId === SUB_ROLE_BUTTON_ID) {
      // Caller should ACK with deferredEphemeralAck() then call resolveComponentInteraction.
      return { defer: true, customId };
    }
    return ephemeralMessage("Unknown button.");
  }

  return ephemeralMessage("Unsupported Discord interaction.");
}

async function resolveComponentInteraction(interaction, kickSubscriberStore) {
  const customId = interaction?.data?.custom_id;
  if (customId === SUB_ROLE_BUTTON_ID) {
    return handleSubRoleButton(interaction, kickSubscriberStore);
  }
  return { content: "Unknown button.", components: null };
}

module.exports = {
  configured,
  getConfig,
  publicKeyStatus,
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
  resolveComponentInteraction,
  deferredEphemeralAck,
  editInteractionReply,
  createInteractionFollowup,
  postChannelMessage,
  botInviteUrl,
  SUB_ROLE_BUTTON_ID,
  DEFAULT_PANEL_CHANNEL_ID,
  InteractionType,
  InteractionResponseType,
};
