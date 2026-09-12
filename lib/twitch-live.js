const DEFAULT_LOGIN = String(process.env.TWITCH_CHAT_CHANNEL || "iamna5ty")
  .trim()
  .toLowerCase()
  .replace(/^#/, "") || "iamna5ty";

let cachedToken = { value: null, expiresAt: 0 };
let cachedStream = { login: "", at: 0, data: null };

async function getAppToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (cachedToken.value && cachedToken.expiresAt > Date.now() + 60 * 1000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.message || "Twitch app token failed");
  }
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

async function getLiveStatus(login = DEFAULT_LOGIN) {
  const channel = String(login || DEFAULT_LOGIN)
    .trim()
    .toLowerCase()
    .replace(/^#/, "") || DEFAULT_LOGIN;
  if (cachedStream.login === channel && Date.now() - cachedStream.at < 30 * 1000) {
    return cachedStream.data;
  }

  const token = await getAppToken();
  const fallback = {
    login: channel,
    displayName: channel === "iamna5ty" ? "IAMNA5TY" : channel,
    isLive: false,
    title: null,
    viewerCount: null,
    configured: Boolean(token),
  };
  if (!token) {
    cachedStream = { login: channel, at: Date.now(), data: fallback };
    return fallback;
  }

  const res = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`,
    {
      headers: {
        "Client-Id": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
      },
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || "Twitch live check failed");
  }
  const stream = Array.isArray(data.data) ? data.data[0] : null;
  const next = {
    login: channel,
    displayName: channel === "iamna5ty" ? "IAMNA5TY" : channel,
    isLive: Boolean(stream),
    title: stream?.title || null,
    viewerCount: stream?.viewer_count ?? null,
    configured: true,
  };
  cachedStream = { login: channel, at: Date.now(), data: next };
  return next;
}

module.exports = {
  DEFAULT_LOGIN,
  getLiveStatus,
};
