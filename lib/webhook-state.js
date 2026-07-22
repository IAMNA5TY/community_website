const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_PATH = path.join(DATA_DIR, "webhook-state.json");

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function noteWebhookUrl(webhookUrl) {
  const state = readState();
  const previousUrl = state.webhookUrl || null;
  const changed = Boolean(previousUrl && previousUrl !== webhookUrl);

  writeState({
    ...state,
    webhookUrl,
    previousUrl: changed ? previousUrl : state.previousUrl || null,
    updatedAt: new Date().toISOString(),
    changedAt: changed ? new Date().toISOString() : state.changedAt || null,
    // Force a fresh chat-webhook purge when the callback URL changes.
    chatMessagePurgedAt: changed ? null : state.chatMessagePurgedAt || null,
  });

  return { changed, previousUrl };
}

function getWebhookState() {
  return readState();
}

function shouldPurgeChatMessageSubscriptions() {
  const state = readState();
  return !state.chatMessagePurgedAt;
}

function noteChatMessagePurged() {
  const state = readState();
  writeState({
    ...state,
    chatMessagePurgedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

module.exports = {
  noteWebhookUrl,
  getWebhookState,
  shouldPurgeChatMessageSubscriptions,
  noteChatMessagePurged,
};
