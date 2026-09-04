const path = require("path");
const fs = require("fs");
const { getDataDir, ensureDataDir } = require("./data-dir");

const STATE_PATH = path.join(getDataDir(), "stream-subathon-state.json");
const HARD_MAX_SECONDS = 99 * 60 * 60;
const DEFAULT_START_SECONDS = 60 * 60;
const DEFAULT_SECONDS_PER_SUB = 5 * 60;
const TEN_MIN_SECONDS = 10 * 60;
const OPENING_SUBS = 300;

const DEFAULT_STATE = {
  count: 0,
  label: "SUBATHON",
  startSeconds: DEFAULT_START_SECONDS,
  secondsPerSub: DEFAULT_SECONDS_PER_SUB,
  maxSeconds: 0,
  pausedRemaining: DEFAULT_START_SECONDS,
  isRunning: false,
  endsAt: null,
  sessionStartedAt: null,
  lastSubAt: null,
  lastSubBy: null,
  lastAddedSeconds: 0,
  nonce: 0,
  scaledToFiveMin: false,
};

function clampRemaining(seconds, maxSeconds = 0) {
  const cap = maxSeconds > 0 ? Math.min(maxSeconds, HARD_MAX_SECONDS) : HARD_MAX_SECONDS;
  return Math.min(cap, Math.max(0, Math.round(Number(seconds) || 0)));
}

function readRaw() {
  if (!fs.existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE };
  }
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function scaleRemainingInHalf(next) {
  const remaining =
    next.isRunning && next.endsAt
      ? Math.max(0, (next.endsAt - Date.now()) / 1000)
      : Math.max(0, Number(next.pausedRemaining) || 0);
  const half = remaining / 2;
  next.pausedRemaining = Math.round(half);
  if (next.isRunning && next.endsAt) {
    next.endsAt = Date.now() + half * 1000;
  }
  if (parseInt(next.startSeconds, 10) === OPENING_SUBS * TEN_MIN_SECONDS) {
    next.startSeconds = OPENING_SUBS * DEFAULT_SECONDS_PER_SUB;
  }
  next.lastAddedSeconds = Math.round((parseInt(next.lastAddedSeconds, 10) || 0) / 2);
}

function migrate(raw) {
  const next = { ...DEFAULT_STATE, ...raw };
  next.label = String(next.label || DEFAULT_STATE.label).trim().slice(0, 48) || DEFAULT_STATE.label;
  next.startSeconds = Math.max(60, parseInt(next.startSeconds, 10) || DEFAULT_START_SECONDS);
  // 10 min/sub was the last default — drop saved clocks to 5 and cut leftover time in half.
  if (!next.scaledToFiveMin && parseInt(next.secondsPerSub, 10) === TEN_MIN_SECONDS) {
    scaleRemainingInHalf(next);
    next.secondsPerSub = DEFAULT_SECONDS_PER_SUB;
    next.scaledToFiveMin = true;
  }
  next.secondsPerSub = Math.max(30, parseInt(next.secondsPerSub, 10) || DEFAULT_SECONDS_PER_SUB);
  next.maxSeconds = Math.max(0, parseInt(next.maxSeconds, 10) || 0);
  next.count = Math.max(0, parseInt(next.count, 10) || 0);
  next.pausedRemaining = clampRemaining(next.pausedRemaining, next.maxSeconds);
  next.lastAddedSeconds = Math.max(0, parseInt(next.lastAddedSeconds, 10) || 0);
  next.scaledToFiveMin = Boolean(next.scaledToFiveMin);
  if (!next.isRunning) next.endsAt = null;
  return next;
}

function load() {
  const raw = readRaw();
  const next = migrate(raw);
  if (next.scaledToFiveMin && raw.scaledToFiveMin !== true && parseInt(raw.secondsPerSub, 10) === TEN_MIN_SECONDS) {
    writeState(next);
  }
  return next;
}

function shouldOpenOnGiftStack(state) {
  const remaining = getRemainingSeconds(state);
  return state.count === 0 && remaining <= DEFAULT_START_SECONDS + 30;
}

function loadForOverlay() {
  let state = load();
  let dirty = false;
  if (shouldOpenOnGiftStack(state)) {
    state = seedFromSubs(OPENING_SUBS, state.lastSubBy || "opening gift", state);
    dirty = true;
  }
  if (state.isRunning && !state.endsAt && getRemainingSeconds({ ...state, isRunning: false }) > 0) {
    state.endsAt = Date.now() + state.pausedRemaining * 1000;
    dirty = true;
  }
  if (dirty) writeState(migrate(state));
  return loadForDisplay(state);
}

