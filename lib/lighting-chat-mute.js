const mutedBroadcasterIds = new Set();
let flashEpoch = 0;

function mute(broadcasterUserId) {
  mutedBroadcasterIds.add(String(broadcasterUserId));
  flashEpoch += 1;
  return flashEpoch;
}

function unmute(broadcasterUserId) {
  mutedBroadcasterIds.delete(String(broadcasterUserId));
  flashEpoch += 1;
  return flashEpoch;
}

function isMuted(broadcasterUserId) {
  return mutedBroadcasterIds.has(String(broadcasterUserId));
}

function getFlashEpoch() {
  return flashEpoch;
}

function isFlashEpochCurrent(epoch) {
  return epoch === flashEpoch;
}

module.exports = {
  mute,
  unmute,
  isMuted,
  getFlashEpoch,
  isFlashEpochCurrent,
};
