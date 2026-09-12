const {
  parseIrcLine,
  toChatPayload,
  classifyUsernotice,
  parseTwitchEmotes,
  channelList,
} = require("../lib/twitch-irc");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

const priv =
  "@badge-info=;badges=subscriber/12,premium/1;color=#FF0000;display-name=Coco;emotes=25:0-4;id=abc-123;mod=0;room-id=1;subscriber=1;tmi-sent-ts=1710000000000;user-id=99 :coco!coco@coco.tmi.twitch.tv PRIVMSG #na5ty :Kappa hello";
const parsed = parseIrcLine(priv);
assert(parsed.command === "PRIVMSG", "privmsg command");
assert(parsed.params[0] === "#na5ty", "channel");
assert(parsed.trailing === "Kappa hello", "text");

const payload = toChatPayload(parsed);
assert(payload.platform === "twitch", "platform");
assert(payload.sender.username === "Coco", "display name");
assert(payload.sender.is_subscriber === true, "sub badge");
assert(payload.sender.is_moderator === false, "not a mod");
assert(payload.emotes[0]?.id === "25", "kappa id");
assert(payload.emotes[0]?.source === "twitch", "emote source");

const gift =
  "@display-name=Gifter;login=gifter;msg-id=submysterygift;msg-param-mass-gift-count=5;user-id=7 :tmi.twitch.tv USERNOTICE #na5ty";
const giftParsed = parseIrcLine(gift);
const notice = classifyUsernotice(giftParsed.tags);
assert(notice.kind === "sub", "gift is a sub");
assert(notice.quantity === 5, "mystery gift count");

const emotes = parseTwitchEmotes("25:0-4,12-16", "Kappa test Kappa");
assert(emotes.length === 2, "two kappa ranges");
assert(channelList("IAMNA5TY, #pipsturr").join(",") === "iamna5ty,pipsturr", "channel list");
assert(channelList("").join(",") === "iamna5ty", "default twitch channel");

const { parseChatControlAction } = require("../lib/kick-chat-actions");
assert(parseChatControlAction("left")?.action === "left", "left is a city control");
assert(parseChatControlAction("right")?.action === "right", "right is a city control");
assert(parseChatControlAction("forward")?.action === "forward", "forward is a city control");

const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "twitch-controls-"));
const rewards = require("../lib/kick-rewards-store");
const recorded = rewards.recordChatMessage({
  streamer: "na5ty",
  username: "coco",
  content: "left",
  messageId: "twitch:test-left",
});
assert(recorded?.controlEvent?.action === "left", "Twitch left becomes a city control event");
const queued = rewards.getControlEvents("na5ty", { afterId: 0, limit: 20 });
assert(
  (queued.events || []).some((row) => row.action === "left" && row.chatter_username === "coco"),
  "FiveM control poll sees Twitch left"
);

console.log("twitch irc check passed");