function getRemainingSeconds(state = load()) {
  if (state.isRunning && state.endsAt) {
    return clampRemaining((state.endsAt - Date.now()) / 1000, state.maxSeconds);
  }
  return clampRemaining(state.pausedRemaining, state.maxSeconds);
}

function formatClock(totalSeconds) {
  const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function loadForDisplay(state = load()) {
  const remainingSeconds = getRemainingSeconds(state);
  const cap = state.maxSeconds > 0 ? state.maxSeconds : Math.max(state.startSeconds, remainingSeconds);
  return {
    ...state,
    remainingSeconds,
    displayTime: formatClock(remainingSeconds),
    startDisplayTime: formatClock(state.startSeconds),
    maxDisplayTime: state.maxSeconds > 0 ? formatClock(state.maxSeconds) : "open",
    minutesPerSub: Math.round((state.secondsPerSub / 60) * 10) / 10,
    progressPct:
      cap > 0 ? Math.min(100, Math.max(0, Math.round((remainingSeconds / cap) * 100))) : 0,
    ended: remainingSeconds <= 0,
  };
}

function save(incoming) {
  const state = migrate({ ...load(), ...incoming });
  writeState(state);
  return loadForDisplay(state);
}

function bumpNonce(state) {
  state.nonce = (state.nonce || 0) + 1;
  return state;
}

function addSeconds(seconds, by, state = load()) {
  const add = Math.max(0, Math.round(Number(seconds) || 0));
  const next = migrate(state);
  const current = getRemainingSeconds(next);
  const gained = clampRemaining(current + add, next.maxSeconds) - current;

  next.lastAddedSeconds = gained;
  if (by) {
    next.lastSubAt = new Date().toISOString();
    next.lastSubBy = by;
  }
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = new Date().toISOString();
  }
  bumpNonce(next);

  if (next.isRunning && next.endsAt) {
    next.endsAt += gained * 1000;
  } else {
    next.pausedRemaining = clampRemaining(current + gained, next.maxSeconds);
  }
  return next;
}

function addSubs(count = 1, by = null, state = load()) {
  const add = Math.max(1, parseInt(count, 10) || 1);
  const next = migrate(state);
  next.count += add;
  return addSeconds(add * next.secondsPerSub, by || next.lastSubBy, next);
}

function addMinutes(minutes = 5, by = null, state = load()) {
  const mins = Math.max(1, parseInt(minutes, 10) || 1);
  return addSeconds(mins * 60, by, state);
}

function startTimer(state = load()) {
  const next = migrate(state);
  const remaining = getRemainingSeconds(next);
  next.isRunning = remaining > 0;
  next.endsAt = remaining > 0 ? Date.now() + remaining * 1000 : null;
  if (!next.sessionStartedAt) next.sessionStartedAt = new Date().toISOString();
  return bumpNonce(next);
}

function stopTimer(state = load()) {
  const next = migrate(state);
  next.pausedRemaining = getRemainingSeconds(next);
  next.isRunning = false;
  next.endsAt = null;
  return bumpNonce(next);
}

function setLabel(label, state = load()) {
  const next = migrate(state);
  const cleaned = String(label || "").trim().slice(0, 48);
  next.label = cleaned || DEFAULT_STATE.label;
  return bumpNonce(next);
}

function configure(body = {}, state = load()) {
  const next = migrate(state);
  if (body.startHours != null) {
    const hours = Number(body.startHours);
    if (Number.isFinite(hours) && hours > 0) {
      next.startSeconds = clampRemaining(hours * 3600, HARD_MAX_SECONDS);
    }
  }
  if (body.minutesPerSub != null) {
    const mins = Number(body.minutesPerSub);
    if (Number.isFinite(mins) && mins > 0) {
      next.secondsPerSub = Math.max(30, Math.round(mins * 60));
      next.scaledToFiveMin = true;
    }
  }
  if (body.maxHours != null) {
    const maxHours = Number(body.maxHours);
    next.maxSeconds =
      Number.isFinite(maxHours) && maxHours > 0
        ? clampRemaining(maxHours * 3600, HARD_MAX_SECONDS)
        : 0;
  }
  if (body.label) {
    next.label = String(body.label).trim().slice(0, 48) || next.label;
  }
  return bumpNonce(next);
}

