/**
 * Slots session timer — shared state (server API + localStorage fallback)
 */

const SLOTS_BASE_URL = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_TIMER = `${SLOTS_BASE_URL}/api/slots-timer`;
const API_TIMER_EVENTS = `${SLOTS_BASE_URL}/api/slots-timer/events`;
const LS_KEY = "slots_timer_state";

const SlotsTimerStore = {
  _cache: null,

  defaults() {
    return {
      dailyGoalMinutes: 60,
      minutesBank: 0,
      minutesRemaining: 0,
      isRunning: false,
      timerEndAt: null,
      _secondsLeft: 0,
      sessionStartedAt: null,
    };
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? { ...this.defaults(), ...JSON.parse(raw) } : this.defaults();
    } catch {
      return this.defaults();
    }
  },

  saveLocal(state) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // OBS may block storage in rare embed cases.
    }
    this._cache = state;
    window.dispatchEvent(new CustomEvent("slots-timer-update", { detail: state }));
    return state;
  },

  async fetchApi(url, options = {}, ms = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      return res;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  },

  async load() {
    try {
      const res = await this.fetchApi(API_TIMER);
      if (!res.ok) throw new Error("bad status");
      const state = { ...this.defaults(), ...await res.json() };
      this._cache = SlotsTimerActions.tick(state);
      return { ...this._cache };
    } catch {
      this._cache = SlotsTimerActions.tick(this.loadLocal());
      return { ...this._cache };
    }
  },

  async save(state) {
    state = SlotsTimerActions.tick({ ...state });
    try {
      const res = await this.fetchApi(API_TIMER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error("save failed");
      this._cache = { ...this.defaults(), ...await res.json() };
      window.dispatchEvent(new CustomEvent("slots-timer-update", { detail: this._cache }));
      return this._cache;
    } catch {
      return this.saveLocal(state);
    }
  },

  async postAction(actionBody) {
    try {
      const res = await this.fetchApi(API_TIMER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(actionBody),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "action failed");
      }
      const data = await res.json();
      this._cache = SlotsTimerActions.tick({ ...this.defaults(), ...data });
      window.dispatchEvent(new CustomEvent("slots-timer-update", { detail: this._cache }));
      return this._cache;
    } catch (error) {
      if (error.message && error.message !== "action failed") throw error;
    }

    let state = await this.load();
    if (actionBody.action === "addMinutes") {
      state = SlotsTimerActions.addMinutes(actionBody.count || actionBody.minutes || 1, state);
    } else if (actionBody.action === "setMinutes") {
      state = SlotsTimerActions.setMinutes(actionBody.minutes, state);
    } else if (actionBody.action === "setGoal") {
      state = SlotsTimerActions.setGoal(actionBody.goalMinutes ?? actionBody.minutes, state);
    } else if (actionBody.action === "setHour") {
      state = SlotsTimerActions.setHour(state);
    } else if (actionBody.action === "start") {
      state = SlotsTimerActions.startTimer(state);
      if (state._startFailed) throw new Error("No time banked");
    } else if (actionBody.action === "stop") {
      state = SlotsTimerActions.stopTimer(state);
    } else if (actionBody.action === "reset") {
      state = SlotsTimerActions.resetSession(state);
    }
    return this.save(state);
  },

  async parseUrl() {
    const params = new URLSearchParams(window.location.search);
    let state = await this.load();
    let changed = false;

    if (params.get("start") === "1") {
      state = SlotsTimerActions.startTimer(state);
      changed = true;
    }
    if (params.get("stop") === "1") {
      state = SlotsTimerActions.stopTimer(state);
      changed = true;
    }
    if (params.get("reset") === "1") {
      state = SlotsTimerActions.resetSession(state);
      changed = true;
    }
    if (params.get("hour") === "1") {
      state = SlotsTimerActions.setHour(state);
      changed = true;
    }
    if (params.has("minutes")) {
      state = SlotsTimerActions.setMinutes(parseInt(params.get("minutes"), 10) || 0, state);
      changed = true;
    }
    if (params.has("goal")) {
      state = SlotsTimerActions.setGoal(parseInt(params.get("goal"), 10) || 60, state);
      changed = true;
    }
    if (params.has("addmin")) {
      state = SlotsTimerActions.addMinutes(parseInt(params.get("addmin"), 10) || 1, state);
      changed = true;
    }

    if (changed) await this.save(state);
    return state;
  },
};

