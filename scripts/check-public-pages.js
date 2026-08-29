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

const guestNav = access.getGuestPages();
assert(guestPublic.join() === kickPublic.join(), "logged-out public tabs match Kick viewers");
assert(guestNav.includes("city"), "City is a guest tab");
assert(!guestNav.includes("streamers"), "Streamers is folded into City");
assert(!guestNav.includes("overview"), "Dashboard is not a guest tab");
assert(!guestNav.includes("channel"), "Channel is folded into Dashboard");
assert(kickPublic.includes("city"), "City is public");
assert(kickPublic.includes("profile"), "Profile is public");
assert(!kickPublic.includes("streamers"), "Streamers is folded into City");
assert(kickPublic.includes("overview"), "Dashboard is public");
assert(!kickPublic.includes("channel"), "Channel is folded into Dashboard");
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

assert(access.isPublicOverlayApiPath("/state"), "workout /api/state is a public overlay GET");
assert(access.isPublicOverlayApiPath("/chat/messages"), "chat box /api/chat/messages is public");
assert(access.isPublicOverlayApiPath("/chat/events"), "chat SSE is public");
assert(access.isPublicOverlayApiPath("/alerts/state"), "stream alerts state is public");
assert(access.isPublicOverlayApiPath("/alerts/events"), "stream alerts SSE is public");
assert(access.isPublicOverlayApiPath("/slots"), "slots overlay is public");
assert(access.isPublicOverlayApiPath("/slots-timer"), "slots timer overlay is public");
assert(access.isPublicOverlayApiPath("/sub-goal"), "sub goal overlay is public");
assert(!access.isPublicOverlayApiPath("/bot"), "chat bot API stays owner-only");
assert(!access.isPublicOverlayApiPath("/webhooks/status"), "webhook status stays owner-only");
assert(!access.isPlayerAllowedApiPath("/state"), "player tab allowlist does not cover overlays");

console.log("public tabs:", kickPublic.join(", "));
console.log("public pages check passed");
