const cloudscraper = require("cloudscraper");

function slugVariants(slug) {
  const base = String(slug || "").trim().toLowerCase();
  if (!base) return [];
  const variants = new Set([base, base.replace(/_/g, "-"), base.replace(/-/g, "_")]);
  return [...variants];
}

async function fetchChannelV2(slug) {
  const channelSlug = String(slug || "").trim().toLowerCase();
  if (!channelSlug) return null;

  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`;

  const fetchJson = async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "na5ty.com-kick-monitor/1",
      },
    });
    if (!response.ok) return null;
    return response.json();
  };

  const scrapeJson = () =>
    new Promise((resolve, reject) => {
      cloudscraper.get({ url, json: true }, (error, body) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(body);
      });
    });

  try {
    const direct = await fetchJson();
    if (direct?.chatroom?.id) return direct;
  } catch {
    // fall through to cloudscraper
  }

  try {
    return await scrapeJson();
  } catch {
    return null;
  }
}

module.exports = {
  fetchChannelV2,
  slugVariants,
};
