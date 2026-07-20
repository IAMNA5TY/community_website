const cloudscraper = require("cloudscraper");

const FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.KICK_CHANNEL_FETCH_MS) || 12000);

function slugVariants(slug) {
  const base = String(slug || "").trim().toLowerCase();
  if (!base) return [];
  const variants = new Set([base, base.replace(/_/g, "-"), base.replace(/-/g, "_")]);
  return [...variants];
}

const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://kick.com/",
  Origin: "https://kick.com",
};

function pickChatroom(channel) {
  if (!channel || typeof channel !== "object") return null;
  const chatroom = channel.chatroom || channel.chatRoom || null;
  const id = chatroom?.id || channel.chatroom_id || null;
  if (!id) return null;
  return {
    ...channel,
    chatroom: {
      id,
      channel_id: chatroom?.channel_id || channel.id || null,
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label || "operation"} timeout after ${ms}ms`)),
        ms
      );
    }),
  ]);
}

async function fetchJson(url, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function cloudscraperGet(url, ms = FETCH_TIMEOUT_MS) {
  return withTimeout(
    new Promise((resolve, reject) => {
      cloudscraper.get(
        {
          url,
          json: true,
          headers: BROWSER_HEADERS,
          rejectUnauthorized: false,
          timeout: ms,
        },
        (error, _response, data) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(data);
        }
      );
    }),
    ms,
    `cloudscraper ${url}`
  );
}

async function fetchChannelV2(slug) {
  const channelSlug = String(slug || "").trim().toLowerCase();
  if (!channelSlug) return null;

  const urls = [
    `https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(channelSlug)}`,
  ];

  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const normalized = pickChatroom(data);
      if (normalized?.chatroom?.id) return normalized;
    } catch {
      // try next
    }
  }

  for (const url of urls) {
    try {
      const body = await cloudscraperGet(url);
      const normalized = pickChatroom(body);
      if (normalized?.chatroom?.id) return normalized;
    } catch {
      // try next
    }
  }

  return null;
}

module.exports = {
  fetchChannelV2,
  slugVariants,
  pickChatroom,
};
