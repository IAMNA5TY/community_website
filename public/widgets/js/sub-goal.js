const SUB_GOAL_BASE = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_SUB_GOAL = `${SUB_GOAL_BASE}/api/sub-goal`;
const API_SUB_GOAL_EVENTS = `${SUB_GOAL_BASE}/api/sub-goal/events`;

const SubGoalStore = {
  _cache: null,

  defaults() {
    return {
      count: 0,
      goal: 50,
      label: "12 Hour Stream",
      baseSeconds: 4 * 3600,
      maxSeconds: 12 * 3600,
      secondsPerSub: 576,
      bankSeconds: 4 * 3600,
      remainingSeconds: 4 * 3600,
      displayTime: "4:00:00",
      maxDisplayTime: "12:00:00",
      minutesPerSub: 9.6,
      progressPct: 0,
      atMax: false,
      isRunning: false,
      endsAt: null,
      sessionStartedAt: null,
      lastSubAt: null,
      lastSubBy: null,
      nonce: 0,
    };
  },

  async load() {
    try {
      const res = await fetch(API_SUB_GOAL, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const state = { ...this.defaults(), ...(await res.json()) };
      this._cache = state;
      return { ...state };
    } catch {
      this._cache = this._cache || this.defaults();
      return { ...this._cache };
    }
  },

  emit(state) {
    this._cache = state;
    window.dispatchEvent(new CustomEvent("sub-goal-update", { detail: state }));
  },
};

function formatClock(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function liveRemaining(state) {
  if (state?.isRunning && state.endsAt) {
    return Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
  }
  return Math.max(0, Math.round(state?.remainingSeconds ?? state?.bankSeconds ?? 0));
}

function renderSubGoal(root, state) {
  if (!root || !state) return;
  const remaining = liveRemaining(state);
  const maxSeconds = state.maxSeconds || 12 * 3600;
  const baseSeconds = state.baseSeconds || 4 * 3600;
  const count = state.count || 0;
  const goal = state.goal || 50;
  const label = state.label || "12 Hour Stream";
  const bank = Math.min(maxSeconds, Math.max(remaining, state.bankSeconds || remaining));
  const progress = (bank - baseSeconds) / (maxSeconds - baseSeconds);
  const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
  const atMax = remaining >= maxSeconds - 1 || state.atMax;

  const timeEl = root.querySelector("[data-sub-time]");
  const maxEl = root.querySelector("[data-sub-max]");
  const labelEl = root.querySelector("[data-sub-label]");
  const fillEl = root.querySelector("[data-sub-fill]");
  const metaEl = root.querySelector("[data-sub-meta]");
  const statusEl = root.querySelector("[data-sub-status]");

  if (timeEl) timeEl.textContent = formatClock(remaining);
  if (maxEl) maxEl.textContent = formatClock(maxSeconds);
  if (labelEl) labelEl.textContent = label;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (metaEl) {
    metaEl.textContent = `${count}/${goal} subs · +${state.minutesPerSub || 9.6} min each`;
  }
  if (statusEl) {
    statusEl.textContent = state.isRunning ? "counting down" : "paused";
  }
  root.classList.toggle("goal-hit", atMax);
  root.classList.toggle("is-running", Boolean(state.isRunning));
}

function connectSubGoalEvents() {
  if (typeof EventSource === "undefined") return;
  let source;
  try {
    source = new EventSource(API_SUB_GOAL_EVENTS);
  } catch {
    return;
  }

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === "sub-goal" || typeof data.count === "number") {
        SubGoalStore.emit({ ...SubGoalStore.defaults(), ...data });
      }
    } catch {
      /* ignore bad payloads */
    }
  };

  source.onerror = () => {
    source.close();
    setTimeout(connectSubGoalEvents, 3000);
  };
}

async function initSubGoalWidget(options = {}) {
  const root = options.root || document.getElementById("subGoalRoot");
  if (!root) return;

  let state = await SubGoalStore.load();
  const paint = (next) => {
    state = next || state;
    renderSubGoal(root, state);
  };
  paint(state);

  window.addEventListener("sub-goal-update", (event) => {
    paint(event.detail);
  });

  connectSubGoalEvents();

  // Smooth countdown between API polls
  setInterval(() => {
    if (state) renderSubGoal(root, state);
  }, 250);

  const pollMs = new URLSearchParams(location.search).has("obs") ? 2000 : 5000;
  setInterval(async () => {
    paint(await SubGoalStore.load());
  }, pollMs);
}

window.SubGoalStore = SubGoalStore;
window.initSubGoalWidget = initSubGoalWidget;
