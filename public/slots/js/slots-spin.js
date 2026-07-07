const DEFAULT_AVATAR =
  "https://kick.com/img/default-profile-pictures/default-avatar-2.webp";
const STAKE_LOGO_SRC = "img/stake-us-logo.svg";
const TRIPLE_REEL_ITEM_HEIGHT = 118;
const IDLE_PROMO_WORDS = ["use", "code", "na5ty"];
const IDLE_FILLER_WORDS = ["use", "code", "na5ty", "stake", ".us", "spin"];
const IDLE_LAND_INTERVAL_MS = 30000;
const IDLE_LAND_HOLD_MS = 6500;
const IDLE_LAND_DURATIONS = [2600, 3400, 4200];
const IDLE_CONTINUOUS_DURATIONS = [4200, 5000, 5800];

let idleCycleActive = false;
let idleCycleGeneration = 0;
let idleLandTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatchIdlePhase(phase) {
  document.dispatchEvent(new CustomEvent("slots-idle-phase", { detail: { phase } }));
}

function renderStakeLogoItem(itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  return `
    <div class="reel-item avatar-reel idle-logo" style="height:${itemHeight}px">
      <img class="reel-logo" src="${STAKE_LOGO_SRC}" alt="stake.us">
    </div>
  `;
}

function renderIdleWordItem(word, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  const promoClass = word === "na5ty" ? " reel-promo-word-brand" : "";
  return `
    <div class="reel-item idle-word" style="height:${itemHeight}px">
      <span class="reel-promo-word${promoClass}">${escapeHtml(word)}</span>
    </div>
  `;
}

function renderIdleStripItem(entry, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  if (entry?.type === "logo") return renderStakeLogoItem(itemHeight);
  return renderIdleWordItem(entry.word || "", itemHeight);
}

function renderIdleStripItems(strip, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  return strip.map((entry) => renderIdleStripItem(entry, itemHeight)).join("");
}

function buildIdleLandStrip(heroWord, reelIndex = 0) {
  const pool = [
    { type: "logo" },
    { type: "word", word: "spin" },
    { type: "logo" },
    { type: "word", word: "stake" },
    { type: "word", word: ".us" },
    { type: "logo" },
    ...IDLE_FILLER_WORDS.filter((word) => word !== heroWord).map((word) => ({ type: "word", word })),
  ];
  const strip = [];
  const cycles = 4 + reelIndex;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const item of pool) {
      strip.push({ ...item });
    }
  }

  for (let i = 0; i < 4; i += 1) {
    strip.push({ ...pool[Math.floor(Math.random() * pool.length)] });
  }

  strip.push({ type: "word", word: heroWord });
  return strip;
}

function buildContinuousStrip(reelIndex = 0) {
  const pool = [
    { type: "logo" },
    { type: "logo" },
    { type: "word", word: "spin" },
    { type: "logo" },
    { type: "word", word: "stake" },
    { type: "logo" },
    { type: "word", word: ".us" },
  ];
  const strip = [];
  for (let i = 0; i < 18 + reelIndex * 2; i += 1) {
    strip.push({ ...pool[i % pool.length] });
  }
  return [...strip, ...strip];
}

function clearIdleSpinAnimation(reelInner) {
  if (!reelInner) return;
  const animName = reelInner.dataset.idleAnim;
  if (animName) {
    document.querySelectorAll(`style[data-idle-anim="${animName}"]`).forEach((node) => node.remove());
    delete reelInner.dataset.idleAnim;
  }
  reelInner.classList.remove("reel-inner-idle");
  reelInner.style.animation = "";
  reelInner.style.transition = "";
  reelInner.style.transform = "";
}

function stopIdlePromoSpin(reelInners) {
  idleCycleActive = false;
  idleCycleGeneration += 1;
  if (idleLandTimer) {
    clearTimeout(idleLandTimer);
    idleLandTimer = null;
  }
  for (const reelInner of reelInners || []) {
    clearIdleSpinAnimation(reelInner);
    reelInner.closest(".reel-column")?.classList.remove("landed");
  }
}

