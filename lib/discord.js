const DISCORD_API = "https://discord.com/api/v10";

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

module.exports = {
  configured,
  getConfig,
  redirectUri,
  authorizeUrl,
  exchangeCode,
  fetchOauthUser,
  addSubRole,
  removeSubRole,
};
