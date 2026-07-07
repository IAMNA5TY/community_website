const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOKEN_PATH = path.join(DATA_DIR, "spotify-tokens.json");

function readTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return {};
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

function saveToken(broadcasterUserId, tokenData) {
  const tokens = readTokens();
  tokens[String(broadcasterUserId)] = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    expiresAt: tokenData.expiresAt,
    scope: tokenData.scope || "",
    displayName: tokenData.displayName || null,
    updatedAt: new Date().toISOString(),
  };
  writeTokens(tokens);
  return tokens[String(broadcasterUserId)];
}

function getToken(broadcasterUserId) {
  return readTokens()[String(broadcasterUserId)] || null;
}

function deleteToken(broadcasterUserId) {
  const tokens = readTokens();
  delete tokens[String(broadcasterUserId)];
  writeTokens(tokens);
}

function updateToken(broadcasterUserId, patch) {
  const tokens = readTokens();
  const id = String(broadcasterUserId);
  if (!tokens[id]) return null;
  tokens[id] = { ...tokens[id], ...patch, updatedAt: new Date().toISOString() };
  writeTokens(tokens);
  return tokens[id];
}

module.exports = {
  getToken,
  saveToken,
  deleteToken,
  updateToken,
};
