/**
 * Workout OBS — shared state (server API + localStorage fallback)
 * Served from the site at /workout/... — API syncs via /api/state on the same host
 */

const WORKOUT_BASE_URL = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_STATE = `${WORKOUT_BASE_URL}/api/state`;
const API_WORKOUT_EVENTS = `${WORKOUT_BASE_URL}/api/workout/events`;
const LS_KEY = "workout_obs_state";

const WorkoutStore = {
  _cache: null,
  _useApi: true,

  defaults() {
    return {
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
      walkName: "Nasty",
      messageCount: 0,
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
    } catch { /* OBS may block in rare cases */ }
    this._cache = state;
    window.dispatchEvent(new CustomEvent("workout-update", { detail: state }));
    return state;
  },

  async fetchApi(url, options = {}, ms = 1500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },

  async load() {
    try {
      const res = await this.fetchApi(API_STATE);
      if (!res.ok) throw new Error("bad status");
      const state = { ...this.defaults(), ...await res.json() };
      this._cache = WorkoutStoreActions.tick(state);
      this._useApi = true;
      return { ...this._cache };
    } catch {
      if (this._cache) {
        return { ...WorkoutStoreActions.tick({ ...this._cache }) };
      }
      this._cache = WorkoutStoreActions.tick(this.loadLocal());
      return { ...this._cache };
    }
  },

  async save(state) {
    state = WorkoutStoreActions.tick({ ...state });
    try {
      const res = await this.fetchApi(API_STATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      if (!res.ok) throw new Error("save failed");
      this._cache = { ...this.defaults(), ...await res.json() };
      this._useApi = true;
      window.dispatchEvent(new CustomEvent("workout-update", { detail: this._cache }));
      return this._cache;
    } catch {
      return this.saveLocal(state);
    }
  },

  async parseUrl() {
    const p = new URLSearchParams(window.location.search);
    let state = await this.load();
    let changed = false;

    if (p.has("sub")) {
      state = WorkoutActions.addSub(parseInt(p.get("sub"), 10) || 1, state);
      changed = true;
    }
    if (p.get("start") === "1") { state = WorkoutActions.startTreadmill(state); changed = true; }
    if (p.get("stop") === "1")  { state = WorkoutActions.stopTreadmill(state); changed = true; }
    if (p.get("reset") === "1") { state = WorkoutActions.resetSession(state); changed = true; }
    if (p.get("addmin")) {
      state = WorkoutActions.addMinutes(parseInt(p.get("addmin"), 10) || 1, state);
      changed = true;
    }

    ["weight", "goalWeight", "bench", "squat", "deadlift", "startWeight"].forEach((key) => {
      if (p.has(key)) {
        state[key] = parseFloat(p.get(key)) || state[key];
        changed = true;
      }
    });

    if (changed) await this.save(state);
    return { state, alertName: p.get("name") || null };
  },
};

const WorkoutStoreActions = {
  STALE_EXPIRE_MS: 90 * 1000,

  getSeconds(state) {
    if (state.isRunning && state.treadmillEndAt) {
      return Math.max(0, Math.ceil((state.treadmillEndAt - Date.now()) / 1000));
    }
    return state._secondsLeft || state.minutesBank * 60;
  },

  pauseKeepBank(state) {
    state.isRunning = false;
    state.treadmillEndAt = null;
    const seconds =
      state._secondsLeft > 0
        ? state._secondsLeft
        : Math.max(0, (state.minutesBank || 0) * 60);
    state._secondsLeft = seconds;
    state.minutesBank = Math.max(state.minutesBank || 0, Math.ceil(seconds / 60));
    state.minutesRemaining = state.minutesBank;
    return state;
  },

  tick(state) {
    if (state.isRunning && state.treadmillEndAt) {
      const remainingMs = state.treadmillEndAt - Date.now();
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
      if (remaining <= 0) {
        const overdueMs = Date.now() - state.treadmillEndAt;
        // After a site restart, endAt is stale — never write 0 back to the server.
        if (overdueMs > this.STALE_EXPIRE_MS) {
          return this.pauseKeepBank(state);
        }
        state.isRunning = false;
        state.treadmillEndAt = null;
        state._secondsLeft = 0;
        state.minutesBank = 0;
        state.minutesRemaining = 0;
      } else {
        state._secondsLeft = remaining;
        state.minutesBank = Math.ceil(remaining / 60);
        state.minutesRemaining = state.minutesBank;
      }
    }
    return state;
  },
};

const WorkoutActions = {
  addSub(count = 1, state) {
    return this.addMinutes(count, state, count);
  },

  addMinutes(mins = 1, state, subCount = 0) {
    const addSeconds = mins * 60;
    if (subCount > 0) state.subs += subCount;
    state.minutesBank += mins;
    if (state.isRunning && state.treadmillEndAt) {
      state.treadmillEndAt += addSeconds * 1000;
      state._secondsLeft = WorkoutStoreActions.getSeconds(state);
    } else {
      state._secondsLeft = state.minutesBank * 60;
    }
    state.minutesRemaining = Math.ceil((state._secondsLeft || 0) / 60);
    return state;
  },

  startTreadmill(state) {
    const seconds = WorkoutStoreActions.getSeconds(state);
    if (seconds <= 0) {
      state._startFailed = true;
      return state;
    }
    state.isRunning = true;
    state.treadmillEndAt = Date.now() + seconds * 1000;
    state._secondsLeft = seconds;
    state._startFailed = false;
    return state;
  },

  stopTreadmill(state) {
    if (state.isRunning && state.treadmillEndAt) {
      const remainingMs = state.treadmillEndAt - Date.now();
      if (remainingMs <= 0 && Date.now() - state.treadmillEndAt > WorkoutStoreActions.STALE_EXPIRE_MS) {
        return WorkoutStoreActions.pauseKeepBank(state);
      }
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
      state._secondsLeft = remaining;
      state.minutesBank = Math.ceil(remaining / 60);
      state.minutesRemaining = state.minutesBank;
    }
    state.isRunning = false;
    state.treadmillEndAt = null;
    return state;
  },

  resetSession(state) {
    const keep = {
      weight: state.weight,
      goalWeight: state.goalWeight,
      bench: state.bench,
      squat: state.squat,
      deadlift: state.deadlift,
      startWeight: state.startWeight,
      streamerName: state.streamerName,
    };
    return { ...WorkoutStore.defaults(), ...keep };
  },

  updateStats(fields, state) {
    return { ...state, ...fields };
  },

  setTotals(subs, mins, state) {
    const safeSubs = Math.max(0, parseInt(subs, 10) || 0);
    const safeMins = Math.max(0, parseInt(mins, 10) || 0);
    const seconds = safeMins * 60;

    state.subs = safeSubs;
    state.minutesBank = safeMins;
    state.minutesRemaining = safeMins;
    state._secondsLeft = seconds;

    if (state.isRunning) {
      state.treadmillEndAt = Date.now() + seconds * 1000;
      if (seconds <= 0) {
        state.isRunning = false;
        state.treadmillEndAt = null;
      }
    }

    return state;
  },
};

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function treadmillStatusHtml(state, seconds) {
  if (state.isRunning) {
    return '<span class="status-dot"></span> On The Treadmill';
  }
  if (seconds > 0) {
    return `<span class="status-dot"></span> Paused — ${formatTime(seconds)}`;
  }
  return '<span class="status-dot"></span> Waiting For Subs';
}

let syncPollInterval = null;
let syncEventSource = null;
let lastStateNonce = -1;

function isObsMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("obs") === "1" || params.get("obs") === "true";
}

