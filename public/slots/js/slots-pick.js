const SLOTS_BASE_URL = location.protocol.startsWith("http")

  ? `${location.protocol}//${location.host}`

  : "http://127.0.0.1:3000";



const API_SLOTS = `${SLOTS_BASE_URL}/api/slots`;

const API_SLOTS_EVENTS = `${SLOTS_BASE_URL}/api/slots/events`;

const REPLAY_WINDOW_MS = 3 * 60 * 1000;

const POLL_MS_OBS = 400;

const POLL_MS_DEFAULT = 800;

const WINNER_DISPLAY_MS = 12000;



async function fetchSlots() {

  const response = await fetch(API_SLOTS, { cache: "no-store" });

  if (!response.ok) throw new Error("Failed to load slots");

  return response.json();

}



function startSlotsPickAlert(options = {}) {

  const overlay = options.overlay || document.getElementById("pickOverlay");

  const machine = options.machine || document.getElementById("slotMachine");

  const reelInners = options.reelInners || [

    document.getElementById("reelInner1"),

    document.getElementById("reelInner2"),

    document.getElementById("reelInner3"),

  ].filter(Boolean);

  const titleEl = options.titleEl || document.getElementById("slotTitle");

  const subtitleEl = options.subtitleEl || document.getElementById("slotSubtitle");

  const params = new URLSearchParams(location.search);

  const obsMode = params.get("obs") === "1" || params.get("obs") === "true";
  const embedMode = params.get("embed") === "1" || params.get("embed") === "true";



  if (!overlay || !machine || !reelInners.length) return;



  document.addEventListener("slots-idle-phase", (event) => {

    if (spinning) return;

    const phase = event.detail?.phase;

    if (phase === "land") {

      machine.classList.add("landed");

      machine.classList.remove("idle-promo-spinning");

      if (titleEl) titleEl.textContent = "Use code NA5TY";

      if (subtitleEl) subtitleEl.textContent = "stake.us";

    } else if (phase === "spin") {

      machine.classList.remove("landed");

      machine.classList.add("idle-promo-spinning");

      if (titleEl) titleEl.textContent = "Slot Requests";

      if (subtitleEl) subtitleEl.textContent = "!sr <slot name> to request";

    }

  });



  if (obsMode) {

    document.body.classList.add("obs-mode");

  }



  overlay.classList.add("show");

  machine.classList.add("show");



  let lastSeenNonce = -1;

  let spinning = false;

  let resetTimer = null;

  let initialized = false;



  function showIdleState() {

    clearTimeout(resetTimer);

    machine.classList.remove("spinning", "landed");

    machine.classList.add("idle-promo");

    if (titleEl) titleEl.textContent = "Slot Requests";

    if (subtitleEl) subtitleEl.textContent = "!sr <slot name> to request";

    startIdlePromoSpin(reelInners);

  }



  function showWinnerState(pick) {

    if (titleEl) titleEl.textContent = pick.slotName;

    if (subtitleEl) {

      subtitleEl.textContent = `Requested by ${pick.username}`;

    }

  }



  function markPickShown(nonce) {

    try {

      sessionStorage.setItem(`slots-pick-shown-${nonce}`, String(Date.now()));

    } catch {

      // Ignore storage errors in restricted embeds.

    }

  }



  function wasPickShown(nonce) {

    try {

      return Boolean(sessionStorage.getItem(`slots-pick-shown-${nonce}`));

    } catch {

      return false;

    }

  }



  function isRecentPick(state) {

    if (!state?.lastPick?.pickedAt) return false;

    const age = Date.now() - new Date(state.lastPick.pickedAt).getTime();

    return age >= 0 && age <= REPLAY_WINDOW_MS;

  }



  function shouldPlayPick(state, { force = false, allowRecent = false } = {}) {

    if (!state?.lastPick) return false;

    if (force) return true;

    if (state.pickNonce !== lastSeenNonce) return true;

    if (allowRecent && isRecentPick(state) && !wasPickShown(state.pickNonce)) return true;

    return false;

  }



  async function runPickAnimation(state) {

    if (!state.lastPick || spinning) return;

    spinning = true;

    markPickShown(state.pickNonce);

    lastSeenNonce = state.pickNonce;



    clearTimeout(resetTimer);

    stopIdlePromoSpin(reelInners);

    machine.classList.remove("idle-promo");

    machine.classList.add("spinning");

    machine.classList.remove("landed");

    document.querySelectorAll(".reel-column").forEach((column) => column.classList.remove("landed"));

    if (titleEl) titleEl.textContent = "Spinning...";

    if (subtitleEl) subtitleEl.textContent = "";



    await playTripleSlotSpin({

      reelInners,

      spinPool: state.lastPick.spinPool,

      winner: state.lastPick,

      durations: [3200, 4100, 5000],

      onReelLand(index) {

        if (titleEl && index === 2) titleEl.textContent = "Winner!";

      },

      onComplete(pick) {

        machine.classList.remove("spinning");

        machine.classList.add("landed");

        showWinnerState(pick);

      },

    });



    spinning = false;

    resetTimer = setTimeout(showIdleState, WINNER_DISPLAY_MS);

  }



  async function handleState(state, { force = false, allowRecent = false } = {}) {

    const forceReplay = force || params.get("replay") === "1" || params.get("demo") === "1";



    if (!initialized) {

      initialized = true;

      lastSeenNonce = state.pickNonce;

      showIdleState();

      if (shouldPlayPick(state, { force: forceReplay, allowRecent: false })) {

        await runPickAnimation(state);

      }

      return;

    }



    if (shouldPlayPick(state, { force: forceReplay, allowRecent: obsMode || allowRecent })) {

      await runPickAnimation(state);

    }

  }



  async function pollPick(options = {}) {

    try {

      const state = await fetchSlots();

      await handleState(state, options);

    } catch (error) {

      console.error("Slots pick alert error:", error);

    }

  }



  function connectEvents() {

    const source = new EventSource(API_SLOTS_EVENTS);



    source.onmessage = async (message) => {

      try {

        const payload = JSON.parse(message.data);

        if (payload.event !== "pick") return;

        await handleState(

          {

            pickNonce: payload.pickNonce,

            lastPick: payload.lastPick,

          },

          { allowRecent: true }

        );

      } catch (error) {

        console.error("Slots pick event error:", error);

      }

    };



    source.onerror = () => {

      source.close();

      setTimeout(connectEvents, 2000);

    };

  }



  const pollMs = embedMode ? POLL_MS_DEFAULT : obsMode ? POLL_MS_OBS : POLL_MS_DEFAULT;

  pollPick({ allowRecent: obsMode });

  setInterval(() => pollPick({ allowRecent: obsMode }), pollMs);

  if (!embedMode) connectEvents();

  startIdlePromoSpin(reelInners);

  machine.classList.add("idle-promo");



  document.addEventListener("visibilitychange", () => {

    if (!document.hidden) {

      pollPick({ allowRecent: true });

    }

  });



  window.addEventListener("focus", () => {

    pollPick({ allowRecent: true });

  });

}

