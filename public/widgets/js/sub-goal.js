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

function renderSubGoal(root, state) {
  if (!root || !state) return;
  const count = state.count || 0;
  const goal = state.goal || 50;
  const label = state.label || "12 Hour Stream";
  const pct = Math.min(100, Math.round((count / goal) * 100));
  const hit = count >= goal;

  const countEl = root.querySelector("[data-sub-count]");
  const goalEl = root.querySelector("[data-sub-goal]");
  const labelEl = root.querySelector("[data-sub-label]");
  const fillEl = root.querySelector("[data-sub-fill]");
  const pctEl = root.querySelector("[data-sub-pct]");

  if (countEl) countEl.textContent = String(count);
  if (goalEl) goalEl.textContent = String(goal);
  if (labelEl) labelEl.textContent = label;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  root.classList.toggle("goal-hit", hit);
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

  const paint = (state) => renderSubGoal(root, state);
  paint(await SubGoalStore.load());

  window.addEventListener("sub-goal-update", (event) => {
    paint(event.detail);
  });

  connectSubGoalEvents();

  const pollMs = new URLSearchParams(location.search).has("obs") ? 2000 : 5000;
  setInterval(async () => {
    paint(await SubGoalStore.load());
  }, pollMs);
}

window.SubGoalStore = SubGoalStore;
window.initSubGoalWidget = initSubGoalWidget;
