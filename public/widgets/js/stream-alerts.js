function initStreamAlerts(options = {}) {
  const banner = options.banner || document.getElementById("alertBanner");
  const track = options.track || document.getElementById("alertTrack");
  const staticBanner =
    options.staticBanner || document.getElementById("staticRulesBanner");
  const params = new URLSearchParams(location.search);
  const obsMode = params.get("obs") === "1" || params.get("obs") === "true";
  const embedMode = params.get("embed") === "1" || params.get("embed") === "true";
  const displayMs = options.displayMs || 5500;
  const apiBase = String(options.apiBase || location.origin || "").replace(/\/$/, "");
  const stateUrl = `${apiBase}/api/alerts/state`;
  const eventsUrl = `${apiBase}/api/alerts/events`;
  let hideTimer = null;
  let lastNonce = 0;
  let bootstrapped = false;

  if (embedMode) {
    document.body.classList.add("stream-alerts-embed");
  }

  function buildDetail(alert) {
    if (alert.detail) return alert.detail;
    const qty = alert.quantity || 1;
    const user = alert.username || "Someone";

    if (alert.type === "follow") return "FOR THE FOLLOW";
    if (alert.type === "sub") return "FOR THE SUB";
    if (alert.type === "gift") {
      return qty > 1 ? `FOR ${qty} GIFTED SUBS` : "FOR THE GIFTED SUB";
    }
    if (alert.type === "kicks") {
      return qty > 1 ? `FOR ${qty} KICKS` : "FOR THE KICKS";
    }
    return alert.label || `FOR ${user}`;
  }

  function buildTreadmillExtra(type, quantity = 1) {
    if (type !== "sub" && type !== "gift") return "";
    const mins = Math.max(1, quantity);
    const label = mins === 1 ? "1 MIN" : `${mins} MINS`;
    return `YOU ADDED ${label} TO THE TREADMILL`;
  }

  function renderAlert(alert) {
    if (!track || !alert) return;

    const username = alert.username || "Someone";
    const detail = buildDetail(alert);
    const extra =
      alert.extra ||
      (alert.type === "sub" || alert.type === "gift"
        ? buildTreadmillExtra(alert.type, alert.quantity || 1)
        : "");

    track.innerHTML = `
      <div class="stream-alert-copy stream-alert-enter">
        <span class="stream-alert-thanks">THANK YOU</span>
        <span class="stream-alert-user">${escapeHtml(username)}</span>
        <span class="stream-alert-detail">${escapeHtml(detail)}</span>
        ${extra ? `<span class="stream-alert-extra">${escapeHtml(extra)}</span>` : ""}
      </div>
    `;
  }

  function setStaticVisible(visible) {
    if (!staticBanner) return;
    staticBanner.style.opacity = visible ? "1" : "0";
    staticBanner.style.visibility = visible ? "visible" : "hidden";
  }

  function showAlert(state, { force = false } = {}) {
    if (!banner || !state?.lastAlert) return false;
    if (!force && state.alertNonce <= lastNonce) return false;

    lastNonce = state.alertNonce;
    clearTimeout(hideTimer);
    renderAlert(state.lastAlert);
    setStaticVisible(false);
    banner.classList.add("show");
    hideTimer = setTimeout(() => {
      banner.classList.remove("show");
      setStaticVisible(true);
    }, displayMs);
    return true;
  }

  async function fetchState() {
    const res = await fetch(stateUrl, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  }

  async function bootstrap() {
    try {
      const state = await fetchState();
      if (state) lastNonce = state.alertNonce || 0;
    } catch {
      /* ignore */
    } finally {
      bootstrapped = true;
    }
  }

  async function poll() {
    if (!bootstrapped) return;
    try {
      const state = await fetchState();
      if (state) showAlert(state);
    } catch {
      /* ignore */
    }
  }

  function connectSse() {
    const source = new EventSource(eventsUrl);
    source.onmessage = (event) => {
      if (!bootstrapped) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "alert") {
          showAlert(payload);
        }
      } catch {
        /* ignore */
      }
    };
    source.onerror = () => {
      source.close();
      setTimeout(connectSse, obsMode ? 1000 : 3000);
    };
  }

  if (!banner || !track) return null;

  bootstrap().then(() => {
    if (!embedMode) connectSse();
    poll();
    setInterval(poll, embedMode ? 500 : obsMode ? 250 : 800);
  });

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "stream-alert-push") return;
    if (event.origin && event.origin !== location.origin) return;
    showAlert(event.data.state, { force: Boolean(event.data.force) });
  });

  return { showAlert, poll };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