function resetSession(state = load()) {
  const next = migrate(state);
  return {
    ...next,
    count: 0,
    pausedRemaining: next.startSeconds,
    isRunning: true,
    endsAt: Date.now() + next.startSeconds * 1000,
    sessionStartedAt: new Date().toISOString(),
    lastSubAt: null,
    lastSubBy: null,
    lastAddedSeconds: 0,
    nonce: (state.nonce || 0) + 1,
  };
}

/** Open the clock on a gifted stack (e.g. 300 subs × 5 min = 25:00:00). */
function seedFromSubs(count, by = null, state = load()) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  const next = migrate(state);
  const seconds = clampRemaining(n * next.secondsPerSub, next.maxSeconds);
  return {
    ...next,
    count: n,
    pausedRemaining: seconds,
    isRunning: seconds > 0,
    endsAt: seconds > 0 ? Date.now() + seconds * 1000 : null,
    sessionStartedAt: new Date().toISOString(),
    lastSubAt: n > 0 ? new Date().toISOString() : null,
    lastSubBy: by || (n > 0 ? next.lastSubBy : null),
    lastAddedSeconds: seconds,
    nonce: (state.nonce || 0) + 1,
  };
}

function formatMessage(state = load()) {
  const display = loadForDisplay(state);
  const run = display.ended
    ? "ended"
    : display.isRunning
      ? "counting down"
      : "paused";
  return `${display.label} ${display.displayTime} left · ${display.count} subs · +${display.minutesPerSub} min/sub · ${run}`;
}

function parseCommand(content) {
  const trimmed = String(content || "").trim();
  if (!/^[!/]subathon\b/i.test(trimmed)) return null;

  if (/^[!/]subathon$/i.test(trimmed)) return { action: "show" };
  if (/^[!/]subathon\s+reset$/i.test(trimmed)) return { action: "reset" };
  if (/^[!/]subathon\s+start$/i.test(trimmed)) return { action: "start" };
  if (/^[!/]subathon\s+stop$/i.test(trimmed)) return { action: "stop" };

  const seedMatch = trimmed.match(/^[!/]subathon\s+(?:start|seed)\s+(\d+)$/i);
  if (seedMatch) return { action: "seed", count: parseInt(seedMatch[1], 10) };

  const labelMatch = trimmed.match(/^[!/]subathon\s+label\s+(.+)$/i);
  if (labelMatch) return { action: "setLabel", label: labelMatch[1].trim() };

  const perSub = trimmed.match(/^[!/]subathon\s+persub\s+(\d+(?:\.\d+)?)$/i);
  if (perSub) return { action: "configure", minutesPerSub: Number(perSub[1]) };

  const plusMin = trimmed.match(/^[!/]subathon\s+\+(\d+)$/i);
  if (plusMin) return { action: "addMinutes", minutes: parseInt(plusMin[1], 10) };

  const numMatch = trimmed.match(/^[!/]subathon\s+(\d+)$/i);
  if (numMatch) return { action: "add", count: parseInt(numMatch[1], 10) };

  return null;
}

function applyAction(body = {}) {
  const { action, count, minutes, label, by } = body;
  let state = load();

  if (action === "add") {
    state = addSubs(count || 1, by, state);
  } else if (action === "addMinutes") {
    state = addMinutes(minutes || 5, by, state);
  } else if (action === "setLabel") {
    state = setLabel(label, state);
  } else if (action === "configure") {
    state = configure(body, state);
  } else if (action === "start") {
    state = startTimer(state);
  } else if (action === "stop") {
    state = stopTimer(state);
  } else if (action === "reset") {
    state = resetSession(state);
  } else if (action === "seed") {
    state = seedFromSubs(count, by, state);
  } else {
    return { error: "Unknown action" };
  }

  writeState(migrate(state));
  return { state: loadForDisplay() };
}

module.exports = {
  DEFAULT_STATE,
  load,
  loadForDisplay,
  loadForOverlay,
  save,
  addSubs,
  addMinutes,
  startTimer,
  stopTimer,
  setLabel,
  configure,
  resetSession,
  seedFromSubs,
  formatMessage,
  formatClock,
  getRemainingSeconds,
  parseCommand,
  applyAction,
};
