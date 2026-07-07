const cloudscraper = require("cloudscraper");

const CACHE_MS = 60 * 1000;
let cache = { slug: null, at: 0, data: null };

function mapEntries(list = []) {
  return list.map((row, index) => ({
    rank: index + 1,
    user_id: row.user_id,
    username: row.username,
    quantity: row.quantity || 0,
    gifted_amount: row.quantity || 0,
  }));
}

function parsePayload(payload) {
  if (!payload?.gifts && !payload?.gifts_week && !payload?.gifts_month) {
    throw new Error("Unexpected gifted sub leaderboard response");
  }

  return {
    week: mapEntries(payload.gifts_week),
    month: mapEntries(payload.gifts_month),
    lifetime: mapEntries(payload.gifts),
    source: "kick.com",
  };
}

async function fetchWithNode(slug) {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/leaderboards`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://kick.com/",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Kick leaderboards HTTP ${response.status}`);
  }

  return parsePayload(await response.json());
}

function fetchWithCloudscraper(slug) {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/leaderboards`;

  return new Promise((resolve, reject) => {
    cloudscraper.get(
      {
        uri: url,
        json: true,
        timeout: 20000,
        headers: { Accept: "application/json" },
      },
      (error, response) => {
        if (error) return reject(error);
        try {
          resolve(parsePayload(response?.body || response));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

async function fetchFromKick(slug) {
  try {
    return await fetchWithNode(slug);
  } catch (nodeError) {
    console.warn("[gifted-subs] fetch failed, trying cloudscraper:", nodeError.message);
    return fetchWithCloudscraper(slug);
  }
}

function clearCache(slug) {
  if (!slug || cache.slug === slug) {
    cache = { slug: null, at: 0, data: null };
  }
}

async function getGiftedSubLeaderboard(slug, limit = 25, { force = false } = {}) {
  const channelSlug = String(slug || "").trim();
  if (!channelSlug) {
    return {
      week: [],
      month: [],
      lifetime: [],
      source: "unavailable",
      error: "Channel slug missing",
    };
  }

  if (
    !force &&
    cache.slug === channelSlug &&
    cache.data &&
    Date.now() - cache.at < CACHE_MS
  ) {
    return cache.data;
  }

  try {
    const data = await fetchFromKick(channelSlug);
    const trim = (entries) => entries.slice(0, limit);
    const result = {
      week: trim(data.week),
      month: trim(data.month),
      lifetime: trim(data.lifetime),
      source: data.source,
      updatedAt: new Date().toISOString(),
    };
    cache = { slug: channelSlug, at: Date.now(), data: result };
    return result;
  } catch (error) {
    console.warn("Gifted sub leaderboard fetch failed:", error.message);
    if (cache.slug === channelSlug && cache.data) {
      return { ...cache.data, stale: true, error: error.message };
    }
    return {
      week: [],
      month: [],
      lifetime: [],
      source: "unavailable",
      error: error.message,
    };
  }
}

module.exports = {
  getGiftedSubLeaderboard,
  clearCache,
};