function startContinuousIdleSpin(reelInners, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  reelInners.forEach((reelInner, index) => {
    if (!reelInner) return;
    clearIdleSpinAnimation(reelInner);

    const strip = buildContinuousStrip(index);
    const loopHeight = (strip.length / 2) * itemHeight;
    const duration = IDLE_CONTINUOUS_DURATIONS[index] || IDLE_CONTINUOUS_DURATIONS[0];
    const animName = `idle-spin-${index}-${Date.now()}`;

    reelInner.innerHTML = renderIdleStripItems(strip, itemHeight);
    reelInner.dataset.idleAnim = animName;

    const styleEl = document.createElement("style");
    styleEl.dataset.idleAnim = animName;
    styleEl.textContent = `
      @keyframes ${animName} {
        from { transform: translateY(0); }
        to { transform: translateY(-${loopHeight}px); }
      }
    `;
    document.head.appendChild(styleEl);

    reelInner.style.transform = "translateY(0)";
    reelInner.style.animation = `${animName} ${duration}ms linear infinite`;
    reelInner.classList.add("reel-inner-idle");
    reelInner.closest(".reel-column")?.classList.remove("landed");
  });
}

async function runIdlePromoLand(reelInners, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  const reels = (reelInners || []).slice(0, 3);
  if (!reels.length) return;

  reels.forEach((reelInner) => clearIdleSpinAnimation(reelInner));
  document.querySelectorAll(".reel-column").forEach((column) => column.classList.remove("landed"));

  const strips = reels.map((_, index) => buildIdleLandStrip(IDLE_PROMO_WORDS[index] || "na5ty", index));
  reels.forEach((reelInner, index) => {
    reelInner.innerHTML = renderIdleStripItems(strips[index], itemHeight);
  });

  dispatchIdlePhase("land");

  await Promise.all(
    reels.map((reelInner, index) =>
      animateReel(
        reelInner,
        strips[index],
        itemHeight,
        IDLE_LAND_DURATIONS[index] || IDLE_LAND_DURATIONS[IDLE_LAND_DURATIONS.length - 1],
        0
      ).then(() => {
        reelInner.closest(".reel-column")?.classList.add("landed");
      })
    )
  );
}

async function idlePromoCycle(reelInners, itemHeight, generation) {
  while (idleCycleActive && generation === idleCycleGeneration) {
    await runIdlePromoLand(reelInners, itemHeight);
    if (!idleCycleActive || generation !== idleCycleGeneration) break;

    await sleep(IDLE_LAND_HOLD_MS);
    if (!idleCycleActive || generation !== idleCycleGeneration) break;

    dispatchIdlePhase("spin");
    startContinuousIdleSpin(reelInners, itemHeight);

    await sleep(IDLE_LAND_INTERVAL_MS);
    if (!idleCycleActive || generation !== idleCycleGeneration) break;
  }
}

function startIdlePromoSpin(reelInners, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  stopIdlePromoSpin(reelInners);
  idleCycleActive = true;
  idleCycleGeneration += 1;
  const generation = idleCycleGeneration;
  idlePromoCycle(reelInners, itemHeight, generation).catch(() => {});
}

function showIdleStakeReels(reelInners, itemHeight = TRIPLE_REEL_ITEM_HEIGHT) {
  startIdlePromoSpin(reelInners, itemHeight);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function normalizeEntry(entry) {
  if (typeof entry === "string") {
    return { username: entry, profilePicture: DEFAULT_AVATAR };
  }

  return {
    slotName: entry.slotName,
    username: entry.username,
    userId: entry.userId || null,
    profilePicture: entry.profilePicture || DEFAULT_AVATAR,
  };
}

function buildReelStrip(spinPool, winner) {
  const pool = spinPool?.length
    ? spinPool.map(normalizeEntry)
    : [normalizeEntry(winner)];

  const strip = [];
  const cycles = 4 + Math.floor(Math.random() * 2);

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const entry of pool) {
      strip.push(entry);
    }
  }

  for (let i = 0; i < pool.length + 2; i += 1) {
    strip.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  strip.push(normalizeEntry(winner));
  return strip;
}

