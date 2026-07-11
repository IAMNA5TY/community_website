const fs = require("fs");
const path = require("path");

const eventStore = require("./event-store");
const tokenStore = require("./token-store");
const { getDataDir, ensureDataDir } = require("./data-dir");

const STATE_PATH = path.join(getDataDir(), "workout-state.json");
const BACKUP_PATH = path.join(getDataDir(), "workout-state.backup.json");

/** If end time is this far past, treat as crash/restart — do NOT wipe the minute bank. */
const STALE_EXPIRE_MS = 90 * 1000;

const DEFAULT_STATE = {
  subs: 0,
  minutesBank: 0,
  minutesRemaining: 0,
  isRunning: false,
  treadmillEndAt: null,
  _secondsLeft: 0,
  weight: 245,
  goalWeight: 200,
  bench: 225,
  squat: 315,
  deadlift: 405,
  startWeight: 245,
  streamerName: "NA5TY",
  walkName: "Nasty",
  messageCount: 0,
  broadcasterUserId: null,
  sessionStartedAt: null,
  stateNonce: 0,
};

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    if (fs.existsSync(BACKUP_PATH)) {
      try {
        return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8")) };
      } catch {
        /* fall through */
      }
    }
    return { ...DEFAULT_STATE };
  }

  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
  } catch {
    if (fs.existsSync(BACKUP_PATH)) {
      try {
        return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8")) };
      } catch {
        /* fall through */
      }
    }
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  ensureDataDir();
  const payload = JSON.stringify(state, null, 2);
  // Backup first so a bad write / restart never leaves you at 0 with no recovery.
  if (fs.existsSync(STATE_PATH)) {
    try {
      fs.copyFileSync(STATE_PATH, BACKUP_PATH);
    } catch {
      /* ignore */
    }
  }
  fs.writeFileSync(STATE_PATH, payload);
  try {
    fs.writeFileSync(BACKUP_PATH, payload);
  } catch {
    /* ignore */
  }
}

function getSeconds(state) {
  if (state.isRunning && state.treadmillEndAt) {
    return Math.max(0, Math.ceil((state.treadmillEndAt - Date.now()) / 1000));
  }
  return state._secondsLeft || state.minutesBank * 60;
}

function pauseKeepBank(state) {
  const next = { ...state };
  next.isRunning = false;
  next.treadmillEndAt = null;
  const seconds =
    next._secondsLeft > 0
      ? next._secondsLeft
      : Math.max(0, (next.minutesBank || 0) * 60);
  next._secondsLeft = seconds;
  next.minutesBank = Math.max(next.minutesBank || 0, Math.ceil(seconds / 60));
  next.minutesRemaining = next.minutesBank;
  return next;
}

function tick(state) {
  const next = { ...state };

  if (next.isRunning && next.treadmillEndAt) {
    const remainingMs = next.treadmillEndAt - Date.now();
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

    if (remaining <= 0) {
      const overdueMs = Date.now() - next.treadmillEndAt;
      // Site update / server restart while running: endAt is stale — pause, keep bank.
      if (overdueMs > STALE_EXPIRE_MS) {
        return pauseKeepBank(next);
      }
      // Real finish while the server was up.
      next.isRunning = false;
      next.treadmillEndAt = null;
      next._secondsLeft = 0;
      next.minutesBank = 0;
      next.minutesRemaining = 0;
    } else {
      next._secondsLeft = remaining;
      next.minutesBank = Math.ceil(remaining / 60);
      next.minutesRemaining = next.minutesBank;
    }
  }

  return next;
}

let bootRecovered = false;
function recoverAfterRestart() {
  if (bootRecovered) return;
  bootRecovered = true;
  const state = readState();
  if (!state.isRunning || !state.treadmillEndAt) return;

  const remainingMs = state.treadmillEndAt - Date.now();
  if (remainingMs > 0) {
    // Still time left — leave running (or pause for safety on restart).
    // Pause so a long deploy can't race the clock to zero.
    const paused = pauseKeepBank({
      ...state,
      _secondsLeft: Math.ceil(remainingMs / 1000),
      minutesBank: Math.ceil(remainingMs / 60),
    });
    writeState({ ...paused, stateNonce: (state.stateNonce || 0) + 1 });
    console.log(
      `[workout] paused treadmill after restart — kept ${paused.minutesBank} min banked`
    );
    return;
  }

  const overdueMs = -remainingMs;
  if (overdueMs > STALE_EXPIRE_MS) {
    const paused = pauseKeepBank(state);
    writeState({ ...paused, stateNonce: (state.stateNonce || 0) + 1 });
    console.log(
      `[workout] recovered stale run after restart — kept ${paused.minutesBank} min banked`
    );
  }
}

