function initNowPlayingWidget(options = {}) {
  const root = options.root || document.getElementById("nowPlayingRoot");
  const titleEl = options.titleEl || document.getElementById("nowPlayingTitle");
  const artistEl = options.artistEl || document.getElementById("nowPlayingArtist");
  const artEl = options.artEl || document.getElementById("nowPlayingArt");
  const requestEl = options.requestEl || document.getElementById("nowPlayingRequest");
  const progressEl = options.progressEl || document.getElementById("nowPlayingProgress");
  const params = new URLSearchParams(location.search);
  const obsMode = params.get("obs") === "1" || params.get("obs") === "true";
  const embedMode = params.get("embed") === "1" || params.get("embed") === "true";
  const apiBase = String(options.apiBase || location.origin || "").replace(/\/$/, "");
  const stateUrl = `${apiBase}/api/spotify/now-playing`;
  const eventsUrl = `${apiBase}/api/spotify/events`;

  if (!root || !titleEl) return null;
  if (obsMode) document.body.classList.add("obs-mode");
  if (embedMode) document.body.classList.add("now-playing-embed");

  let lastTrackId = null;
  let trackStartedAt = 0;
  let trackDurationMs = 0;
  let trackProgressMs = 0;
  let trackIsPlaying = false;
  let progressTimer = null;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatRequest(state) {
    const req = state?.lastRequest;
    if (!req?.trackName) return "";
    const by = req.username ? ` — req by ${req.username}` : "";
    return `Last request: ${req.trackName}${by}`;
  }

  function updateProgressBar() {
    if (!progressEl || !trackDurationMs) {
      if (progressEl) progressEl.style.width = "0%";
      return;
    }

    let progress = trackProgressMs;
    if (trackIsPlaying) {
      progress += Date.now() - trackStartedAt;
    }
    const pct = Math.max(0, Math.min(100, (progress / trackDurationMs) * 100));
    progressEl.style.width = `${pct}%`;
  }

  function renderState(state) {
    if (!state?.connected) {
      titleEl.textContent = "Connect Spotify in dashboard";
      artistEl.textContent = state?.error || "";
      if (artEl) artEl.style.backgroundImage = "";
      if (requestEl) requestEl.textContent = "";
      if (progressEl) progressEl.style.width = "0%";
      return;
    }

    if (state.error && !state.track) {
      titleEl.textContent = "Open Spotify on your PC";
      artistEl.textContent = state.error;
      if (requestEl) requestEl.textContent = formatRequest(state);
      return;
    }

    const track = state.track;
    if (!track) {
      titleEl.textContent = state.isPlaying ? "Spotify active" : "Nothing playing";
      artistEl.textContent = state.device ? `Device: ${state.device}` : "Start music in Spotify";
      if (artEl) artEl.style.backgroundImage = "";
      if (requestEl) requestEl.textContent = formatRequest(state);
      if (progressEl) progressEl.style.width = "0%";
      return;
    }

    titleEl.textContent = track.name;
    artistEl.textContent = track.artists || "";
    if (artEl) {
      artEl.style.backgroundImage = track.albumArt
        ? `url("${track.albumArt}")`
        : "";
    }
    if (requestEl) requestEl.textContent = formatRequest(state);

    const nextId = track.id || track.uri || track.name;
    if (nextId !== lastTrackId) {
      lastTrackId = nextId;
      trackProgressMs = state.progressMs || 0;
      trackDurationMs = track.durationMs || 0;
      trackIsPlaying = Boolean(state.isPlaying);
      trackStartedAt = Date.now();
    } else {
      trackProgressMs = state.progressMs || trackProgressMs;
      trackDurationMs = track.durationMs || trackDurationMs;
      trackIsPlaying = Boolean(state.isPlaying);
      trackStartedAt = Date.now();
    }

    updateProgressBar();
  }

  async function fetchState() {
    const res = await fetch(stateUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Now playing API ${res.status}`);
    return res.json();
  }

  async function poll() {
    try {
      const state = await fetchState();
      renderState(state);
    } catch {
      titleEl.textContent = "Music server offline";
      artistEl.textContent = "";
    }
  }

  function connectSse() {
    if (embedMode || typeof EventSource === "undefined") return;
    const source = new EventSource(eventsUrl);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "playback" && payload.state) {
          renderState(payload.state);
        }
      } catch {
        /* ignore */
      }
    };
    source.onerror = () => {
      source.close();
      setTimeout(connectSse, 3000);
    };
  }

  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(updateProgressBar, 500);

  poll();
  if (!embedMode) connectSse();
  setInterval(poll, embedMode ? 5000 : obsMode ? 6000 : 8000);

  return { poll, renderState };
}
