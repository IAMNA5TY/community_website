const SUBATHON_BASE = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_SUBATHON = `${SUBATHON_BASE}/api/subathon`;
const API_SUBATHON_EVENTS = `${SUBATHON_BASE}/api/subathon/events`;

const SubathonStore = {
  _cache: null,

  defaults() {
    return {
      count: 0,
      label: "SUBATHON",
      startSeconds: 3600,
      secondsPerSub: 600,
      remainingSeconds: 3600,
      displayTime: "1:00:00",
      minutesPerSub: 10,
      progressPct: 100,
      isRunning: false,
      ended: false,
      lastSubBy: null,
      lastAddedSeconds: 0,
      nonce: 0,
    };
  },

  async load() {
    try {
      const res = await fetch(API_SUBATHON, { cache: "no-store" });
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
    window.dispatchEvent(new CustomEvent("subathon-update", { detail: state }));
  },
};

function formatClock(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function liveRemaining(state) {
  if (state?.isRunning && state.endsAt) {
    return Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
  }
  return Math.max(0, Math.round(state?.remainingSeconds || 0));
}

function renderSubathon(root, state) {
  if (!root || !state) return;
  const remaining = liveRemaining(state);
  const ended = remaining <= 0;

  const timeEl = root.querySelector("[data-subathon-time]");
  const labelEl = root.querySelector("[data-subathon-label]");
  const fillEl = root.querySelector("[data-subathon-fill]");
  const metaEl = root.querySelector("[data-subathon-meta]");
  const lastEl = root.querySelector("[data-subathon-last]");
  const statusEl = root.querySelector("[data-subathon-status]");

  if (timeEl) timeEl.textContent = formatClock(remaining);
  if (labelEl) labelEl.textContent = state.label || "SUBATHON";
  if (fillEl) fillEl.style.width = `${Math.min(100, Math.max(8, state.progressPct || 0))}%`;
  if (metaEl) {
    metaEl.textContent = `${state.count || 0} sub${state.count === 1 ? "" : "s"} · +${state.minutesPerSub || 10} min each`;
  }
  if (lastEl) {
    lastEl.textContent = state.lastSubBy
      ? `last +${Math.round((state.lastAddedSeconds || 0) / 60)}m · ${state.lastSubBy}`
      : "subs add time to the clock";
  }
  if (statusEl) {
    statusEl.textContent = ended ? "ended" : state.isRunning ? "live" : "paused";
  }

  root.classList.toggle("is-running", Boolean(state.isRunning) && !ended);
  root.classList.toggle("is-ended", ended);
}

function connectSubathonEvents() {
  if (typeof EventSource === "undefined") return;
  let source;
  try {
    source = new EventSource(API_SUBATHON_EVENTS);
  } catch {
    return;
  }

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === "subathon" || typeof data.count === "number") {
        SubathonStore.emit({ ...SubathonStore.defaults(), ...data });
      }
    } catch {
      /* ignore bad payloads */
    }
  };

  source.onerror = () => {
    source.close();
    setTimeout(connectSubathonEvents, 3000);
  };
}

async function initSubathonWidget(options = {}) {
  const root = options.root || document.getElementById("subathonRoot");
  if (!root) return;

  let state = await SubathonStore.load();
  const paint = (next) => {
    state = next || state;
    renderSubathon(root, state);
  };
  paint(state);

  window.addEventListener("subathon-update", (event) => {
    paint(event.detail);
    root.classList.add("is-pop");
    setTimeout(() => root.classList.remove("is-pop"), 420);
  });

  connectSubathonEvents();

  setInterval(() => {
    if (state) renderSubathon(root, state);
  }, 250);

  const pollMs = new URLSearchParams(location.search).has("obs") ? 2000 : 5000;
  setInterval(async () => {
    paint(await SubathonStore.load());
  }, pollMs);
}

window.SubathonStore = SubathonStore;
window.initSubathonWidget = initSubathonWidget;
