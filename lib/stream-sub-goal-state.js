const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "data", "stream-sub-goal-state.json");

/** Start bank: 4 hours. Max bank: 12 hours. 50 subs fill the 8-hour gap. */
const BASE_SECONDS = 4 * 60 * 60;
const MAX_SECONDS = 12 * 60 * 60;
const GOAL_SUBS = 50;
const SECONDS_PER_SUB = ((MAX_SECONDS - BASE_SECONDS) / GOAL_SUBS); // 9.6 min = 576s

const DEFAULT_STATE = {
  count: 0,
  goal: GOAL_SUBS,
  label: "12 Hour Stream",
  baseSeconds: BASE_SECONDS,
  maxSeconds: MAX_SECONDS,
  secondsPerSub: SECONDS_PER_SUB,
  bankSeconds: BASE_SECONDS,
  isRunning: false,
  endsAt: null,
  sessionStartedAt: null,
  lastSubAt: null,
  lastSubBy: null,
  nonce: 0,
};

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { ...DEFAULT_STATE };
  }

  try {
    return normalize({ ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) });
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

function bankFromCount(count) {
  const safe = Math.max(0, parseInt(count, 10) || 0);
  return Math.min(MAX_SECONDS, BASE_SECONDS + safe * SECONDS_PER_SUB);
}

function normalize(state) {
  const next = { ...DEFAULT_STATE, ...state };
  next.goal = GOAL_SUBS;
  next.baseSeconds = BASE_SECONDS;
  next.maxSeconds = MAX_SECONDS;
  next.secondsPerSub = SECONDS_PER_SUB;
  next.count = Math.max(0, parseInt(next.count, 10) || 0);
  next.bankSeconds = bankFromCount(next.count);
  next.label = String(next.label || DEFAULT_STATE.label).slice(0, 48);
  if (!next.isRunning) {
    next.endsAt = null;
  }
  return next;
}

function getRemainingSeconds(state = load()) {
  if (state.isRunning && state.endsAt) {
    return Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
  }
  return Math.max(0, Math.round(state.bankSeconds || BASE_SECONDS));
}

function formatClock(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function load() {
  return readState();
}

function loadForDisplay(state = load()) {
  const normalized = normalize(state);
  const remainingSeconds = getRemainingSeconds(normalized);
  const progress =
    (normalized.bankSeconds - BASE_SECONDS) / (MAX_SECONDS - BASE_SECONDS);
  return {
    ...normalized,
    remainingSeconds,
    displayTime: formatClock(remainingSeconds),
    maxDisplayTime: formatClock(MAX_SECONDS),
    baseDisplayTime: formatClock(BASE_SECONDS),
    minutesPerSub: SECONDS_PER_SUB / 60,
    progressPct: Math.min(100, Math.max(0, Math.round(progress * 100))),
    atMax: normalized.bankSeconds >= MAX_SECONDS,
  };
}

function save(incoming) {
  const state = normalize({ ...readState(), ...incoming });
  writeState(state);
  return loadForDisplay(state);
}

function addSubs(count = 1, by = null, state = load()) {
  const add = Math.max(1, parseInt(count, 10) || 1);
  const next = normalize(state);
  const prevBank = next.bankSeconds;
  next.count += add;
  next.bankSeconds = bankFromCount(next.count);
  const gained = next.bankSeconds - prevBank;
  next.nonce = (next.nonce || 0) + 1;
  next.lastSubAt = new Date().toISOString();
  next.lastSubBy = by || next.lastSubBy;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = next.lastSubAt;
  }
  if (next.isRunning && next.endsAt) {
    if (gained > 0) next.endsAt += gained * 1000;
  } else {
    next.isRunning = true;
    next.endsAt = Date.now() + next.bankSeconds * 1000;
  }
  return next;
}

function removeSubs(count = 1, state = load()) {
  const remove = Math.max(1, parseInt(count, 10) || 1);
  const next = normalize(state);
  const prevBank = next.bankSeconds;
  next.count = Math.max(0, next.count - remove);
  next.bankSeconds = bankFromCount(next.count);
  const lost = prevBank - next.bankSeconds;
  next.nonce = (next.nonce || 0) + 1;
  if (next.isRunning && next.endsAt && lost > 0) {
    next.endsAt = Math.max(Date.now(), next.endsAt - lost * 1000);
  }
  return next;
}

function startTimer(state = load()) {
  const next = normalize(state);
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
  const next = normalize(state);
  if (next.isRunning) {
    next.bankSeconds = getRemainingSeconds(next);
    // Keep count; bank may have run down below formula — clamp display bank to remaining
    // but don't rewrite count. Store explicit bank override via remaining.
    next.bankSeconds = Math.min(MAX_SECONDS, Math.max(0, next.bankSeconds));
  }
  next.isRunning = false;
  next.endsAt = null;
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function setLabel(label, state = load()) {
  const next = normalize(state);
  const cleaned = String(label || "").trim().slice(0, 48);
  next.label = cleaned || DEFAULT_STATE.label;
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function resetSession(state = load()) {
  const next = {
    ...normalize(state),
    count: 0,
    bankSeconds: BASE_SECONDS,
    isRunning: true,
    endsAt: Date.now() + BASE_SECONDS * 1000,
    sessionStartedAt: new Date().toISOString(),
    lastSubAt: null,
    lastSubBy: null,
    nonce: (state.nonce || 0) + 1,
  };
  return next;
}

function formatMessage(state = load()) {
  const display = loadForDisplay(state);
  const per = display.minutesPerSub;
  return `${display.displayTime} / ${display.maxDisplayTime} · ${display.count}/${display.goal} subs (+${per} min each) · ${display.label}`;
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

  writeState(normalize(state));
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
