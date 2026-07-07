const SLOTS_BASE_URL = location.protocol.startsWith("http")
  ? `${location.protocol}//${location.host}`
  : "http://127.0.0.1:3000";

const API_SLOTS = `${SLOTS_BASE_URL}/api/slots`;

let lastNonce = -1;
let pollTimer = null;
let miniSpinning = false;
let pickInitialized = false;

async function fetchSlots() {
  const res = await fetch(API_SLOTS);
  if (!res.ok) throw new Error("Failed to load slots");
  return res.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderQueue(container, state) {
  if (!container) return;

  if (!state.requests?.length) {
    container.innerHTML = `<div class="slots-empty">No requests yet — chat !sr &lt;slot name&gt;</div>`;
    return;
  }

  container.innerHTML = state.requests
    .map(
      (entry) => `
        <div class="slots-row">
          <span class="slots-slot">${escapeHtml(entry.slotName)}</span>
          <span class="slots-user">${escapeHtml(entry.username)}</span>
        </div>
      `
    )
    .join("");
}

function renderStaticPick(pickEl, pick) {
  if (!pickEl) return;
  pickEl.innerHTML = `
    <div class="pick-slot">${escapeHtml(pick.slotName)}</div>
    <div class="pick-user">Requested by ${escapeHtml(pick.username)}</div>
  `;
}

async function renderPick(pickEl, labelEl, state, options = {}) {
  if (!pickEl) return;

  const pick = state.lastPick;
  const miniReel = options.miniReel;
  const miniReelInner = options.miniReelInner;
  const miniResult = options.miniResult;

  if (!pick) {
    pickEl.classList.remove("spinning", "landed", "pulse");
    if (miniReel) miniReel.classList.add("hidden");
    if (miniResult) {
      miniResult.classList.remove("hidden");
      miniResult.innerHTML = `<div class="pick-placeholder">Waiting for !slots</div>`;
    } else {
      pickEl.innerHTML = `<div class="pick-placeholder">Waiting for !slots</div>`;
    }
    if (labelEl) labelEl.textContent = "Last pick";
    return;
  }

  if (!pickInitialized) {
    lastNonce = state.pickNonce;
    pickInitialized = true;
  } else if (state.pickNonce !== lastNonce && typeof playSlotSpin === "function" && miniReelInner) {
    lastNonce = state.pickNonce;
    miniSpinning = true;
    pickEl.classList.add("spinning");
    if (labelEl) labelEl.textContent = "Spinning...";
    if (miniReel) miniReel.classList.remove("hidden");
    if (miniResult) miniResult.classList.add("hidden");

    await playSlotSpin({
      reelInner: miniReelInner,
      spinPool: pick.spinPool,
      winner: pick,
      itemHeight: 52,
      duration: 3200,
      compact: true,
      onComplete() {
        miniSpinning = false;
        pickEl.classList.remove("spinning");
        pickEl.classList.add("landed", "pulse");
        if (labelEl) labelEl.textContent = "Last pick";
        if (miniReel) miniReel.classList.add("hidden");
        if (miniResult) {
          miniResult.classList.remove("hidden");
          miniResult.innerHTML = `
            <div class="pick-slot">${escapeHtml(pick.slotName)}</div>
            <div class="pick-user">Requested by ${escapeHtml(pick.username)}</div>
          `;
        }
        if (typeof options.onNewPick === "function") options.onNewPick(pick);
      },
    });
    return;
  } else if (state.pickNonce !== lastNonce) {
    lastNonce = state.pickNonce;
  }

  if (miniSpinning) return;

  if (miniResult) {
    miniResult.classList.remove("hidden");
    miniResult.innerHTML = `
      <div class="pick-slot">${escapeHtml(pick.slotName)}</div>
      <div class="pick-user">Requested by ${escapeHtml(pick.username)}</div>
    `;
    if (miniReel) miniReel.classList.add("hidden");
  } else {
    renderStaticPick(pickEl, pick);
  }

  if (labelEl) labelEl.textContent = "Last pick";
}

async function refreshSlotsUI(options = {}) {
  const state = await fetchSlots();
  renderQueue(options.queue, state);
  await renderPick(options.pick, options.pickLabel, state, options);
  if (options.count) {
    options.count.textContent = state.requests?.length ?? 0;
  }
  return state;
}

function startSlotsPoll(options = {}, ms = 1000) {
  if (pollTimer) return;
  refreshSlotsUI(options);
  pollTimer = setInterval(() => refreshSlotsUI(options), ms);
}