const SlotsTimerActions = {
  getSeconds(state) {
    if (state.isRunning && state.timerEndAt) {
      return Math.max(0, Math.ceil((state.timerEndAt - Date.now()) / 1000));
    }
    return state._secondsLeft || state.minutesBank * 60;
  },

  tick(state) {
    if (state.isRunning && state.timerEndAt) {
      const remaining = Math.max(0, Math.ceil((state.timerEndAt - Date.now()) / 1000));
      state._secondsLeft = remaining;
      state.minutesBank = Math.ceil(remaining / 60);
      state.minutesRemaining = state.minutesBank;
      if (remaining <= 0) {
        state.isRunning = false;
        state.timerEndAt = null;
        state._secondsLeft = 0;
        state.minutesBank = 0;
        state.minutesRemaining = 0;
      }
    }
    return state;
  },

  addMinutes(mins = 1, state) {
    const addSeconds = mins * 60;
    state.minutesBank += mins;
    if (state.isRunning && state.timerEndAt) {
      state.timerEndAt += addSeconds * 1000;
      state._secondsLeft = this.getSeconds(state);
    } else {
      state._secondsLeft = state.minutesBank * 60;
    }
    state.minutesRemaining = Math.ceil((state._secondsLeft || 0) / 60);
    return state;
  },

  setMinutes(mins, state) {
    const safeMins = Math.max(0, parseInt(mins, 10) || 0);
    const seconds = safeMins * 60;
    state.minutesBank = safeMins;
    state.minutesRemaining = safeMins;
    state._secondsLeft = seconds;
    if (state.isRunning) {
      state.timerEndAt = Date.now() + seconds * 1000;
      if (seconds <= 0) {
        state.isRunning = false;
        state.timerEndAt = null;
      }
    }
    return state;
  },

  setGoal(minutes, state) {
    state.dailyGoalMinutes = Math.max(1, parseInt(minutes, 10) || 60);
    return state;
  },

  setHour(state) {
    return this.setMinutes(state.dailyGoalMinutes || 60, state);
  },

  startTimer(state) {
    const seconds = this.getSeconds(state);
    if (seconds <= 0) {
      state._startFailed = true;
      return state;
    }
    state.isRunning = true;
    state.timerEndAt = Date.now() + seconds * 1000;
    state._secondsLeft = seconds;
    state._startFailed = false;
    if (!state.sessionStartedAt) {
      state.sessionStartedAt = new Date().toISOString();
    }
    return state;
  },

  stopTimer(state) {
    if (state.isRunning && state.timerEndAt) {
      const remaining = Math.max(0, Math.ceil((state.timerEndAt - Date.now()) / 1000));
      state._secondsLeft = remaining;
      state.minutesBank = Math.ceil(remaining / 60);
      state.minutesRemaining = state.minutesBank;
    }
    state.isRunning = false;
    state.timerEndAt = null;
    return state;
  },

  resetSession(state) {
    return {
      ...state,
      minutesBank: 0,
      minutesRemaining: 0,
      isRunning: false,
      timerEndAt: null,
      _secondsLeft: 0,
      sessionStartedAt: null,
    };
  },

  getProgress(state, seconds = this.getSeconds(state)) {
    const goalSeconds = Math.max(1, (state.dailyGoalMinutes || 60) * 60);
    const done = Math.max(0, goalSeconds - seconds);
    return Math.min(100, Math.round((done / goalSeconds) * 100));
  },
};

