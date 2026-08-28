const access = require("../lib/partner-registry");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

assert(access.isBlocked("sadzii"), "sadzii is blocked");
assert(access.isBlocked("SadZii"), "SadZii is blocked");
assert(access.isBlocked("@sadzii"), "@sadzii is blocked");
assert(!access.isApproved("sadzii"), "sadzii cannot be approved");
assert(access.isBanned("sadzii"), "sadzii counts as banned");
assert(!access.isBlocked("na5ty"), "na5ty is not blocked");

console.log("blocked partners check passed");
