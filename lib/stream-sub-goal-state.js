const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "data", "stream-sub-goal-state.json");

const DEFAULT_STATE = {
  count: 0,
  goal: 50,
  label: "12 Hour Stream",
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

function load() {
  return readState();
}

function save(incoming) {
  const state = { ...readState(), ...incoming };
  writeState(state);
  return state;
}

function addSubs(count = 1, by = null, state = load()) {
  const add = Math.max(1, parseInt(count, 10) || 1);
  const next = { ...state };
  next.count = Math.max(0, (next.count || 0) + add);
  next.nonce = (next.nonce || 0) + 1;
  next.lastSubAt = new Date().toISOString();
  next.lastSubBy = by || next.lastSubBy;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = next.lastSubAt;
  }
  return next;
}

function removeSubs(count = 1, state = load()) {
  const remove = Math.max(1, parseInt(count, 10) || 1);
  const next = { ...state };
  next.count = Math.max(0, (next.count || 0) - remove);
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function setGoal(goal, state = load()) {
  const next = { ...state };
  next.goal = Math.max(1, parseInt(goal, 10) || 50);
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function setLabel(label, state = load()) {
  const next = { ...state };
  const cleaned = String(label || "").trim().slice(0, 48);
  next.label = cleaned || DEFAULT_STATE.label;
  next.nonce = (next.nonce || 0) + 1;
  return next;
}

function resetSession(state = load()) {
  return {
    ...state,
    count: 0,
    goal: state.goal || DEFAULT_STATE.goal,
    label: state.label || DEFAULT_STATE.label,
    sessionStartedAt: null,
    lastSubAt: null,
    lastSubBy: null,
    nonce: (state.nonce || 0) + 1,
  };
}

function formatMessage(state = load()) {
  const goal = state.goal || 50;
  const count = state.count || 0;
  const label = state.label || DEFAULT_STATE.label;
  const remaining = Math.max(0, goal - count);
  if (remaining <= 0) {
    return `Sub goal hit — ${count}/${goal} (${label})`;
  }
  return `Subs ${count}/${goal} — ${remaining} to go (${label})`;
}

function parseCommand(content) {
  const trimmed = String(content || "").trim();
  if (/^[!/]subs?$/i.test(trimmed) || /^[!/]subgoal$/i.test(trimmed)) {
    return { action: "show" };
  }
  if (/^[!/]subs?\s+reset$/i.test(trimmed) || /^[!/]subgoal\s+reset$/i.test(trimmed)) {
    return { action: "reset" };
  }
  const goalMatch = trimmed.match(/^[!/](?:subs?|subgoal)\s+goal\s+(\d+)$/i);
  if (goalMatch) {
    return { action: "setGoal", goal: parseInt(goalMatch[1], 10) };
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
  const { action, count, goal, label, by } = body;
  let state = load();

  if (action === "add") {
    state = addSubs(count || 1, by, state);
  } else if (action === "remove") {
    state = removeSubs(count || 1, state);
  } else if (action === "setGoal") {
    state = setGoal(goal, state);
  } else if (action === "setLabel") {
    state = setLabel(label, state);
  } else if (action === "reset") {
    state = resetSession(state);
  } else {
    return { error: "Unknown action" };
  }

  state = save(state);
  return { state };
}

module.exports = {
  DEFAULT_STATE,
  load,
  save,
  addSubs,
  removeSubs,
  setGoal,
  setLabel,
  resetSession,
  formatMessage,
  parseCommand,
  applyAction,
};
