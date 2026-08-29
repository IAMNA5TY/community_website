const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kick-rewards-echo-"));
process.env.DATA_DIR = dir;

const store = require("../lib/kick-rewards-store");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

store.recordChatMessage({
  streamer: "the_dirty_southgaming",
  username: "NA5TY",
  content: "hello from city",
});
let rows = store.getRecentMessages("the_dirty_southgaming", { hours: 6, limit: 20 });
assert(rows.some((row) => row.content === "hello from city"), "City send is in recent chat");

store.recordChatMessage({
  streamer: "the_dirty_southgaming",
  username: "na5ty",
  content: "hello from city",
  messageId: "kick-echo-1",
});
rows = store.getRecentMessages("the_dirty_southgaming", { hours: 6, limit: 20 });
assert(
  rows.filter((row) => row.content === "hello from city").length === 1,
  "Pusher echo of the same City line does not double"
);

store.recordChatMessage({
  streamer: "the_dirty_southgaming",
  username: "na5ty",
  content: "hello from city",
  messageId: "kick-echo-2",
});
const chatter = store
  .getChatters("the_dirty_southgaming", { hours: 6, limit: 10 })
  .chatters.find((row) => row.username === "na5ty");
assert(chatter?.message_count === 2, "Two real Kick ids still count as two chats");

console.log("city chat echo check passed");