async function pushWorkoutUpdate(onUpdate, state) {
  const beforeBank = state.minutesBank || 0;
  const ticked = WorkoutStoreActions.tick({ ...state });
  // Only persist a real finish — never a stale zero after restart/update.
  if (state.isRunning && !ticked.isRunning && (ticked.minutesBank || 0) === 0 && beforeBank > 0) {
    const endAt = state.treadmillEndAt || 0;
    const overdue = endAt ? Date.now() - endAt : 0;
    if (overdue > WorkoutStoreActions.STALE_EXPIRE_MS) {
      onUpdate(ticked);
      return ticked;
    }
  }
  if (state.isRunning && !ticked.isRunning) {
    await WorkoutStore.save(ticked);
    onUpdate(ticked);
    return ticked;
  }
  onUpdate(ticked);
  return ticked;
}

function connectWorkoutEvents(onUpdate) {
  if (typeof EventSource === "undefined") return;
  try {
    syncEventSource?.close();
    syncEventSource = new EventSource(API_WORKOUT_EVENTS);
    syncEventSource.onmessage = async () => {
      const state = await WorkoutStore.load();
      lastStateNonce = state.stateNonce ?? lastStateNonce;
      await pushWorkoutUpdate(onUpdate, state);
      window.dispatchEvent(new CustomEvent("workout-update", { detail: state }));
    };
    syncEventSource.onerror = () => {
      syncEventSource?.close();
      syncEventSource = null;
      setTimeout(() => connectWorkoutEvents(onUpdate), 3000);
    };
  } catch {
    /* SSE unavailable */
  }
}

function startSyncPoll(onUpdate, ms) {
  if (syncPollInterval) return;
  const pollMs = ms || (isObsMode() ? 200 : 300);
  syncPollInterval = setInterval(async () => {
    const state = await WorkoutStore.load();
    const nonce = state.stateNonce ?? 0;
    if (nonce !== lastStateNonce || state.isRunning) {
      lastStateNonce = nonce;
      await pushWorkoutUpdate(onUpdate, state);
    }
  }, pollMs);
}

function startWorkoutSync(options = {}) {
  const onUpdate = options.onUpdate || (() => {});
  connectWorkoutEvents(onUpdate);
  WorkoutStore.load().then((state) => {
    lastStateNonce = state.stateNonce ?? -1;
    pushWorkoutUpdate(onUpdate, state);
  });
  startSyncPoll(onUpdate, options.pollMs);
}

