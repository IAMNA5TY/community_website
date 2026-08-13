const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "data", "stream-sub-goal-state.json");

/** Start: 4h on the clock. Each sub +9.6 min. Remaining never above 12h. */
const BASE_SECONDS = 4 * 60 * 60;
const MAX_SECONDS = 12 * 60 * 60;
const GOAL_SUBS = 50;
const SECONDS_PER_SUB = (MAX_SECONDS - BASE_SECONDS) / GOAL_SUBS; // 576

const DEFAULT_STATE = {
  count: 0,
  goal: GOAL_SUBS,
  label: "12 Hour Stream",
  baseSeconds: BASE_SECONDS,
  maxSeconds: MAX_SECONDS,
  secondsPerSub: SECONDS_PER_SUB,
  /** Remaining seconds when paused (ignored while running — use endsAt). */
  pausedRemaining: BASE_SECONDS,
  isRunning: false,
  endsAt: null,
  sessionStartedAt: null,
  lastSubAt: null,
  lastSubBy: null,
  nonce: 0,
};

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
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function clampRemaining(seconds) {
  return Math.min(MAX_SECONDS, Math.max(0, Math.round(seconds || 0)));
}

function migrate(raw) {
  const next = { ...DEFAULT_STATE, ...raw };
  next.goal = GOAL_SUBS;
  next.baseSeconds = BASE_SECONDS;
  next.maxSeconds = MAX_SECONDS;
  next.secondsPerSub = SECONDS_PER_SUB;
  next.count = Math.max(0, parseInt(next.count, 10) || 0);
  next.label = String(next.label || DEFAULT_STATE.label).slice(0, 48);

  // Older builds stored bankSeconds from sub count — convert once.
  if (next.pausedRemaining == null && next.bankSeconds != null) {
    next.pausedRemaining = clampRemaining(next.bankSeconds);
  }
  if (next.pausedRemaining == null) {
    next.pausedRemaining = BASE_SECONDS;
  }
  next.pausedRemaining = clampRemaining(next.pausedRemaining);

  if (!next.isRunning) {
    next.endsAt = null;
  }

  return next;
}

function load() {
  return migrate(readRaw());
}

function getRemainingSeconds(state = load()) {
  if (state.isRunning && state.endsAt) {
    return clampRemaining((state.endsAt - Date.now()) / 1000);
  }
  return clampRemaining(state.pausedRemaining);
}

function formatClock(totalSeconds) {
  const secs = clampRemaining(totalSeconds);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function loadForDisplay(state = load()) {
  const remainingSeconds = getRemainingSeconds(state);
  const progress = (remainingSeconds - 0) / MAX_SECONDS;
  return {
    ...state,
    bankSeconds: remainingSeconds,
    remainingSeconds,
    displayTime: formatClock(remainingSeconds),
    maxDisplayTime: formatClock(MAX_SECONDS),
    baseDisplayTime: formatClock(BASE_SECONDS),
    minutesPerSub: SECONDS_PER_SUB / 60,
    progressPct: Math.min(100, Math.max(0, Math.round(progress * 100))),
    atMax: remainingSeconds >= MAX_SECONDS,
  };
}

function save(incoming) {
  const state = migrate({ ...load(), ...incoming });
  writeState(state);
  return loadForDisplay(state);
}

function addSubs(count = 1, by = null, state = load()) {
  const add = Math.max(1, parseInt(count, 10) || 1);
  const next = migrate(state);
  const current = getRemainingSeconds(next);
  const room = Math.max(0, MAX_SECONDS - current);
  const gained = Math.min(add * SECONDS_PER_SUB, room);

  next.count += add;
  next.nonce = (next.nonce || 0) + 1;
  next.lastSubAt = new Date().toISOString();
  next.lastSubBy = by || next.lastSubBy;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = next.lastSubAt;
  }

  if (next.isRunning && next.endsAt) {
    // Extend the live countdown (never past max).
    next.endsAt += gained * 1000;
  } else {
    next.pausedRemaining = clampRemaining(current + gained);
    // Gifts while paused kick off the countdown so you don't stay stuck on PAUSED.
    if (next.pausedRemaining > 0) {
      next.isRunning = true;
      next.endsAt = Date.now() + next.pausedRemaining * 1000;
    }
  }

  return next;
}

