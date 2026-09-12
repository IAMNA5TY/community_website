const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twitch-link-"));
process.env.DATA_DIR = dir;

const rewards = require("../lib/kick-rewards-store");
const partners = require("../lib/partner-registry");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

const synced = rewards.registerKickUsername("pinkyuwu", { displayName: "Pinky" });
const linked = rewards.linkGameLicense(synced.linkCode, "license-pinky-1");
assert(linked.gameLicense === "license-pinky-1", "kickmenu license is stored after sync");

const appsBefore = partners.listApplications().length;
partners.apply({ kickUsername: "pinkyuwu", displayName: "Pinky" });
partners.moderate("pinkyuwu", "approved", { staffUsername: "na5ty" });
assert(partners.isApproved("pinkyuwu"), "kick player is approved");

const twitch = rewards.linkTwitchUsername("pinkyuwu", "PinkyTwitch");
assert(twitch.gameLicense === "license-pinky-1", "adding twitch does not wipe gameLicense");
assert(twitch.twitchUsername === "pinkytwitch", "twitch stored lowercase");
assert(rewards.getRegistration("pinkyuwu").linkCode === synced.linkCode, "kick link code stays");

const afterLink = partners.setTwitchUsername("pinkyuwu", "PinkyTwitch");
assert(afterLink.status === "approved", "application stays approved");
assert(afterLink.twitchUsername === "pinkytwitch", "application stores twitch");
assert(partners.listApplications().length === appsBefore + 1, "setTwitchUsername does not create extra apps");

const missing = partners.setTwitchUsername("never-applied", "someone");
assert(!missing, "setTwitchUsername does not create a pending application");
assert(!partners.getApplication("never-applied"), "unknown kick user stays unapplied");

assert(rewards.resolveLinkedUsername("PinkyTwitch") === "pinkyuwu", "twitch login maps to kick");
assert(rewards.resolveLinkedUsername("pinkyuwu") === "pinkyuwu", "kick login stays kick");

const recorded = rewards.recordChatMessage({
  streamer: "na5ty",
  username: "PinkyTwitch",
  content: "left",
  messageId: "twitch:link-test-left",
});
assert(recorded?.controlEvent?.action === "left", "twitch left is a city control");
assert(
  recorded?.controlEvent?.chatter_username === "pinkyuwu",
  "control is attributed to the Kick username"
);

const queued = rewards.getControlEvents("na5ty", { afterId: 0, limit: 20 });
assert(
  (queued.events || []).some((row) => row.action === "left" && row.chatter_username === "pinkyuwu"),
  "FiveM sees twitch left as the Kick username"
);

const house = rewards.linkTwitchUsername("na5ty", "IAMNA5TY");
assert(house.twitchUsername === "iamna5ty", "house twitch can be added without a new Kick app");
assert(!partners.getApplication("na5ty"), "house twitch link does not open a partner application");

const listed = rewards.listTwitchLinks();
assert(
  listed.some((row) => row.kickUsername === "pinkyuwu" && row.twitchUsername === "pinkytwitch"),
  "approved link appears in twitch channel list"
);

const taken = (() => {
  try {
    rewards.linkTwitchUsername("someoneelse", "pinkytwitch");
    return null;
  } catch (error) {
    return error.message;
  }
})();
assert(taken && /already linked/i.test(taken), "twitch name cannot be stolen");

assert(
  rewards.getRegistrationByLicense("license:license-pinky-1")?.kickUsername === "pinkyuwu",
  "license: prefix still finds the /kickmenu link"
);
assert(
  rewards.getRegistrationByLicense("license-pinky-1")?.gameLicense === "license-pinky-1",
  "bare license still finds the same Kick account"
);

const again = rewards.linkTwitchUsername("pinkyuwu", "PinkyTwitch2");
assert(again.gameLicense === "license-pinky-1", "changing twitch name still keeps kickmenu license");
assert(again.twitchUsername === "pinkytwitch2", "twitch name can be updated later");

console.log("twitch link without resync check passed");
