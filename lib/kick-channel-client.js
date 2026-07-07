const cloudscraper = require("cloudscraper");

async function fetchChannelV2(slug) {
  const channelSlug = String(slug || "").trim().toLowerCase();
  if (!channelSlug) return null;

  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "na5ty.com-kick-monitor/1",
      },
    });
    if (response.ok) {
      return response.json();
    }
  } catch {
    // fall through to cloudscraper
  }

  return new Promise((resolve, reject) => {
    cloudscraper.get({ url, json: true }, (error, body) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(body);
    });
  });
}

module.exports = {
  fetchChannelV2,
};