function removeSubs(count = 1, state = load()) {
  const remove = Math.max(1, parseInt(count, 10) || 1);
  const next = migrate(state);
  const loss = remove * SECONDS_PER_SUB;
  const current = getRemainingSeconds(next);

  next.count = Math.max(0, next.count - remove);
  next.nonce = (next.nonce || 0) + 1;

  if (next.isRunning && next.endsAt) {
    next.endsAt = Math.max(Date.now(), next.endsAt - loss * 1000);
  } else {
    next.pausedRemaining = clampRemaining(current - loss);
  }

  return next;
}

function startTimer(state = load()) {
  const next = migrate(state);
  const remaining = getRemainingSeconds(next);
  next.isRunning = true;
  next.endsAt = Date.now() + remaining * 1000;
  next.nonce = (next.nonce || 0) + 1;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = new Date().toISOString();
  }
  return next;
}

function stopTimer(state = load()) {
  const next = migrate(state);
  next.pausedRemaining = getRemainingSeconds(next);
  next.isRunning = false;
  next.endsAt = null;
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function setLabel(label, state = load()) {
  const next = migrate(state);
  const cleaned = String(label || "").trim().slice(0, 48);
  next.label = cleaned || DEFAULT_STATE.label;
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

/** New stream: 4:00:00 on the clock and countdown starts immediately. */
function resetSession(state = load()) {
  return {
    ...migrate(state),
    count: 0,
    pausedRemaining: BASE_SECONDS,
    isRunning: true,
    endsAt: Date.now() + BASE_SECONDS * 1000,
    sessionStartedAt: new Date().toISOString(),
    lastSubAt: null,
    lastSubBy: null,
    nonce: (state.nonce || 0) + 1,
  };
}

function formatMessage(state = load()) {
  const display = loadForDisplay(state);
  const run = display.isRunning ? "counting down" : "paused — start with !subgoal start";
  return `${display.displayTime} left / ${display.maxDisplayTime} max · ${display.count} subs (+${display.minutesPerSub} min) · ${run}`;
}

function parseCommand(content) {
  const trimmed = String(content || "").trim();
  if (/^[!/]subs?$/i.test(trimmed) || /^[!/]subgoal$/i.test(trimmed)) {
    return { action: "show" };
  }
  if (/^[!/]subs?\s+reset$/i.test(trimmed) || /^[!/]subgoal\s+reset$/i.test(trimmed)) {
    return { action: "reset" };
  }
  if (/^[!/](?:subs?|subgoal)\s+start$/i.test(trimmed)) {
    return { action: "start" };
  }
  if (/^[!/](?:subs?|subgoal)\s+stop$/i.test(trimmed)) {
    return { action: "stop" };
  }
  const labelMatch = trimmed.match(/^[!/](?:subs?|subgoal)\s+label\s+(.+)$/i);
  if (labelMatch) {
    return { action: "setLabel", label: labelMatch[1].trim() };
  }
  const numMatch = trimmed.match(/^[!/](?:subs?|subgoal)\s+([+-]?\d+)$/i);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n < 0) return { action: "remove", count: Math.abs(n) };
    if (n > 0) return { action: "add", count: n };
  }
  return null;
}

function applyAction(body = {}) {
  const { action, count, label, by } = body;
  let state = load();

  if (action === "add") {
    state = addSubs(count || 1, by, state);
  } else if (action === "remove") {
    state = removeSubs(count || 1, state);
  } else if (action === "setLabel") {
    state = setLabel(label, state);
  } else if (action === "start") {
    state = startTimer(state);
  } else if (action === "stop") {
    state = stopTimer(state);
  } else if (action === "reset") {
    state = resetSession(state);
  } else {
    return { error: "Unknown action" };
  }

  writeState(migrate(state));
  return { state: loadForDisplay() };
}

module.exports = {
  DEFAULT_STATE,
  BASE_SECONDS,
  MAX_SECONDS,
  GOAL_SUBS,
  SECONDS_PER_SUB,
  load,
  loadForDisplay,
  save,
  addSubs,
  removeSubs,
  startTimer,
  stopTimer,
  setLabel,
  resetSession,
  formatMessage,
  formatClock,
  getRemainingSeconds,
  parseCommand,
  applyAction,
};
