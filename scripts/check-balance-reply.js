const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kick-balance-"));
process.env.DATA_DIR = dir;

const store = require("../lib/kick-rewards-store");
const { formatBalanceReply } = require("../lib/kick-balance-reply");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

for (let i = 0; i < 40; i += 1) {
  store.recordChatMessage({
    streamer: "na5ty",
    username: "coco",
    content: `hello ${i}`,
    createdAt: new Date().toISOString(),
    messageId: `chat-${i}`,
  });
}

const computed = store.getViewerPointsOnChannel("na5ty", "coco", { hours: 24 });
assert(computed.points >= 40, "chat-count estimate is high");
assert(!store.getStoredViewerBalance("na5ty", "coco"), "no synced RP balance yet");

store.ingestBalanceReply("na5ty", "@coco has 142 points");
assert(
  store.getStoredViewerBalance("na5ty", "coco")?.points === 142,
  "game line stores the live RP balance"
);

store.ingestBalanceReply(
  "na5ty",
  formatBalanceReply("coco", 999, "na5ty")
);
assert(
  store.getStoredViewerBalance("na5ty", "coco")?.points === 142,
  "site promo must not overwrite the live RP balance"
);

const line = formatBalanceReply("coco", 142, "na5ty");
assert(line.includes("142 points"), "reply uses the synced number");
assert(!line.includes("40"), "reply does not use the chat-count estimate");

console.log("balance reply check passed");
