const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOKEN_PATH = path.join(DATA_DIR, "bot-tokens.json");

function readTokens() {
  if (!fs.existsSync(TOKEN_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeTokens(tokens) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

function saveBroadcasterToken(broadcasterUserId, tokenData) {
  const tokens = readTokens();
  tokens[String(broadcasterUserId)] = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    expiresAt: tokenData.expiresAt,
    username: tokenData.username,
    updatedAt: new Date().toISOString(),
  };
  writeTokens(tokens);
}

function getBroadcasterToken(broadcasterUserId) {
  const tokens = readTokens();
  return tokens[String(broadcasterUserId)] || null;
}

function updateBroadcasterToken(broadcasterUserId, updates) {
  const current = getBroadcasterToken(broadcasterUserId);
  if (!current) return null;

  saveBroadcasterToken(broadcasterUserId, { ...current, ...updates });
  return getBroadcasterToken(broadcasterUserId);
}

function removeBroadcasterToken(broadcasterUserId) {
  const tokens = readTokens();
  delete tokens[String(broadcasterUserId)];
  writeTokens(tokens);
}

function getPrimaryBroadcasterId() {
  const tokens = readTokens();
  const ids = Object.keys(tokens);
  return ids.length ? ids[0] : null;
}

module.exports = {
  saveBroadcasterToken,
  getBroadcasterToken,
  updateBroadcasterToken,
  removeBroadcasterToken,
  getPrimaryBroadcasterId,
};
