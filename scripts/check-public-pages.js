const access = require("../lib/dashboard-access");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

const kickPublic = access.getPublicPages({ provider: "kick", profile: { username: "viewer" } });
const guestPublic = access.getPublicPages(null);
const ownerAllowed = access.getAllowedPages({
  provider: "kick",
  profile: { username: "na5ty", id: "1183030" },
});
const playerAllowed = access.getAllowedPages({
  provider: "kick",
  profile: { username: "pinkyuwu" },
});

assert(guestPublic.join() === kickPublic.join(), "logged-out public tabs match Kick viewers");
assert(kickPublic.includes("city"), "City is public");
assert(kickPublic.includes("profile"), "Profile is public");
assert(kickPublic.includes("streamers"), "Streamers is public");
assert(kickPublic.includes("overview"), "Dashboard is public");
assert(kickPublic.includes("channel"), "Channel is public");
assert(kickPublic.includes("only-pixels"), "Only Pixels is public");
assert(kickPublic.includes("discord"), "Discord Sub is public");
assert(!kickPublic.includes("widgets"), "Widgets is not public");
assert(!kickPublic.includes("bot"), "Chat Bot is not public");
assert(!kickPublic.includes("chat"), "Chat & Subs is not public");
assert(!kickPublic.includes("leaderboard"), "Leaderboard is not public");
assert(!kickPublic.includes("rewards"), "Rewards is not public");
assert(!kickPublic.includes("workout"), "Workout is not public");
assert(!kickPublic.includes("settings"), "Settings is not public");

assert(
  playerAllowed.join() === kickPublic.join(),
  "player allowed pages match public pages"
);
assert(ownerAllowed.includes("widgets"), "owner still gets Widgets");
assert(
  access.getPublicPages({ provider: "kick", profile: { username: "na5ty" } }).join() ===
    kickPublic.join(),
  "na5ty public list is the same as any Kick viewer"
);

console.log("public tabs:", kickPublic.join(", "));
console.log("public pages check passed");
