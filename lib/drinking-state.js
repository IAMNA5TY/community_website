const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "data", "drinking-state.json");

const DEFAULT_STATE = {
  sessionCount: 0,
  lifetimeCount: 0,
  sessionGoal: 12,
  lastShotgunAt: null,
  lastShotgunBy: null,
  shotgunNonce: 0,
  sessionStartedAt: null,
  cheersSessionCount: 0,
  cheersLifetimeCount: 0,
  lastCheersAt: null,
  lastCheersBy: null,
  cheersNonce: 0,
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

function addBeer(count = 1, by = null, state = load()) {
  const add = Math.max(1, parseInt(count, 10) || 1);
  const next = { ...state };

  next.sessionCount += add;
  next.lifetimeCount += add;
  next.shotgunNonce = (next.shotgunNonce || 0) + 1;
  next.lastShotgunAt = new Date().toISOString();
  next.lastShotgunBy = by || next.lastShotgunBy;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = next.lastShotgunAt;
  }

  return next;
}

function removeBeer(count = 1, state = load()) {
  const remove = Math.max(1, parseInt(count, 10) || 1);
  const next = { ...state };
  next.sessionCount = Math.max(0, next.sessionCount - remove);
  next.lifetimeCount = Math.max(0, next.lifetimeCount - remove);
  return next;
}

function setGoal(goal, state = load()) {
  const next = { ...state };
  next.sessionGoal = Math.max(1, parseInt(goal, 10) || 12);
  return next;
}

function addCheers(by = null, state = load()) {
  const next = { ...state };
  next.cheersSessionCount = (next.cheersSessionCount || 0) + 1;
  next.cheersLifetimeCount = (next.cheersLifetimeCount || 0) + 1;
  next.cheersNonce = (next.cheersNonce || 0) + 1;
  next.lastCheersAt = new Date().toISOString();
  next.lastCheersBy = by || next.lastCheersBy;
  return next;
}

function resetSession(state = load()) {
  return {
    ...state,
    sessionCount: 0,
    sessionGoal: state.sessionGoal || 12,
    lastShotgunAt: null,
    lastShotgunBy: null,
    sessionStartedAt: null,
    cheersSessionCount: 0,
    lastCheersAt: null,
    lastCheersBy: null,
  };
}

function formatBeerMessage(state) {
  const goal = state.sessionGoal || 12;
  const remaining = Math.max(0, goal - state.sessionCount);
  const cheers = state.cheersSessionCount || 0;
  let beer = "";
  if (remaining <= 0) {
    beer = `${state.sessionCount} beers shotgun'd`;
  } else {
    beer = `${state.sessionCount} shotgun'd — ${remaining} to goal (${goal})`;
  }
  return `${beer} · ${cheers} chat cheers`;
}

function formatCheersMessage(state) {
  const count = state.cheersSessionCount || 0;
  return `${count} cheer${count === 1 ? "" : "s"} this stream — type cheers or !cheers to join in`;
}

function parseCheersCommand(content) {
  if (/^[!/]?cheers$/i.test(content.trim())) {
    return { action: "cheer" };
  }
  return null;
}

function parseShotgunCommand(content) {
  const trimmed = content.trim();
  if (/^[!/]shotgun$/i.test(trimmed)) {
    return { action: "add", count: 1 };
  }
  const numMatch = trimmed.match(/^[!/]shotgun\s+([+-]?\d+)$/i);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n < 0) return { action: "remove", count: Math.abs(n) };
    if (n > 0) return { action: "add", count: n };
  }
  if (/^[!/]beers$/i.test(trimmed)) {
    return { action: "show" };
  }
  if (/^[!/]beers?\s+reset$/i.test(trimmed)) {
    return { action: "reset" };
  }
  return null;
}

function applyAction(body = {}) {
  const { action, count, goal, by } = body;
  let state = load();

  if (action === "add") {
    state = addBeer(count || 1, by, state);
  } else if (action === "cheer") {
    state = addCheers(by, state);
  } else if (action === "remove") {
    state = removeBeer(count || 1, state);
  } else if (action === "setGoal") {
    state = setGoal(goal, state);
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
  addBeer,
  addCheers,
  removeBeer,
  setGoal,
  resetSession,
  formatBeerMessage,
  formatCheersMessage,
  parseShotgunCommand,
  parseCheersCommand,
  applyAction,
};