function load() {
  recoverAfterRestart();
  return tick(readState());
}

function loadForDisplay() {
  const state = load();
  const broadcasterId =
    state.broadcasterUserId || tokenStore.getPrimaryBroadcasterId();

  if (!broadcasterId) {
    return state;
  }

  const messageCount = state.sessionStartedAt
    ? state.messageCount || 0
    : Math.max(state.messageCount || 0, eventStore.getTotalMessageCount(broadcasterId));

  const giftedSubs = eventStore.getSessionSubCount(
    broadcasterId,
    state.sessionStartedAt
  );

  return {
    ...state,
    messageCount,
    giftedSubs,
    broadcasterUserId: String(broadcasterId),
  };
}

function setBroadcaster(broadcasterUserId, state = load()) {
  return save({ ...state, broadcasterUserId: String(broadcasterUserId) });
}

function save(incoming, options = {}) {
  const prev = readState();
  let merged = { ...prev, ...incoming };

  // Block OBS widgets from saving a "timer finished → 0" wipe after a site restart.
  const incomingBank = Number(incoming?.minutesBank);
  const prevBank = Number(prev.minutesBank) || 0;
  if (
    incoming &&
    incomingBank === 0 &&
    prevBank > 0 &&
    incoming.isRunning === false &&
    (prev.isRunning === true || prev.treadmillEndAt)
  ) {
    const endAt = Number(prev.treadmillEndAt || incoming.treadmillEndAt) || 0;
    if (endAt && Date.now() - endAt > STALE_EXPIRE_MS) {
      merged = pauseKeepBank({
        ...merged,
        minutesBank: prevBank,
        _secondsLeft: prev._secondsLeft || prevBank * 60,
      });
      console.warn(
        `[workout] blocked stale zero-save — kept ${prevBank} min banked`
      );
    }
  }

  const state = tick(merged);
  state.stateNonce = (prev.stateNonce || 0) + 1;
  writeState(state);
  if (!options.silent) {
    try {
      require("./workout-events").broadcastState(loadForDisplay());
    } catch {
      /* optional */
    }
  }
  return state;
}

function addSub(count = 1, state = load()) {
  return addMinutes(count, state, count);
}

function addMinutes(mins = 1, state = load(), subCount = 0) {
  const next = { ...state };
  const addSeconds = mins * 60;

  if (subCount > 0) next.subs += subCount;
  next.minutesBank += mins;

  if (next.isRunning && next.treadmillEndAt) {
    next.treadmillEndAt += addSeconds * 1000;
    next._secondsLeft = getSeconds(next);
  } else {
    next._secondsLeft = next.minutesBank * 60;
  }

  next.minutesRemaining = Math.ceil((next._secondsLeft || 0) / 60);
  return save(next);
}

function setMinutes(mins, state = load()) {
  const safeMins = Math.max(0, parseInt(mins, 10) || 0);
  const next = { ...state };
  next.minutesBank = safeMins;
  next.minutesRemaining = safeMins;
  next._secondsLeft = safeMins * 60;

  if (next.isRunning) {
    next.treadmillEndAt = Date.now() + safeMins * 60 * 1000;
    if (safeMins <= 0) {
      next.isRunning = false;
      next.treadmillEndAt = null;
    }
  }

  return save(next);
}

function adjustMinutes(delta, state = load()) {
  return setMinutes(Math.max(0, state.minutesBank + delta), state);
}

function setTotals(subs, mins, state = load()) {
  const next = { ...state };
  const safeSubs = Math.max(0, parseInt(subs, 10) || 0);
  const safeMins = Math.max(0, parseInt(mins, 10) || 0);
  const seconds = safeMins * 60;

  next.subs = safeSubs;
  next.minutesBank = safeMins;
  next.minutesRemaining = safeMins;
  next._secondsLeft = seconds;

  if (next.isRunning) {
    next.treadmillEndAt = Date.now() + seconds * 1000;
    if (seconds <= 0) {
      next.isRunning = false;
      next.treadmillEndAt = null;
    }
  }

  return save(next);
}

