const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kick-balance-"));
process.env.DATA_DIR = dir;

const store = require("../lib/kick-rewards-store");
const { formatBalanceReply, pickBalancePoints } = require("../lib/kick-balance-reply");

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

assert(pickBalancePoints({ points: 142 }, 40) === 142, "live RP wins over chat total");
assert(pickBalancePoints({ points: 0 }, 40) === 40, "do not announce 0 when chat has points");
assert(pickBalancePoints(null, 12) === 12, "no sync uses the 24h chat total");

store.setViewerBalance("the_dirty_southgaming", "na5ty", 0, { source: "balance" });
for (let i = 0; i < 9; i += 1) {
  store.recordChatMessage({
    streamer: "the_dirty_southgaming",
    username: "na5ty",
    content: "[emote:1:KEKW]",
    createdAt: new Date().toISOString(),
    messageId: `emote-${i}`,
  });
}
const dirty = store.getViewerPointsOnChannel("the_dirty_southgaming", "na5ty", {
  hours: 24,
});
assert(dirty.points >= 9, "a stored 0 must not hide chat points on that channel");

console.log("balance reply check passed");
