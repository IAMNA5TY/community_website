const cloudscraper = require("cloudscraper");

const CACHE_MS = 4 * 60 * 60 * 1000;
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

function fetchFromKick(slug) {
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

        const payload = response?.body || response;
        if (!payload?.gifts && !payload?.gifts_week && !payload?.gifts_month) {
          return reject(new Error("Unexpected gifted sub leaderboard response"));
        }

        resolve({
          week: mapEntries(payload.gifts_week),
          month: mapEntries(payload.gifts_month),
          lifetime: mapEntries(payload.gifts),
          source: "kick.com",
        });
      }
    );
  });
}

async function getGiftedSubLeaderboard(slug, limit = 25) {
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
    };
    cache = { slug: channelSlug, at: Date.now(), data: result };
    return result;
  } catch (error) {
    console.warn("Gifted sub leaderboard fetch failed:", error.message);
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
};