function formatSlotsTime(totalSeconds) {
  const safe = Math.max(0, totalSeconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function slotsTimerStatusHtml(state, seconds) {
  if (state.isRunning) {
    return '<span class="status-dot"></span> Slots Running';
  }
  if (seconds > 0) {
    return `<span class="status-dot"></span> Paused — ${formatSlotsTime(seconds)}`;
  }
  return '<span class="status-dot"></span> Ready To Spin';
}

let syncPollInterval = null;
let lastStateJson = "";

function applyTimerState(state, container) {
  const ticked = SlotsTimerActions.tick({ ...state });
  SlotsTimerStore._cache = ticked;
  lastStateJson = JSON.stringify(ticked);
  renderSlotsTimer(container, ticked);
  return ticked;
}

function connectSlotsTimerEvents(onUpdate) {
  const source = new EventSource(API_TIMER_EVENTS);

  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.event !== "timer" || !payload.state) return;
      onUpdate(SlotsTimerActions.tick({ ...SlotsTimerStore.defaults(), ...payload.state }));
    } catch {
      // Ignore malformed events.
    }
  };

  source.onerror = () => {
    source.close();
    setTimeout(() => connectSlotsTimerEvents(onUpdate), 2000);
  };

  return source;
}

function startSlotsTimerPoll(onUpdate, ms = 300) {
  if (syncPollInterval) return;
  syncPollInterval = setInterval(async () => {
    const state = await SlotsTimerStore.load();
    const json = JSON.stringify(state);
    if (json !== lastStateJson || state.isRunning) {
      lastStateJson = json;
      onUpdate(state);
    }
  }, ms);
}

function renderSlotsTimer(container, state) {
  if (!container) return;
  state = SlotsTimerActions.tick({ ...state });

  const timeEl = container.querySelector(".slots-timer-time");
  const statusEl = container.querySelector(".slots-timer-status");
  const progressEl = container.querySelector(".slots-progress-fill");
  const progressLabel = container.querySelector("[data-progress]");

  const seconds = SlotsTimerActions.getSeconds(state);
  const progress = SlotsTimerActions.getProgress(state, seconds);

  if (timeEl) {
    timeEl.textContent = formatSlotsTime(seconds);
    timeEl.classList.toggle("running", state.isRunning);
    timeEl.classList.toggle("long", seconds >= 3600);
  }
  if (statusEl) {
    statusEl.className = `slots-timer-status treadmill-status ${
      state.isRunning ? "active" : seconds > 0 ? "paused" : "idle"
    }`;
    statusEl.innerHTML = slotsTimerStatusHtml(state, seconds);
  }
  if (progressEl) progressEl.style.width = `${progress}%`;
  if (progressLabel) progressLabel.textContent = `${progress}%`;
}

function initSlotsTimerPage(options = {}) {
  const obsMode =
    new URLSearchParams(window.location.search).get("obs") === "1" ||
    new URLSearchParams(window.location.search).get("obs") === "true";

  renderSlotsTimer(options.timer, {
    ...SlotsTimerStore.defaults(),
    _secondsLeft: 0,
    isRunning: false,
  });
  const timeEl = options.timer?.querySelector(".slots-timer-time");
  if (timeEl && obsMode) timeEl.textContent = "...";

  connectSlotsTimerEvents((state) => {
    applyTimerState(state, options.timer);
  });

  SlotsTimerStore.load().then((state) => {
    applyTimerState(state, options.timer);
  });

  SlotsTimerStore.parseUrl().then((state) => {
    applyTimerState(state, options.timer);
  });

  window.addEventListener("slots-timer-update", (event) => {
    applyTimerState(event.detail, options.timer);
  });

  startSlotsTimerPoll(async (state) => {
    const ticked = applyTimerState(state, options.timer);
    if (state.isRunning && !ticked.isRunning) {
      await SlotsTimerStore.save(ticked);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      SlotsTimerStore.load().then((state) => applyTimerState(state, options.timer));
    }
  });

  return SlotsTimerStore.loadLocal();
}
