const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "data", "slots-timer-state.json");

const DEFAULT_STATE = {
  dailyGoalMinutes: 60,
  minutesBank: 0,
  minutesRemaining: 0,
  isRunning: false,
  timerEndAt: null,
  _secondsLeft: 0,
  sessionStartedAt: null,
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

function getSeconds(state) {
  if (state.isRunning && state.timerEndAt) {
    return Math.max(0, Math.ceil((state.timerEndAt - Date.now()) / 1000));
  }
  return state._secondsLeft || state.minutesBank * 60;
}

function tick(state) {
  const next = { ...state };

  if (next.isRunning && next.timerEndAt) {
    const remaining = Math.max(0, Math.ceil((next.timerEndAt - Date.now()) / 1000));
    next._secondsLeft = remaining;
    next.minutesBank = Math.ceil(remaining / 60);
    next.minutesRemaining = next.minutesBank;

    if (remaining <= 0) {
      next.isRunning = false;
      next.timerEndAt = null;
      next._secondsLeft = 0;
      next.minutesBank = 0;
      next.minutesRemaining = 0;
    }
  }

  return next;
}

function load() {
  return tick(readState());
}

function save(incoming) {
  const state = tick({ ...readState(), ...incoming });
  writeState(state);
  return state;
}

function addMinutes(mins = 1, state = load()) {
  const next = { ...state };
  const addSeconds = mins * 60;
  next.minutesBank += mins;

  if (next.isRunning && next.timerEndAt) {
    next.timerEndAt += addSeconds * 1000;
    next._secondsLeft = getSeconds(next);
  } else {
    next._secondsLeft = next.minutesBank * 60;
  }

  next.minutesRemaining = Math.ceil((next._secondsLeft || 0) / 60);
  return next;
}

function setMinutes(mins, state = load()) {
  const safeMins = Math.max(0, parseInt(mins, 10) || 0);
  const seconds = safeMins * 60;
  const next = { ...state };

  next.minutesBank = safeMins;
  next.minutesRemaining = safeMins;
  next._secondsLeft = seconds;

  if (next.isRunning) {
    next.timerEndAt = Date.now() + seconds * 1000;
    if (seconds <= 0) {
      next.isRunning = false;
      next.timerEndAt = null;
    }
  }

  return next;
}

function setGoal(minutes, state = load()) {
  const next = { ...state };
  next.dailyGoalMinutes = Math.max(1, parseInt(minutes, 10) || 60);
  return next;
}

function setHour(state = load()) {
  return setMinutes(state.dailyGoalMinutes || 60, state);
}

function startTimer(state = load()) {
  const next = { ...state };
  const seconds = getSeconds(next);

  if (seconds <= 0) {
    return { state: next, error: "No time banked — set your slots time first." };
  }

  next.isRunning = true;
  next.timerEndAt = Date.now() + seconds * 1000;
  next._secondsLeft = seconds;
  if (!next.sessionStartedAt) {
    next.sessionStartedAt = new Date().toISOString();
  }

  return { state: next };
}

function stopTimer(state = load()) {
  const next = { ...state };

  if (next.isRunning && next.timerEndAt) {
    const remaining = Math.max(0, Math.ceil((next.timerEndAt - Date.now()) / 1000));
    next._secondsLeft = remaining;
    next.minutesBank = Math.ceil(remaining / 60);
    next.minutesRemaining = next.minutesBank;
  }

  next.isRunning = false;
  next.timerEndAt = null;
  return next;
}

function resetSession(state = load()) {
  return {
    ...state,
    minutesBank: 0,
    minutesRemaining: 0,
    isRunning: false,
    timerEndAt: null,
    _secondsLeft: 0,
    sessionStartedAt: null,
  };
}

function startHourSession(state = load()) {
  const next = setHour(state);
  return startTimer(next);
}

function parseSlotStartCommand(content) {
  if (/^[!/]slotstart$/i.test(content.trim())) {
    return { action: "startHour" };
  }
  return null;
}

function formatTimerMessage(state) {
  const seconds = getSeconds(state);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function applyAction(body = {}) {
  const { action, minutes, goalMinutes, count, ...fields } = body;
  let state = load();

  if (action === "addMinutes") state = addMinutes(count || minutes || 1, state);
  else if (action === "setMinutes") state = setMinutes(minutes, state);
  else if (action === "setGoal") state = setGoal(goalMinutes ?? minutes, state);
  else if (action === "setHour") state = setHour(state);
  else if (action === "slotstart" || action === "startHour") {
    const result = startHourSession(state);
    if (result.error) return result;
    state = result.state;
  } else if (action === "start") {
    const result = startTimer(state);
    if (result.error) return result;
    state = result.state;
  } else if (action === "stop") state = stopTimer(state);
  else if (action === "reset") state = resetSession(state);
  else if (Object.keys(fields).length) state = { ...state, ...fields };

  state = save(state);
  return { state };
}

module.exports = {
  DEFAULT_STATE,
  load,
  save,
  getSeconds,
  addMinutes,
  setMinutes,
  setGoal,
  setHour,
  startHourSession,
  parseSlotStartCommand,
  formatTimerMessage,
  startTimer,
  stopTimer,
  resetSession,
  applyAction,
};