function renderTreadmill(container, state) {
  if (!container) return;
  state = WorkoutStoreActions.tick({ ...state });

  const belt = container.querySelector(".treadmill-belt");
  const timeEl = container.querySelector(".treadmill-time");
  const statusEl = container.querySelector(".treadmill-status");
  const bankEl = container.querySelector("[data-bank]");
  const subsEl = container.querySelector("[data-subs]");

  const seconds = WorkoutStoreActions.getSeconds(state);

  if (timeEl) {
    timeEl.textContent = formatTime(seconds);
    timeEl.classList.toggle("running", state.isRunning);
  }
  if (belt) {
    belt.classList.toggle("running", state.isRunning);
    belt.classList.toggle("paused", !state.isRunning);
  }
  if (statusEl) {
    statusEl.className = `treadmill-status ${state.isRunning ? "active" : seconds > 0 ? "paused" : "idle"}`;
    statusEl.innerHTML = treadmillStatusHtml(state, seconds);
  }
  if (bankEl) bankEl.textContent = state.minutesBank;
  if (subsEl) subsEl.textContent = state.giftedSubs ?? state.subs;
}

function renderSessionStats(container, state) {
  if (!container) return;
  const subsEl = container.querySelector("[data-subs]");
  const messagesEl = container.querySelector("[data-messages]");
  const subTotal = state.giftedSubs ?? state.subs;
  if (subsEl) subsEl.textContent = subTotal;
  if (messagesEl) messagesEl.textContent = state.messageCount ?? 0;
}

function renderWeight(container, state) {
  if (!container) return;
  const weightEl = container.querySelector("[data-weight]");
  const goalEl = container.querySelector("[data-goal]");
  const toGoEl = container.querySelector("[data-togo]");
  const fillEl = container.querySelector(".progress-fill");

  const lost = state.startWeight - state.weight;
  const total = state.startWeight - state.goalWeight;
  const pct = total > 0 ? Math.min(100, Math.max(0, (lost / total) * 100)) : 0;

  if (weightEl) weightEl.textContent = state.weight;
  if (goalEl) goalEl.textContent = state.goalWeight;
  if (toGoEl) toGoEl.textContent = Math.max(0, state.weight - state.goalWeight);
  if (fillEl) fillEl.style.width = pct + "%";
}

function renderLifts(container, state) {
  if (!container) return;
  const map = { bench: state.bench, squat: state.squat, deadlift: state.deadlift };
  Object.entries(map).forEach(([key, val]) => {
    const el = container.querySelector(`[data-lift="${key}"]`);
    if (el) el.textContent = val;
  });
}

function renderTimeOwed(container, state) {
  if (!container) return;
  state = WorkoutStoreActions.tick({ ...state });
  const el = container.querySelector("[data-time-owed]");
  const label = container.querySelector(".stat-label");
  if (!el) return;

  const seconds = WorkoutStoreActions.getSeconds(state);
  el.textContent = formatTime(seconds);
  if (label) {
    label.textContent = state.isRunning
      ? "Time Remaining"
      : seconds > 0
        ? "Paused Time"
        : "Mins On Treadmill";
  }
}

function renderAll(options, state) {
  if (options.treadmill) renderTreadmill(options.treadmill, state);
  if (options.sessionStats) renderSessionStats(options.sessionStats, state);
  if (options.weight) renderWeight(options.weight, state);
  if (options.lifts) renderLifts(options.lifts, state);
  if (options.timeOwed) renderTimeOwed(options.timeOwed, state);
  if (options.subs) {
    const el = options.subs.querySelector(".sub-count");
    if (el) el.textContent = state.subs;
  }
}

function initWorkoutPage(options = {}) {
  // Show UI immediately — never wait on server
  const defaults = WorkoutStore.loadLocal();
  renderAll(options, defaults);

  WorkoutStore.parseUrl().then(({ state }) => {
    lastStateNonce = state.stateNonce ?? -1;
    renderAll(options, state);
  });

  window.addEventListener("workout-update", (e) => renderAll(options, e.detail));

  startWorkoutSync({
    onUpdate: (state) => renderAll(options, state),
    pollMs: isObsMode() ? 200 : 300,
  });

  return defaults;
}

const WORKOUT_URLS = {
  base: WORKOUT_BASE_URL,
  controlPanel: `${WORKOUT_BASE_URL}/control-panel.html`,
  treadmill: `${WORKOUT_BASE_URL}/treadmill-tracker.html`,
  stats: `${WORKOUT_BASE_URL}/workout-stats.html`,
  alert: `${WORKOUT_BASE_URL}/sub-alert.html`,
  scene: `${WORKOUT_BASE_URL}/just-chatting.html`,
  sub: (name) => `${WORKOUT_BASE_URL}/sub-alert.html?sub=1&name=${encodeURIComponent(name)}`,
  addSub: `${WORKOUT_BASE_URL}/treadmill-tracker.html?sub=1`,
  start: `${WORKOUT_BASE_URL}/treadmill-tracker.html?start=1`,
  stop: `${WORKOUT_BASE_URL}/treadmill-tracker.html?stop=1`,
  reset: `${WORKOUT_BASE_URL}/treadmill-tracker.html?reset=1`,
};
