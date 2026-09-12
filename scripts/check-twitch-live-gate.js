const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "twitch-live-gate-"));
delete process.env.TWITCH_CLIENT_ID;
delete process.env.TWITCH_CLIENT_SECRET;
process.env.TWITCH_CITY_REQUIRE_LIVE = "1";
process.env.TWITCH_CHAT_CHANNEL = "iamna5ty";
process.env.OWNER_KICK_USERNAMES = "na5ty,pipsturr";
process.env.OWNER_TWITCH_USERNAMES = "iamna5ty";

const gate = require("../lib/twitch-city-gate");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

assert(gate.isOfflineTestBypass("IAMNA5TY") === true, "house twitch can test while offline");
assert(gate.isOfflineTestBypass("na5ty") === true, "house kick can test while offline");
assert(gate.isOfflineTestBypass("coco") === false, "regular chatter is live-only");

(async () => {
  const owner = await gate.canUseTwitchCityChat("IAMNA5TY");
  assert(owner.ok === true, "owner is allowed offline");
  assert(owner.reason === "owner-test", "owner uses the test bypass");

  const viewer = await gate.canUseTwitchCityChat("coco");
  assert(viewer.ok === false, "regular twitch chat is blocked while offline");
  assert(viewer.reason === "offline", "blocked reason is offline");

  process.env.TWITCH_CITY_REQUIRE_LIVE = "0";
  const open = await gate.canUseTwitchCityChat("coco");
  assert(open.ok === true, "live gate can be disabled");

  console.log("twitch live-only gate check passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
