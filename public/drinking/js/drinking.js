/**
 * Drinking / shotgun beer counter — shared client store
 */

const DRINKING_BASE_URL = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_DRINKING = `${DRINKING_BASE_URL}/api/drinking`;
const API_DRINKING_EVENTS = `${DRINKING_BASE_URL}/api/drinking/events`;

const DrinkingStore = {
  _cache: null,
  _useApi: true,

  defaults() {
    return {
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
  },

  async fetchApi(url, options = {}, ms = 1500) {
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
    if (this._useApi) {
      try {
        const res = await this.fetchApi(API_DRINKING);
        if (!res.ok) throw new Error("bad status");
        const state = { ...this.defaults(), ...(await res.json()) };
        this._cache = state;
        return { ...state };
      } catch {
        this._useApi = false;
      }
    }
    this._cache = this._cache || this.defaults();
    return { ...this._cache };
  },

  async applyAction(action, extra = {}) {
    if (!this._useApi) {
      throw new Error("API unavailable");
    }
    const res = await this.fetchApi(API_DRINKING, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Action failed");
    this._cache = data;
    window.dispatchEvent(new CustomEvent("drinking-update", { detail: data }));
    return data;
  },

  emit(state) {
    this._cache = state;
    window.dispatchEvent(new CustomEvent("drinking-update", { detail: state }));
  },
};

function getBeerProgress(state) {
  const goal = state.sessionGoal || 12;
  const count = state.sessionCount || 0;
  return Math.min(100, Math.round((count / goal) * 100));
}

function renderBeerCans(container, state, maxVisible = 12) {
  if (!container) return;
  const goal = Math.min(state.sessionGoal || 12, maxVisible);
  const count = state.sessionCount || 0;
  const cans = [];
  for (let i = 0; i < goal; i += 1) {
    cans.push(`<span class="beer-can${i < count ? "" : " empty"}" aria-hidden="true"></span>`);
  }
  container.innerHTML = cans.join("");
}

function updateDrinkingDisplay(root, state) {
  const scope = root?.querySelectorAll ? root : document;

  const count = state.sessionCount || 0;
  const goal = state.sessionGoal || 12;
  const progress = getBeerProgress(state);
  const cheers = state.cheersSessionCount || 0;

  scope.querySelectorAll?.("[data-beer-count]")?.forEach((el) => {
    el.textContent = count;
    el.classList?.toggle("long", count >= 100);
  });
  scope.querySelectorAll?.("[data-beer-goal]")?.forEach((el) => {
    el.textContent = goal;
  });
  scope.querySelectorAll?.("[data-beer-progress]")?.forEach((el) => {
    el.textContent = `${progress}%`;
  });
  scope.querySelectorAll?.(".beer-progress-fill")?.forEach((el) => {
    el.style.width = `${progress}%`;
  });
  scope.querySelectorAll?.("[data-beer-lifetime]")?.forEach((el) => {
    el.textContent = state.lifetimeCount || 0;
  });
  scope.querySelectorAll?.("[data-beer-last]")?.forEach((el) => {
    el.textContent = state.lastShotgunBy || "—";
  });
  scope.querySelectorAll?.("[data-cheers-count]")?.forEach((el) => {
    el.textContent = cheers;
  });
  scope.querySelectorAll?.("[data-cheers-lifetime]")?.forEach((el) => {
    el.textContent = state.cheersLifetimeCount || 0;
  });
  scope.querySelectorAll?.("[data-cheers-last]")?.forEach((el) => {
    el.textContent = state.lastCheersBy
      ? `Last cheer: ${state.lastCheersBy}`
      : "—";
  });

  const cansEl = scope.querySelector?.("[data-beer-cans]") || document.querySelector("[data-beer-cans]");
  renderBeerCans(cansEl, state);
}

function renderBeerCounter(container, state) {
  if (!container) return;
  updateDrinkingDisplay(container, state);

  const lastEl = container.querySelector("[data-beer-last]");
  if (lastEl && state.lastShotgunBy) {
    lastEl.textContent = `Last: ${state.lastShotgunBy}`;
  }
}

function startDrinkingSync(options = {}) {
  const embedMode =
    options.embedMode ||
    new URLSearchParams(location.search).get("embed") === "1";
  const onUpdate = options.onUpdate || (() => {});
  const pollMs = options.pollMs || (embedMode ? 1000 : 800);
  let lastShotgunNonce = options.initialShotgunNonce ?? -1;
  let lastCheersNonce = options.initialCheersNonce ?? -1;
  let pollTimer = null;
  let eventSource = null;

  async function refresh() {
    const state = await DrinkingStore.load();
    onUpdate(state);
    if (state.shotgunNonce > lastShotgunNonce) {
      lastShotgunNonce = state.shotgunNonce;
      if (options.onShotgun) options.onShotgun(state);
    }
    if (state.cheersNonce > lastCheersNonce) {
      lastCheersNonce = state.cheersNonce;
      if (options.onCheers) options.onCheers(state);
    }
    return state;
  }

  function connectEvents() {
    if (typeof EventSource === "undefined") return;
    try {
      eventSource = new EventSource(API_DRINKING_EVENTS);
      eventSource.onmessage = async (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.event === "shotgun" || payload.event === "cheers") {
            const state = await DrinkingStore.load();
            onUpdate(state);
            if (payload.event === "shotgun" && state.shotgunNonce > lastShotgunNonce) {
              lastShotgunNonce = state.shotgunNonce;
              if (options.onShotgun) options.onShotgun(state);
            }
            if (payload.event === "cheers" && state.cheersNonce > lastCheersNonce) {
              lastCheersNonce = state.cheersNonce;
              if (options.onCheers) options.onCheers(state);
            }
            DrinkingStore.emit(state);
          }
        } catch {
          // ignore malformed events
        }
      };
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
      };
    } catch {
      // SSE unavailable
    }
  }

  refresh();
  if (!embedMode) connectEvents();
  pollTimer = setInterval(refresh, pollMs);

  return () => {
    clearInterval(pollTimer);
    eventSource?.close();
  };
}