function startTreadmill(state = load()) {
  const next = { ...state };
  const seconds = getSeconds(next);

  if (seconds <= 0) {
    return { state: next, error: "No minutes banked" };
  }

  next.isRunning = true;
  next.treadmillEndAt = Date.now() + seconds * 1000;
  next._secondsLeft = seconds;
  return { state: save(next) };
}

function stopTreadmill(state = load()) {
  const next = { ...state };

  if (next.isRunning && next.treadmillEndAt) {
    const remainingMs = next.treadmillEndAt - Date.now();
    if (remainingMs <= 0 && Date.now() - next.treadmillEndAt > STALE_EXPIRE_MS) {
      return save(pauseKeepBank(next));
    }
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    next._secondsLeft = remaining;
    next.minutesBank = Math.ceil(remaining / 60);
    next.minutesRemaining = next.minutesBank;
  }

  next.isRunning = false;
  next.treadmillEndAt = null;
  return save(next);
}

function resetSession(state = load()) {
  const keep = {
    weight: state.weight,
    goalWeight: state.goalWeight,
    bench: state.bench,
    squat: state.squat,
    deadlift: state.deadlift,
    startWeight: state.startWeight,
    streamerName: state.streamerName,
    walkName: state.walkName,
    broadcasterUserId: state.broadcasterUserId,
  };
  return save({
    ...DEFAULT_STATE,
    ...keep,
    sessionStartedAt: new Date().toISOString(),
  });
}

function syncMessageCountFromEvents(broadcasterUserId) {
  const eventStore = require("./event-store");
  const data = eventStore.getChannelData(String(broadcasterUserId));
  const count = data.stats?.totalMessages ?? 0;
  const state = readState();
  if ((state.messageCount || 0) < count) {
    return save({ ...state, messageCount: count });
  }
  return load();
}

function incrementMessages(count = 1, state = load()) {
  const next = { ...state };
  next.messageCount = (next.messageCount || 0) + count;
  return save(next, { silent: true });
}

function incrementMessagesForBroadcaster(broadcasterUserId, count = 1) {
  const state = load();
  if (
    state.broadcasterUserId &&
    String(state.broadcasterUserId) !== String(broadcasterUserId)
  ) {
    return state;
  }
  return incrementMessages(count, state);
}

function updateStats(fields, state = load()) {
  return save({ ...state, ...fields });
}

function formatWalkMessage(state = load()) {
  const name = state.walkName || state.streamerName || "Nasty";
  const minutes = state.minutesBank || 0;
  return `${name} owes ${minutes} minute${minutes === 1 ? "" : "s"} on the treadmill`;
}

function parseWalkCommand(content) {
  const trimmed = content.trim();

  const setMatch = trimmed.match(/^!walk\s+set\s+(\d+)\s*$/i);
  if (setMatch) return { action: "set", minutes: Number(setMatch[1]) };

  const match = trimmed.match(/^!walk(?:\s+([+-])\s*(\d+)?)?$/i);
  if (!match) return null;
  if (!match[1]) return { action: "show" };

  const sign = match[1] === "+" ? 1 : -1;
  const amount = match[2] ? Number(match[2]) : 1;
  return { action: "adjust", delta: sign * amount };
}

function parseModCommand(content) {
  const trimmed = content.trim().toLowerCase();
  if (trimmed === "!start") return { action: "start" };
  if (trimmed === "!stop") return { action: "stop" };
  if (trimmed === "!reset") return { action: "reset" };
  return null;
}

module.exports = {
  DEFAULT_STATE,
  load,
  loadForDisplay,
  setBroadcaster,
  save,
  tick,
  getSeconds,
  addSub,
  addMinutes,
  setMinutes,
  adjustMinutes,
  setTotals,
  startTreadmill,
  stopTreadmill,
  resetSession,
  incrementMessages,
  incrementMessagesForBroadcaster,
  syncMessageCountFromEvents,
  updateStats,
  formatWalkMessage,
  parseWalkCommand,
  parseModCommand,
};