function buildAvatarReelStrip(spinPool, winner, reelIndex = 0) {
  const pool = spinPool?.length
    ? spinPool.map(normalizeEntry)
    : [normalizeEntry(winner)];

  const strip = [];
  const cycles = 5 + reelIndex + Math.floor(Math.random() * 2);

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const entry of pool) {
      strip.push(entry);
    }
  }

  for (let i = 0; i < pool.length + 3; i += 1) {
    strip.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  strip.push(normalizeEntry(winner));
  return strip;
}

function renderAvatar(entry) {
  const safe = normalizeEntry(entry);
  return `
    <img
      class="reel-avatar"
      src="${escapeAttr(safe.profilePicture)}"
      alt="${escapeAttr(safe.username)}"
      loading="eager"
      onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}'"
    >
  `;
}

function renderReelItems(strip, itemHeight, { compact = false, avatarMode = false } = {}) {
  return strip
    .map((entry) => {
      const safe = normalizeEntry(entry);
      return `
        <div class="reel-item${compact ? " compact" : ""}${avatarMode ? " avatar-reel" : ""}" style="height:${itemHeight}px">
          ${
            avatarMode
              ? `${renderAvatar(safe)}
                 <span class="reel-user reel-user-small">${escapeHtml(safe.username)}</span>`
              : `<span class="reel-slot">${escapeHtml(safe.slotName || safe.username)}</span>
                 ${compact ? "" : `<span class="reel-user">${escapeHtml(safe.username)}</span>`}`
          }
        </div>
      `;
    })
    .join("");
}

function animateReel(reelInner, strip, itemHeight, duration, centerOffset = 0) {
  if (!reelInner) return Promise.resolve();

  const finalOffset = (strip.length - 1) * itemHeight - centerOffset;

  reelInner.style.transition = "none";
  reelInner.style.transform = "translateY(0)";

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fastDuration = Math.round(duration * 0.72);
        const slowDuration = duration - fastDuration;
        const fastOffset = Math.round(finalOffset * 0.88);

        reelInner.style.transition = `transform ${fastDuration}ms cubic-bezier(0.15, 0.9, 0.35, 1)`;
        reelInner.style.transform = `translateY(-${fastOffset}px)`;

        window.setTimeout(() => {
          reelInner.style.transition = `transform ${slowDuration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
          reelInner.style.transform = `translateY(-${finalOffset}px)`;

          window.setTimeout(resolve, slowDuration + 80);
        }, fastDuration);
      });
    });
  });
}

function playSlotSpin(options) {
  const {
    reelInner,
    spinPool,
    winner,
    itemHeight = 72,
    duration = 4200,
    onStart,
    onComplete,
    compact = false,
  } = options;

  if (!reelInner || !winner) return Promise.resolve();

  const strip = buildReelStrip(spinPool, winner);
  const centerOffset = itemHeight * (compact ? 0 : 1);

  reelInner.innerHTML = renderReelItems(strip, itemHeight, { compact });

  if (typeof onStart === "function") onStart();

  return animateReel(reelInner, strip, itemHeight, duration, centerOffset).then(() => {
    if (typeof onComplete === "function") onComplete(winner);
    return winner;
  });
}

function playTripleSlotSpin(options) {
  const {
    reelInners,
    spinPool,
    winner,
    itemHeight = TRIPLE_REEL_ITEM_HEIGHT,
    durations = [3200, 4100, 5000],
    onStart,
    onReelLand,
    onComplete,
  } = options;

  if (!reelInners?.length || !winner) return Promise.resolve();

  const reels = reelInners.slice(0, 3);
  while (reels.length < 3) reels.push(reels[0]);

  const strips = reels.map((_, index) => buildAvatarReelStrip(spinPool, winner, index));

  reels.forEach((reelInner, index) => {
    reelInner.innerHTML = renderReelItems(strips[index], itemHeight, { avatarMode: true });
  });

  if (typeof onStart === "function") onStart();

  return Promise.all(
    reels.map((reelInner, index) =>
      animateReel(reelInner, strips[index], itemHeight, durations[index] || durations[durations.length - 1], 0).then(
        () => {
          reelInner.closest(".reel-column")?.classList.add("landed");
          if (typeof onReelLand === "function") onReelLand(index, winner);
        }
      )
    )
  ).then(() => {
    if (typeof onComplete === "function") onComplete(winner);
    return winner;
  });
}