function initBeerCounterPage(options = {}) {
  const container = options.container || document.getElementById("beerCounterPanel");
  if (!container) return;

  const onUpdate = options.onUpdate || ((state) => renderBeerCounter(container, state));

  return startDrinkingSync({
    pollMs: options.pollMs || 800,
    onUpdate,
    onShotgun: options.onShotgun,
    onCheers: options.onCheers,
  });
}

function initShotgunAlertPage(options = {}) {
  const overlay = options.overlay || document.getElementById("shotgunAlert");
  const titleEl = options.titleEl || document.getElementById("alertTitle");
  const countEl = options.countEl || document.getElementById("alertCount");
  const subEl = options.subEl || document.getElementById("alertSub");
  const params = new URLSearchParams(location.search);
  const obsMode = params.get("obs") === "1" || params.get("obs") === "true";
  let hideTimer = null;

  if (obsMode && overlay) {
    overlay.classList.add("obs-mode");
  }

  function showAlert(state) {
    if (!overlay) return;
    clearTimeout(hideTimer);
    if (titleEl) titleEl.textContent = "SHOTGUN!";
    if (countEl) countEl.textContent = `#${state.sessionCount}`;
    if (subEl) {
      subEl.textContent = state.lastShotgunBy
        ? `${state.lastShotgunBy} cracked one open`
        : "Beer down the hatch";
    }
    overlay.classList.add("show");
    hideTimer = setTimeout(() => overlay.classList.remove("show"), options.displayMs || 4500);
  }

  return startDrinkingSync({
    pollMs: obsMode ? 400 : 800,
    onShotgun: showAlert,
  });
}

function initDrinkingControlPanel(options = {}) {
  const countEl = options.countEl || document.querySelector("[data-control-count]");
  const goalEl = options.goalEl || document.querySelector("[data-control-goal]");
  const lifetimeEl = options.lifetimeEl || document.querySelector("[data-control-lifetime]");
  const cheersEl = options.cheersEl || document.querySelector("[data-control-cheers]");
  const statusEl = options.statusEl || document.querySelector("[data-control-status]");

  function render(state) {
    if (countEl) countEl.textContent = state.sessionCount || 0;
    if (goalEl) goalEl.textContent = state.sessionGoal || 12;
    if (lifetimeEl) lifetimeEl.textContent = state.lifetimeCount || 0;
    if (cheersEl) cheersEl.textContent = state.cheersSessionCount || 0;
    if (statusEl) {
      const remaining = Math.max(0, (state.sessionGoal || 12) - (state.sessionCount || 0));
      const cheers = state.cheersSessionCount || 0;
      statusEl.textContent =
        remaining <= 0
          ? `Goal reached · ${cheers} cheers this stream`
          : `${remaining} shotgun${remaining === 1 ? "" : "s"} to goal · ${cheers} cheers`;
    }
  }

  const stop = startDrinkingSync({ onUpdate: render });

  async function action(name, extra = {}) {
    try {
      const state = await DrinkingStore.applyAction(name, extra);
      render(state);
      return state;
    } catch (error) {
      if (statusEl) statusEl.textContent = error.message;
      throw error;
    }
  }

  document.getElementById("drinking-shotgun-btn")?.addEventListener("click", () => action("add"));
  document.getElementById("drinking-shotgun-3-btn")?.addEventListener("click", () => action("add", { count: 3 }));
  document.getElementById("drinking-undo-btn")?.addEventListener("click", () => action("remove"));
  document.getElementById("drinking-reset-btn")?.addEventListener("click", () => action("reset"));
  document.getElementById("drinking-cheer-btn")?.addEventListener("click", () => action("cheer", { by: "Dashboard" }));
  document.getElementById("drinking-goal-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("drinking-goal-input");
    const goal = parseInt(input?.value, 10);
    if (!goal || goal < 1) return;
    await action("setGoal", { goal });
  });

  return { stop, action };
}
