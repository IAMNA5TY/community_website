const loginView = document.getElementById("login-view");
const dashboardView = document.getElementById("dashboard-view");
const errorBanner = document.getElementById("error-banner");
const mainNav = document.getElementById("main-nav");
const logoutBtn = document.getElementById("logout-btn");
const webhookNotice = document.getElementById("webhook-notice");
const statsGrid = document.getElementById("stats-grid");
const channelDetails = document.getElementById("channel-details");
const apiAccess = document.getElementById("api-access");
const workoutPreview = document.getElementById("workout-preview");
const obsUrlsTable = document.getElementById("obs-urls-table");
const embedCodes = document.getElementById("embed-codes");
const commandForm = document.getElementById("command-form");
const timerForm = document.getElementById("timer-form");
const testBotBtn = document.getElementById("test-bot-btn");
const leaderboardTabs = document.getElementById("leaderboard-tabs");

let dashboardData = null;
let sessionProfile = null;
let sessionRole = "player";
let leaderboardPeriod = "week";
let stakeAffiliatePeriod = "month";
let currentPage = "overview";
let dashboardRole = "owner";
let allowedPages = [
  "overview",
  "only-pixels",
  "discord",
  "workout",
  "slots",
  "drinking",
  "widgets",
  "lighting",
  "stake",
  "bot",
  "chat",
  "rewards",
  "leaderboard",
  "settings",
];
let hueDevicesCache = null;
let hueDevicesRequestId = 0;
let goveeDevicesCache = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showError(message) {
  if (!message) {
    errorBanner.classList.add("hidden");
    errorBanner.textContent = "";
    return;
  }
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function formatEventType(type) {
  return type
    .replace("channel.subscription.", "")
    .replaceAll(".", " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function formatStreamUptime(startedAt) {
  if (!startedAt) return null;
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  const totalMinutes = Math.floor(elapsedMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m live`;
  return `${minutes}m live`;
}

function formatStatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return value;
}

function renderTable(container, columns, rows, emptyText) {
  if (!rows?.length) {
    container.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>${columns.map((col) => `<th>${col.label}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) =>
              `<tr>${columns.map((col) => `<td>${col.render(row)}</td>`).join("")}</tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function applyNavAccess(me = {}) {
  dashboardRole = me.role || (me.isOwner ? "owner" : "player");
  if (Array.isArray(me.allowedPages) && me.allowedPages.length) {
    allowedPages = me.allowedPages.slice();
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    const page = link.dataset.page;
    link.classList.toggle("hidden", !allowedPages.includes(page));
  });

  document.querySelectorAll(".hub-card[data-page]").forEach((card) => {
    const page = card.dataset.page;
    card.classList.toggle("hidden", !allowedPages.includes(page));
  });

  document.querySelectorAll(".nav-group").forEach((group) => {
    const visible = [...group.querySelectorAll(".nav-link")].some(
      (link) => !link.classList.contains("hidden")
    );
    group.classList.toggle("hidden", !visible);
  });

  const hubSection = document.querySelector(".hub-section");
  if (hubSection) {
    const anyHub = [...document.querySelectorAll(".hub-card[data-page]")].some(
      (card) => !card.classList.contains("hidden")
    );
    hubSection.classList.toggle("hidden", !anyHub);
  }

  if (!allowedPages.includes(currentPage)) {
    currentPage = allowedPages.includes("only-pixels")
      ? "only-pixels"
      : allowedPages[0] || "overview";
  }
}

function closeMobileNav() {
  document.body.classList.remove("nav-open");
}

function openMobileNav() {
  document.body.classList.add("nav-open");
}

function filterHubCards(query = "") {
  const q = query.trim().toLowerCase();
  document.querySelectorAll(".hub-card[data-page]").forEach((card) => {
    const page = card.dataset.page;
    const allowed = !allowedPages.length || allowedPages.includes(page);
    if (!allowed) {
      card.classList.add("hidden");
      return;
    }
    const haystack = `${card.dataset.hubFilter || ""} ${card.textContent || ""}`.toLowerCase();
    card.classList.toggle("hidden", Boolean(q) && !haystack.includes(q));
  });
}

function showPage(page) {
  if (allowedPages.length && !allowedPages.includes(page)) {
    page = allowedPages.includes("only-pixels")
      ? "only-pixels"
      : allowedPages[0] || "overview";
  }
  currentPage = page;
  document.querySelectorAll(".page-view").forEach((section) => {
    section.classList.toggle("active", section.dataset.page === page);
  });
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === page);
  });
  closeMobileNav();
  if (page === "lighting" && dashboardData?.lighting?.hue?.connected) {
    ensureHueDevicesLoaded();
  }
  if (page === "widgets") {
    const chatStatusEl = document.getElementById("widgets-chat-status");
    if (chatStatusEl) refreshWidgetsChatStatus(chatStatusEl, dashboardData || {});
  }
  if (page === "settings") {
    refreshSignInLog();
  }
  if (page === "leaderboard") {
    refreshLeaderboards(true);
  }
  if (page === "only-pixels") {
    refreshOnlyPixels(dashboardData);
  }
  if (page === "discord") {
    refreshDiscordPanel(dashboardData);
  }
}

function renderStreamHero(data) {
  const hero = document.getElementById("stream-hero");
  if (!hero) return;

  const channel = data.channel || {};
  const profile = data.profile || {};
  const isLive = Boolean(channel.isLive);
  // Offline channel banners are full-width artwork — only use stream thumbnail when live.
  const thumb = isLive
    ? channel.thumbnail || channel.bannerImage
    : channel.categoryThumbnail || null;
  const uptime = isLive ? formatStreamUptime(channel.streamStartedAt) : null;
  const slug = channel.slug || profile.username || "channel";

  hero.innerHTML = `
    <div class="stream-hero__inner">
      <div class="stream-hero__media${thumb ? "" : " stream-hero__media--empty"}">
        ${thumb ? `<img class="stream-hero__thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />` : ""}
        <span class="stream-badge ${isLive ? "stream-badge--live" : "stream-badge--offline"}">
          ${isLive ? "Live" : "Offline"}
        </span>
      </div>
      <div class="stream-hero__body">
        <p class="eyebrow">${escapeHtml(profile.displayName || slug)} · kick.com/${escapeHtml(slug)}</p>
        <h1 class="stream-hero__title">${escapeHtml(channel.title || (isLive ? "Live now" : "Not streaming"))}</h1>
        <p class="subtitle stream-hero__meta">
          ${escapeHtml(channel.category || "No category")}
          ${uptime ? ` · ${escapeHtml(uptime)}` : ""}
        </p>
        ${
          isLive
            ? `<div class="stream-hero__viewers"><strong>${escapeHtml(channel.viewerCount ?? 0)}</strong> watching now</div>`
            : `<p class="subtitle" style="margin:0;">Go live on Kick and your stats update here automatically.</p>`
        }
      </div>
    </div>
  `;
}

function renderStats(data) {
  const channel = data.channel || {};
  const stats = data.chat?.stats || {};
  const items = [
    { label: "Active subs", value: channel.activeSubscribers ?? 0 },
    { label: "Canceled subs", value: channel.canceledSubscribers ?? 0 },
    { label: "Total streams", value: data.livestreamStats?.totalLivestreams ?? "—" },
    { label: "Chat messages", value: stats.totalMessages ?? 0 },
    { label: "Live viewers", value: channel.isLive ? channel.viewerCount ?? 0 : "Offline" },
    { label: "Rewards", value: data.rewards?.length ?? 0 },
  ];

  statsGrid.innerHTML = items
    .map(
      (item) => `
        <div class="stat-card">
          <div class="stat-label">${item.label}</div>
          <div class="stat-value">${escapeHtml(formatStatValue(item.value))}</div>
        </div>
      `
    )
    .join("");
}

function renderOverviewQuickLinks(data) {
  const container = document.getElementById("overview-obs-links");
  if (!container) return;

  const isOwner = data.role === "owner" || dashboardRole === "owner";
  if (!isOwner) {
    container.innerHTML =
      '<p class="subtitle">Open <strong>Only Pixels</strong> to submit a Streamer Rewards partnership application.</p>';
    return;
  }

  const links = [
    ["Chat box", data.widgetsUrls?.chatBox],
    ["Stream alerts", data.widgetsUrls?.streamAlerts],
    ["Slots timer", data.slotsUrls?.timer],
    ["Slots widget", data.slotsUrls?.widget],
    ["Now playing", data.widgetsUrls?.nowPlaying],
  ];

  renderObsUrlTable(container, links);
}

function renderChannelDetails(channel) {
  if (!channel) {
    channelDetails.innerHTML = `<div class="empty-state">Channel details unavailable.</div>`;
    return;
  }

  channelDetails.innerHTML = `
    <dl class="detail-list">
      <div><dt>Description</dt><dd>${escapeHtml(channel.description || "No description")}</dd></div>
      <div><dt>Language</dt><dd>${escapeHtml(channel.language || "Unknown")}</dd></div>
      <div><dt>Category</dt><dd>${escapeHtml(channel.category || "None")}</dd></div>
      <div><dt>Tags</dt><dd>${escapeHtml(channel.customTags?.join(", ") || "None")}</dd></div>
      <div><dt>Mature</dt><dd>${channel.isMature ? "Yes" : "No"}</dd></div>
    </dl>
  `;
}

function renderApiAccess(data) {
  const scopes = (data.token?.scopes || "").split(/[\s,]+/).filter(Boolean);
  const sources = Object.entries(data.apiSources || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `<li><strong>${escapeHtml(key)}</strong> · ${escapeHtml(value)}</li>`)
    .join("");

  apiAccess.innerHTML = `
    <dl class="detail-list">
      <div><dt>Token</dt><dd>${data.token?.active ? "Active" : "Inactive"}</dd></div>
      <div><dt>Expires</dt><dd>${data.token?.expiresAt ? new Date(data.token.expiresAt).toLocaleString() : "Unknown"}</dd></div>
      <div><dt>Scopes</dt><dd>${scopes.map((s) => `<span class="pill">${escapeHtml(s)}</span>`).join(" ") || "None"}</dd></div>
      <div><dt>APIs</dt><dd><ul class="plain-list">${sources || "<li>None</li>"}</ul></dd></div>
    </dl>
  `;
}

function renderSignInLog(entries) {
  const container = document.getElementById("sign-in-log-table");
  if (!container) return;

  renderTable(
    container,
    [
      {
        label: "User",
        render: (row) => {
          const name = row.displayName || row.username || row.broadcasterId || "Unknown";
          const avatar = row.profileImage
            ? `<img class="sign-in-avatar" src="${escapeHtml(row.profileImage)}" alt="" />`
            : "";
          return `${avatar}<div><strong>${escapeHtml(name)}</strong><br><span class="subtitle">@${escapeHtml(row.username || "unknown")} · ID ${escapeHtml(row.broadcasterId)}</span></div>`;
        },
      },
      {
        label: "When",
        render: (row) => (row.at ? new Date(row.at).toLocaleString() : "—"),
      },
      {
        label: "Status",
        render: (row) =>
          row.allowed
            ? '<span class="pill pill-ok">Allowed</span>'
            : '<span class="pill pill-warn">Blocked</span>',
      },
      {
        label: "IP",
        render: (row) => escapeHtml(row.ip || "—"),
      },
    ],
    entries,
    "No sign-ins recorded yet."
  );
}

async function refreshSignInLog() {
  const container = document.getElementById("sign-in-log-table");
  if (!container) return;

  const response = await fetch("/api/admin/sign-ins");
  if (!response.ok) {
    renderSignInLog([]);
    return;
  }

  const data = await response.json();
  renderSignInLog(data.entries || []);
}

function attrQuote(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderObsUrlTable(container, entries) {
  if (!container) return;

  const rows = entries.filter(([, url]) => url);
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No URLs available.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="url-table-wrap">
      <table class="data-table url-table">
        <thead>
          <tr><th>Overlay</th><th>URL for OBS</th><th></th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              ([label, url]) =>
                `<tr>
                  <td>${escapeHtml(label)}</td>
                  <td class="url-cell"><code class="url-text copyable-url" title="${attrQuote(url)}">${escapeHtml(url)}</code></td>
                  <td class="url-copy-cell">
                    <button class="btn btn-secondary btn-compact copy-url-btn" data-url="${attrQuote(url)}" type="button">Copy</button>
                  </td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function copyText(text, button) {
  const value = String(text || "").trim();
  if (!value) {
    showError("Nothing to copy");
    return;
  }

  const markCopied = () => {
    if (!button) return;
    const original = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  };

  const fallbackCopy = () => {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(input);
    input.focus();
    input.select();
    input.setSelectionRange(0, value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    input.remove();
    return ok;
  };

  const finish = (ok) => {
    if (ok) {
      markCopied();
      showError("");
      return;
    }
    showError("Could not copy — click the URL and press Ctrl+C");
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).then(() => finish(true)).catch(() => finish(fallbackCopy()));
    return;
  }

  finish(fallbackCopy());
}

function renderEmbedCodes() {
  if (!embedCodes) return;

  const origin = window.location.origin;
  const sceneUrl = `${origin}/workout/widget-scene.html`;
  const controlUrl = `${origin}/workout/control-panel.html?embed=1`;
  const startingSoonUrl = `${origin}/workout/starting-soon.html?obs=1`;
  const startingSoonPreview = `${origin}/workout/starting-soon-widget.html`;

  embedCodes.innerHTML = `
    <div class="embed-code-block">
      <h3>Starting soon (OBS 1920×1080)</h3>
      <div class="copy-row">
        <code class="embed-code">${escapeHtml(startingSoonUrl)}</code>
        <button class="btn btn-secondary btn-compact copy-url-btn" data-url="${attrQuote(startingSoonUrl)}" type="button">Copy</button>
      </div>
      <a class="embed-link" href="${escapeHtml(startingSoonPreview)}" target="_blank" rel="noopener">Open starting soon preview</a>
    </div>
    <div class="embed-code-block">
      <h3>Scene widget (16:9 preview)</h3>
      <div class="copy-row">
        <code class="embed-code">${escapeHtml(sceneUrl)}</code>
        <button class="btn btn-secondary btn-compact copy-url-btn" data-url="${attrQuote(sceneUrl)}" type="button">Copy</button>
      </div>
      <a class="embed-link" href="${escapeHtml(sceneUrl)}" target="_blank" rel="noopener">Open scene widget</a>
    </div>
    <div class="embed-code-block">
      <h3>Control panel widget</h3>
      <div class="copy-row">
        <code class="embed-code">${escapeHtml(controlUrl)}</code>
        <button class="btn btn-secondary btn-compact copy-url-btn" data-url="${attrQuote(controlUrl)}" type="button">Copy</button>
      </div>
      <a class="embed-link" href="${escapeHtml(controlUrl)}" target="_blank" rel="noopener">Open control widget</a>
    </div>
  `;
}

function renderWorkout(workout, obsUrls) {
  if (!workoutPreview) return;

  const name = workout?.walkName || workout?.streamerName || "Nasty";
  const minutes = workout?.minutesBank ?? 0;
  const running = workout?.isRunning ? " · timer running" : "";
  const lastGood = Number(workout?.lastGoodMinutes) || 0;
  let text = `${name} owes ${minutes} minute${minutes === 1 ? "" : "s"} on the treadmill${running}`;
  if (minutes === 0 && lastGood > 0) {
    text += ` · last saved bank: ${lastGood} (use Restore last bank in the control panel)`;
  }
  workoutPreview.textContent = text;

  const hostNote = document.getElementById("obs-host-note");
  if (hostNote && dashboardData?.obsHostNote) {
    hostNote.textContent = dashboardData.obsHostNote;
  }

  renderEmbedCodes();

  if (obsUrlsTable && obsUrls) {
    renderObsUrlTable(obsUrlsTable, [
      ["Starting soon (OBS)", obsUrls.startingSoon],
      ["Starting soon preview", obsUrls.startingSoonWidget],
      ["Scene widget (embed)", obsUrls.sceneWidget],
      ["Control widget (embed)", obsUrls.controlWidget],
      ["Full scene (OBS)", obsUrls.scene],
      ["Control panel (full page)", obsUrls.controlPanel],
      ["Treadmill tracker", obsUrls.treadmill],
      ["Workout stats", obsUrls.stats],
      ["Rules banner", obsUrls.rules],
      ["Sub alert", obsUrls.subAlert],
    ]);
  }
}

function renderCommandsTable(commands) {
  renderTable(
    document.getElementById("commands-table"),
    [
      { label: "Trigger", render: (row) => `<code>${escapeHtml(row.trigger)}</code>` },
      { label: "Response", render: (row) => escapeHtml(row.response) },
      {
        label: "Actions",
        render: (row) =>
          `<button class="btn btn-secondary btn-compact delete-command" data-id="${escapeHtml(row.id)}" type="button">Delete</button>`,
      },
    ],
    commands,
    "No commands yet."
  );
}

function renderTimersTable(timers) {
  renderTable(
    document.getElementById("timers-table"),
    [
      { label: "Interval", render: (row) => `${escapeHtml(row.intervalMinutes)} min` },
      { label: "Message", render: (row) => escapeHtml(row.message) },
      { label: "Status", render: (row) => `<span class="pill">${row.enabled ? "Running" : "Paused"}</span>` },
      {
        label: "Actions",
        render: (row) => `
          <button class="btn btn-secondary btn-compact toggle-timer" data-id="${escapeHtml(row.id)}" data-enabled="${row.enabled ? "false" : "true"}" type="button">${row.enabled ? "Pause" : "Enable"}</button>
          <button class="btn btn-secondary btn-compact delete-timer" data-id="${escapeHtml(row.id)}" type="button">Delete</button>
        `,
      },
    ],
    timers,
    "No timers yet."
  );
}

function renderMessagesTable(messages) {
  renderTable(
    document.getElementById("messages-table"),
    [
      { label: "User", render: (row) => escapeHtml(row.username) },
      { label: "Message", render: (row) => escapeHtml(row.content) },
      { label: "Time", render: (row) => new Date(row.createdAt).toLocaleString() },
    ],
    messages,
    "No chat messages captured yet."
  );
}

function renderSubsTable(subs) {
  renderTable(
    document.getElementById("subs-table"),
    [
      { label: "User", render: (row) => escapeHtml(row.username) },
      { label: "Event", render: (row) => escapeHtml(formatEventType(row.type)) },
      { label: "Qty", render: (row) => escapeHtml(row.quantity || 1) },
      { label: "Time", render: (row) => new Date(row.createdAt).toLocaleString() },
    ],
    subs,
    "No sub events captured yet."
  );
}

function renderRewardsTable(rewards) {
  renderTable(
    document.getElementById("rewards-table"),
    [
      { label: "Title", render: (row) => escapeHtml(row.title) },
      { label: "Cost", render: (row) => `${escapeHtml(row.cost)} pts` },
      { label: "Status", render: (row) => `<span class="pill">${row.isEnabled ? "Enabled" : "Disabled"}</span>` },
      { label: "Description", render: (row) => escapeHtml(row.description || "") },
    ],
    rewards,
    "No channel rewards found."
  );
}

function renderRedemptionsTable(containerId, items, emptyText) {
  renderTable(
    document.getElementById(containerId),
    [
      { label: "Reward", render: (row) => escapeHtml(row.rewardTitle) },
      { label: "Input", render: (row) => escapeHtml(row.userInput || "—") },
      { label: "Status", render: (row) => `<span class="pill">${escapeHtml(row.status)}</span>` },
      { label: "Time", render: (row) => new Date(row.redeemedAt).toLocaleString() },
    ],
    items,
    emptyText
  );
}

function renderSubscriptionsTable(subscriptions) {
  renderTable(
    document.getElementById("subscriptions-table"),
    [
      { label: "Event", render: (row) => `<code>${escapeHtml(row.event)}</code>` },
      { label: "Method", render: (row) => escapeHtml(row.method) },
      { label: "Version", render: (row) => escapeHtml(row.version) },
      { label: "Created", render: (row) => new Date(row.createdAt).toLocaleString() },
    ],
    subscriptions,
    "No webhook subscriptions found."
  );
}

function renderLeaderboardTable(entries, meta = {}) {
  const subtitle = document
    .getElementById("leaderboard-table")
    ?.closest(".card")
    ?.querySelector(".subtitle");
  if (subtitle) {
    subtitle.textContent = meta.error
      ? `Could not load KICKs leaderboard (${meta.error})`
      : "Top KICKs gifters on your channel";
  }

  renderTable(
    document.getElementById("leaderboard-table"),
    [
      { label: "Rank", render: (row) => `#${escapeHtml(row.rank)}` },
      { label: "Username", render: (row) => escapeHtml(row.username) },
      { label: "User ID", render: (row) => escapeHtml(row.user_id) },
      { label: "KICKs", render: (row) => escapeHtml(row.gifted_amount) },
    ],
    entries,
    "No KICKs leaderboard data yet."
  );
}

function renderGiftedSubLeaderboardTable(entries, meta = {}) {
  const noteEl = document.getElementById("gifted-sub-leaderboard-note");
  if (noteEl) {
    if (meta.source === "kick.com" && !meta.error) {
      noteEl.textContent = meta.stale
        ? "Showing cached gifted sub data — live refresh failed, retrying soon"
        : "Top gifted subscription supporters — same data as Kick’s channel leaderboard";
    } else if (meta.error) {
      noteEl.textContent = `Could not load from Kick (${meta.error})`;
    } else {
      noteEl.textContent = "Top gifted subscription supporters";
    }
  }

  renderTable(
    document.getElementById("gifted-sub-leaderboard-table"),
    [
      { label: "Rank", render: (row) => `#${escapeHtml(row.rank)}` },
      { label: "Username", render: (row) => escapeHtml(row.username) },
      { label: "User ID", render: (row) => escapeHtml(row.user_id) },
      { label: "Gifted subs", render: (row) => escapeHtml(row.quantity ?? row.gifted_amount) },
    ],
    entries,
    "No gifted sub leaderboard data yet."
  );
}

function renderLeaderboards(data) {
  const period = leaderboardPeriod;
  renderLeaderboardTable(data.leaderboard?.[period] || [], { error: data.leaderboard?.error });
  renderGiftedSubLeaderboardTable(data.giftedSubLeaderboard?.[period] || [], {
    source: data.giftedSubLeaderboard?.source,
    error: data.giftedSubLeaderboard?.error,
    stale: data.giftedSubLeaderboard?.stale,
  });

  const updatedEl = document.getElementById("leaderboard-updated-at");
  if (updatedEl) {
    const stamp =
      data.giftedSubLeaderboard?.updatedAt || data.leaderboardUpdatedAt || null;
    updatedEl.textContent = stamp
      ? `Last updated ${new Date(stamp).toLocaleString()}`
      : "";
  }
}

async function refreshLeaderboards(force = false) {
  const response = await fetch(`/api/leaderboards${force ? "?refresh=1" : ""}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    showError(error.error || "Failed to refresh leaderboards");
    return;
  }

  const payload = await response.json();
  dashboardData = dashboardData || {};
  dashboardData.leaderboard = payload.leaderboard;
  dashboardData.giftedSubLeaderboard = payload.giftedSubLeaderboard;
  dashboardData.leaderboardUpdatedAt = payload.updatedAt;
  renderLeaderboards(dashboardData);
  showError("");
}

function formatSlotsTimer(seconds) {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getSlotsTimerSeconds(timer) {
  if (timer?.isRunning && timer?.timerEndAt) {
    return Math.max(0, Math.ceil((timer.timerEndAt - Date.now()) / 1000));
  }
  return timer?._secondsLeft || (timer?.minutesBank || 0) * 60;
}

function renderSlotsTimer(timer) {
  const statusEl = document.getElementById("slots-timer-status");
  if (!statusEl || !timer) return;

  const seconds = getSlotsTimerSeconds(timer);
  const goal = timer.dailyGoalMinutes || 60;
  const progress = Math.min(100, Math.round(((goal * 60 - seconds) / (goal * 60)) * 100));

  if (timer.isRunning) {
    statusEl.textContent = `Running — ${formatSlotsTimer(seconds)} remaining · ${progress}% of daily goal`;
  } else if (seconds > 0) {
    statusEl.textContent = `Paused at ${formatSlotsTimer(seconds)} · ${progress}% of ${goal} min goal`;
  } else {
    statusEl.textContent = `No time banked — set 1 hour and hit Start (${goal} min daily goal)`;
  }
}

async function refreshWidgetsChatStatus(chatStatusEl, webhook = {}) {
  if (webhook.webhookNote) {
    chatStatusEl.textContent = webhook.webhookNote;
    chatStatusEl.className = "subtitle err";
    return;
  }

  try {
    const [healthRes, hookRes] = await Promise.all([
      fetch("/api/webhooks/health"),
      fetch("/api/webhooks/status").catch(() => null),
    ]);
    const health = healthRes.ok ? await healthRes.json() : null;
    const hookStatus = hookRes?.ok ? await hookRes.json() : null;

    if (health?.messageCount > 0) {
      chatStatusEl.textContent = `Chat live — ${health.messageCount} message(s) on server. OBS should match.`;
      chatStatusEl.className = "subtitle ok";
      return;
    }

    if (health?.chatWebhookActive && health?.debug?.totalHits === 0) {
      chatStatusEl.textContent =
        "Subscribed but Kick has not sent webhooks since last deploy — type in chat, then open Chat debug.";
      chatStatusEl.className = "subtitle";
      return;
    }

    if (health?.debug?.totalRejected > 0) {
      chatStatusEl.textContent =
        `Webhooks rejected (${health.debug.lastRejection?.reason || "unknown"}) — open Chat debug for details.`;
      chatStatusEl.className = "subtitle err";
      return;
    }

    if (health?.chatWebhookActive) {
      chatStatusEl.textContent =
        "Kick chat webhook is active — type in Kick chat or use Send test chat.";
      chatStatusEl.className = "subtitle ok";
      return;
    }

    if (health?.subscriptionError) {
      chatStatusEl.textContent = `Webhook check failed: ${health.subscriptionError}`;
      chatStatusEl.className = "subtitle err";
      return;
    }

    if (!health?.kickSignedInOnServer) {
      chatStatusEl.textContent =
        "Sign in with Kick — webhooks register automatically on login.";
      chatStatusEl.className = "subtitle err";
      return;
    }

    chatStatusEl.textContent =
      `Set Kick Developer → Enable Webhooks → Webhook URL to ${health?.webhookUrl || "https://na5ty.com/webhooks/kick"} (not Redirect URLs), then sign in again.`;
    chatStatusEl.className = "subtitle err";
  } catch {
    chatStatusEl.textContent =
      "Sign in at na5ty.com → Widgets → Send test chat to verify OBS chat.";
    chatStatusEl.className = "subtitle";
  }
}

function renderWidgets(widgetsUrls, spotify = {}, webhook = {}) {
  const urlsTable = document.getElementById("widgets-urls-table");
  if (urlsTable && widgetsUrls) {
    renderObsUrlTable(urlsTable, [
      ["Kick chat box (OBS)", widgetsUrls.chatBox],
      ["Stream alerts — follows, subs, kicks (OBS)", widgetsUrls.streamAlerts],
      ["Now playing — Spotify (OBS)", widgetsUrls.nowPlaying],
    ]);
  }

  const chatStatusEl = document.getElementById("widgets-chat-status");
  if (chatStatusEl) {
    refreshWidgetsChatStatus(chatStatusEl, webhook);
  }

  const statusEl = document.getElementById("spotify-status");
  const redirectEl = document.getElementById("spotify-redirect-uri");
  const connectBtn = document.getElementById("spotify-connect-btn");
  const disconnectBtn = document.getElementById("spotify-disconnect-btn");

  if (redirectEl && spotify.redirectUri) {
    const onLocalhost = location.hostname === "localhost";
    let extra = "";
    if (onLocalhost) {
      extra =
        "<br>You can stay on <strong>localhost</strong> for the dashboard — only Spotify’s callback uses 127.0.0.1.";
    }
    redirectEl.innerHTML =
      `In <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify Developer Dashboard</a> → your app → Settings → Redirect URIs, add exactly:<br><code>${escapeHtml(spotify.redirectUri)}</code> then click <strong>Save</strong>.${extra}`;
  }

  if (statusEl) {
    if (!spotify.configured) {
      statusEl.textContent =
        "Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env, then restart the server.";
    } else if (!spotify.connected) {
      statusEl.textContent =
        "Connect Spotify (Premium required). Keep Spotify open on your stream PC while live.";
    } else {
      const track = spotify.playback?.track;
      statusEl.textContent = track
        ? `Connected as ${spotify.displayName || "Spotify"} — now playing: ${track.name}`
        : `Connected as ${spotify.displayName || "Spotify"} — open Spotify on your PC and press play`;
    }
  }

  if (connectBtn && disconnectBtn) {
    const showConnect = spotify.configured && !spotify.connected;
    connectBtn.classList.toggle("hidden", !showConnect);
    disconnectBtn.classList.toggle("hidden", !spotify.connected);
  }
}

function renderLighting(lighting = {}) {
  const hue = lighting.hue || {};
  const statusEl = document.getElementById("hue-status");
  const disconnectBtn = document.getElementById("hue-disconnect-btn");
  const connectBtn = document.getElementById("hue-connect-btn");
  const discoverBtn = document.getElementById("hue-discover-btn");
  const ipInput = document.getElementById("hue-bridge-ip");
  const devicesPanel = document.getElementById("hue-devices-panel");

  if (statusEl) {
    if (hue.connected) {
      statusEl.textContent = hue.bridgeName
        ? `Connected to ${hue.bridgeName} (${hue.bridgeIp})`
        : `Connected to Hue Bridge at ${hue.bridgeIp}`;
    } else {
      statusEl.textContent =
        "Enter your bridge IP (192.168.1.177), press the link button on the bridge, then click Connect.";
    }
  }

  if (ipInput && !ipInput.value) {
    ipInput.value = hue.bridgeIp || hue.defaultBridgeIp || "192.168.1.177";
  }

  if (disconnectBtn) disconnectBtn.classList.toggle("hidden", !hue.connected);
  if (discoverBtn) discoverBtn.classList.toggle("hidden", hue.connected);
  if (connectBtn) connectBtn.classList.toggle("hidden", hue.connected);
  if (ipInput) ipInput.classList.toggle("hidden", hue.connected);
  if (devicesPanel) devicesPanel.classList.toggle("hidden", !hue.connected);

  if (!hue.connected) {
    hueDevicesCache = null;
  } else {
    if (currentPage === "lighting") {
      ensureHueDevicesLoaded();
      if (!goveeDevicesCache && dashboardData?.lighting?.govee?.knownDevices?.length) {
        refreshGoveeDevices();
      }
    }
  }

  renderSpotifySync(lighting.sync || {}, hue);
  renderGovee(lighting.govee || {});
  renderLightingLayout(lighting.layout || {});
}

let lightingLayoutDraft = null;
let lightingLayoutDrag = null;
let lightingLayoutSelectedId = null;

function setLightingLayoutSelection(lightId) {
  lightingLayoutSelectedId = lightId || null;
  document.querySelectorAll(".lighting-layout-marker").forEach((marker) => {
    marker.classList.toggle("is-selected", marker.dataset.lightId === lightId);
  });

  const splitBtn = document.getElementById("lighting-layout-split-btn");
  if (!splitBtn || !lightingLayoutDraft) return;
  const light = lightingLayoutDraft.lights.find((entry) => entry.id === lightId);
  const sku = light?.ref?.split(":")[0] || "";
  const rgbicStrip =
    /^H619[D-Z0-9]/i.test(sku) ||
    /^H614[3-6A-Z]/i.test(sku) ||
    /^H616[38]/i.test(sku) ||
    /^H6171/i.test(sku) ||
    /^H61/i.test(sku);
  const canSplit =
    light?.source === "govee" &&
    Number(light.stripCount || 1) <= 1 &&
    !String(light.id).includes("#strip") &&
    rgbicStrip;
  splitBtn.disabled = !canSplit;
}

function setLightingLayoutHint(message) {
  const hint = document.getElementById("lighting-layout-hint");
  if (hint) hint.textContent = message || "";
}

function clearLightingLayoutMapClasses() {
  document.querySelectorAll(".lighting-layout-marker").forEach((marker) => {
    marker.classList.remove(
      "map-blue",
      "map-red",
      "map-green",
      "map-orange",
      "map-purple",
      "map-cyan",
      "map-blue-red"
    );
  });
}

function highlightLightingLayoutMap(assignments = []) {
  clearLightingLayoutMapClasses();
  for (const entry of assignments) {
    const marker = document.querySelector(
      `.lighting-layout-marker[data-light-id="${CSS.escape(entry.lightId)}"]`
    );
    if (!marker) continue;
    const className =
      entry.colorKey === "blue+red" ? "map-blue-red" : `map-${entry.colorKey}`;
    marker.classList.add(className);
  }
}

function formatMapLegend(assignments = []) {
  if (!assignments.length) return "";
  return assignments
    .map((entry) => {
      const place = entry.note ? ` (${entry.note})` : "";
      return `${entry.name} = ${entry.colorName}${place}`;
    })
    .join(" · ");
}

function renderLightingLayout(layout = {}) {
  lightingLayoutDraft = {
    flashPattern: layout.flashPattern || "unison",
    lights: (layout.lights || []).map((light) => ({ ...light })),
  };

  const patternEl = document.getElementById("lighting-layout-pattern");
  if (patternEl) patternEl.value = lightingLayoutDraft.flashPattern;

  const statusEl = document.getElementById("lighting-layout-status");
  if (statusEl) {
    statusEl.textContent = lightingLayoutDraft.lights.length
      ? `${lightingLayoutDraft.lights.length} lights mapped · pattern: ${lightingLayoutDraft.flashPattern}`
      : "Drag lights to match your room — beat sync uses this map";
  }

  const stage = document.getElementById("lighting-layout-stage");
  if (!stage) return;

  stage.querySelectorAll(".lighting-layout-marker").forEach((marker) => marker.remove());

  if (!lightingLayoutDraft.lights.length) {
    setLightingLayoutHint("Click Sync from devices after saving Hue + Govee selections above.");
    return;
  }

  setLightingLayoutHint(
    "Color map = each light a different color (blue top / red bottom on dual strips). Click a dot = red identify."
  );

  for (const light of lightingLayoutDraft.lights) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `lighting-layout-marker is-${light.source}`;
    if (light.id === lightingLayoutSelectedId) {
      marker.classList.add("is-selected");
    }
    marker.style.left = `${light.x}%`;
    marker.style.top = `${light.y}%`;
    marker.dataset.lightId = light.id;
    marker.title = "Click to identify (red flash) · drag to move";
    const stripLabel =
      Number(light.stripCount) > 1
        ? `<span class="lighting-layout-marker__strip">strip ${Number(light.stripPart) + 1}/${light.stripCount}</span>`
        : "";
    marker.innerHTML = `${escapeHtml(light.name)}${stripLabel}<span class="lighting-layout-marker__order">#${Number(light.order) + 1}</span>`;
    marker.addEventListener("pointerdown", (event) => startLightingLayoutDrag(event, light.id));
    stage.appendChild(marker);
  }

  setLightingLayoutSelection(lightingLayoutSelectedId);
}

function startLightingLayoutDrag(event, lightId) {
  if (!lightingLayoutDraft) return;
  const stage = document.getElementById("lighting-layout-stage");
  const light = lightingLayoutDraft.lights.find((entry) => entry.id === lightId);
  if (!stage || !light) return;

  event.preventDefault();
  const marker = event.currentTarget;
  marker.setPointerCapture(event.pointerId);
  marker.classList.add("is-dragging");
  lightingLayoutDrag = { lightId, pointerId: event.pointerId };
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;

  const onMove = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    if (Math.abs(moveEvent.clientX - startX) > 5 || Math.abs(moveEvent.clientY - startY) > 5) {
      moved = true;
    }
    const rect = stage.getBoundingClientRect();
    const x = ((moveEvent.clientX - rect.left) / rect.width) * 100;
    const y = ((moveEvent.clientY - rect.top) / rect.height) * 100;
    light.x = Math.max(2, Math.min(98, Math.round(x)));
    light.y = Math.max(8, Math.min(92, Math.round(y)));
    marker.style.left = `${light.x}%`;
    marker.style.top = `${light.y}%`;
  };

  const onUp = (upEvent) => {
    if (upEvent.pointerId !== event.pointerId) return;
    marker.releasePointerCapture(event.pointerId);
    marker.classList.remove("is-dragging");
    lightingLayoutDrag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    setLightingLayoutSelection(lightId);
    if (!moved) {
      identifyLightingLight(lightId, marker);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

async function readApiJson(response) {
  const text = await response.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: {}, text };
  }
}

function layoutApiError(response, data, text) {
  if (data?.error) return data.error;
  if (response.status === 404) {
    return "Server needs a restart — stop and start the dashboard (npm start) to load Color map / Identify.";
  }
  if (response.status === 401) return "Sign in with Kick again.";
  return text?.slice(0, 140) || `Request failed (${response.status})`;
}

async function identifyLightingLight(lightId, marker) {
  await saveLightingLayout();
  marker?.classList.add("is-identifying");
  setLightingLayoutHint("Flashing colors — watch which physical light matches…");
  const response = await fetch("/api/lighting/layout/identify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lightId, holdMs: 4000 }),
  });
  const { data, text } = await readApiJson(response);
  marker?.classList.remove("is-identifying");
  if (!response.ok) {
    setLightingLayoutHint(layoutApiError(response, data, text));
    return;
  }
  setLightingLayoutHint(`${data.name || "Light"} mapped. Click another dot or use Color map for all.`);
}

async function saveLightingLayout() {
  if (!lightingLayoutDraft) return null;
  const patternEl = document.getElementById("lighting-layout-pattern");
  const response = await fetch("/api/lighting/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      flashPattern: patternEl?.value || lightingLayoutDraft.flashPattern,
      lights: lightingLayoutDraft.lights,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setLightingLayoutHint(data.error || "Could not save layout");
    return null;
  }
  if (dashboardData?.lighting) {
    dashboardData.lighting.layout = data;
  }
  renderLightingLayout(data);
  setLightingLayoutHint("Layout saved.");
  return data;
}

function setGoveeTestStatus(message) {
  const statusEl = document.getElementById("govee-test-status");
  if (statusEl) statusEl.textContent = message || "";
}

function renderGoveeDevicesPanel(data = {}) {
  const table = document.getElementById("govee-devices-table");
  if (!table) return;

  const devices = data.devices || [];
  const selected = new Set((data.selectedDevices || []).map((entry) => entry.key));

  renderTable(
    table,
    [
      {
        label: "",
        render: (row) =>
          `<input type="checkbox" class="govee-device-pick" data-device-key="${escapeHtml(row.key)}"${selected.has(row.key) ? " checked" : ""} />`,
      },
      { label: "Name", render: (row) => escapeHtml(row.name || row.sku) },
      { label: "Model", render: (row) => escapeHtml(row.sku) },
      { label: "IP", render: (row) => escapeHtml(row.ip || "—") },
    ],
    devices,
    "No Govee devices yet. Enable LAN Control in the Govee app, then click Scan LAN."
  );
}

function renderGovee(govee = {}) {
  const statusEl = document.getElementById("govee-status");
  const scanIpsInput = document.getElementById("govee-scan-ips");

  if (statusEl) {
    if (govee.listener?.initError || govee.portConflict) {
      statusEl.textContent = govee.listener?.initError || "UDP port 4002 conflict — close GoveeLAN on this PC";
    } else if (govee.lastScanError) {
      statusEl.textContent = `Scan issue: ${govee.lastScanError}`;
    } else if (govee.knownDevices?.length) {
      const selected = govee.selectedDevices?.length || 0;
      statusEl.textContent = `${govee.knownDevices.length} LAN device(s) found · ${selected} selected`;
    } else {
      statusEl.textContent = "GoveeLAN — scan your network to find lights";
    }
  }

  if (scanIpsInput && govee.scanIps?.length && !scanIpsInput.value) {
    scanIpsInput.value = govee.scanIps.join(", ");
  }

  if (goveeDevicesCache) {
    renderGoveeDevicesPanel(goveeDevicesCache);
  } else if (govee.knownDevices?.length) {
    goveeDevicesCache = {
      devices: govee.knownDevices,
      selectedDevices: govee.selectedDevices || [],
    };
    renderGoveeDevicesPanel(goveeDevicesCache);
  }
}

async function refreshGoveeDevices() {
  const response = await fetch("/api/lighting/govee/devices");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setGoveeTestStatus(data.error || "Could not load Govee devices");
    return null;
  }
  goveeDevicesCache = data;
  renderGoveeDevicesPanel(data);
  if (dashboardData?.lighting) {
    dashboardData.lighting.govee = {
      ...dashboardData.lighting.govee,
      knownDevices: data.devices,
      selectedDevices: data.selectedDevices,
      scanIps: data.scanIps,
      lastScanAt: data.lastScanAt,
      lastScanError: data.lastScanError,
      connected: Boolean(data.devices?.length),
    };
    renderGovee(dashboardData.lighting.govee);
  }
  return data;
}

function getSelectedGoveeKeys() {
  return [...document.querySelectorAll(".govee-device-pick:checked")].map((el) => el.dataset.deviceKey);
}

function renderSpotifySync(sync = {}, hue = {}) {
  const moodEl = document.getElementById("spotify-sync-mood");
  const beatEl = document.getElementById("spotify-sync-beat");
  const audioEl = document.getElementById("spotify-sync-audio");
  const runtimeEl = document.getElementById("spotify-sync-runtime");
  const statusEl = document.getElementById("spotify-sync-status");
  const bpmLabel = document.getElementById("spotify-sync-bpm-label");
  const phaseLabel = document.getElementById("spotify-sync-phase-label");
  const audioLabel = document.getElementById("spotify-sync-audio-label");
  const panel = document.getElementById("spotify-lighting-sync-panel");

  if (!panel) return;

  if (moodEl) moodEl.checked = Boolean(sync.moodEnabled);
  if (beatEl) beatEl.checked = Boolean(sync.beatEnabled);
  if (audioEl) audioEl.checked = sync.audioSyncEnabled !== false;
  if (bpmLabel) {
    const offset = Number(sync.bpmOffset) || 0;
    bpmLabel.textContent = offset === 0 ? "0 offset" : `${offset > 0 ? "+" : ""}${offset} BPM`;
  }
  if (phaseLabel) {
    const phase = Number(sync.beatPhaseMs) || 0;
    phaseLabel.textContent = phase === 0 ? "0 ms" : `${phase > 0 ? "+" : ""}${phase} ms`;
  }
  if (audioLabel) {
    audioLabel.textContent = String(Number(sync.audioSensitivity) || 6);
  }

  const runtime = sync.runtime || {};
  const audio = runtime.audio || {};
  let statusText = "Concert mode — lights flash on drops, stay dark between hits";
  if (!hue.connected) {
    statusText = "Connect Hue above to enable Spotify lighting sync.";
  } else if (!sync.ready) {
    statusText = "Connect Spotify on the Widgets tab to enable sync.";
  } else if (runtime.error) {
    statusText = runtime.error;
  } else if (audio.error && sync.audioSyncEnabled !== false && sync.beatEnabled) {
    statusText = `Audio: ${audio.error}`;
  } else if (runtime.lightsChatMuted) {
    statusText = "Lights muted via chat (!lightsoff) — music only, no beat sync";
  } else if (runtime.status === "playing" && runtime.trackName) {
    const modeLabel = runtime.mode === "wild" ? "WILD" : "DROP";
    const audioTag = audio.running
      ? audio.hasSignal
        ? " · audio beats"
        : " · BPM clock (no audio — check Stereo Mix)"
      : sync.audioSyncEnabled !== false
        ? " · BPM"
        : "";
    statusText = `${modeLabel}: ${runtime.trackName}${runtime.bpm ? ` @ ${runtime.bpm} BPM` : ""}${audioTag}`;
  } else if (runtime.status === "paused" && runtime.trackName) {
    statusText = `Paused — ${runtime.trackName}`;
  } else if (sync.moodEnabled || sync.beatEnabled) {
    statusText = "Waiting for Spotify playback…";
  }

  if (statusEl) statusEl.textContent = statusText;

  if (runtimeEl) {
    const parts = [];
    if (runtime.lightsChatMuted) parts.push("chat: lights off");
    if (sync.beatEnabled) parts.push(runtime.mode === "wild" ? "Wild mode" : "Drop mode");
    if (sync.audioSyncEnabled !== false && sync.beatEnabled) {
      if (audio.running) {
        parts.push(
          audio.hasSignal
            ? `Audio: ${audio.device || "listening"} (${audio.signalLevel || 0})`
            : `Audio quiet (${audio.signalLevel || 0}) — using BPM`
        );
      } else {
        parts.push("Audio off");
      }
      if (audio.beatsDetected) parts.push(`${audio.beatsDetected} audio beats`);
    }
    if (sync.moodEnabled) parts.push("Palette on");
    if (!sync.moodEnabled && !sync.beatEnabled) parts.push("Sync off");
    if (runtime.profileSource === "preset") parts.push("preset");
    if (runtime.profileSource === "saved") parts.push("calibrated");
    if (runtime.bpm) parts.push(`${runtime.bpm} BPM`);
    if (runtime.hits) parts.push(`${runtime.hits} hits`);
    if (runtime.lastSyncAt) {
      parts.push(`tick ${new Date(runtime.lastSyncAt).toLocaleTimeString()}`);
    }
    runtimeEl.textContent = parts.join(" · ");
  }
}

async function saveSpotifySyncSettings(patch = {}) {
  const moodEnabled = Boolean(
    patch.moodEnabled ?? document.getElementById("spotify-sync-mood")?.checked
  );
  const beatEnabled = Boolean(
    patch.beatEnabled ?? document.getElementById("spotify-sync-beat")?.checked
  );
  const audioSyncEnabled = Boolean(
    patch.audioSyncEnabled ?? document.getElementById("spotify-sync-audio")?.checked
  );
  const bpmOffset = Number(
    patch.bpmOffset ?? dashboardData?.lighting?.sync?.bpmOffset ?? 0
  );
  const beatPhaseMs = Number(
    patch.beatPhaseMs ?? dashboardData?.lighting?.sync?.beatPhaseMs ?? 0
  );
  const audioSensitivity = Number(
    patch.audioSensitivity ?? dashboardData?.lighting?.sync?.audioSensitivity ?? 6
  );

  const response = await fetch("/api/lighting/sync/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      moodEnabled,
      beatEnabled,
      bpmOffset,
      beatPhaseMs,
      audioSyncEnabled,
      audioSensitivity,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Could not save sync settings");
    return null;
  }

  if (dashboardData?.lighting) {
    dashboardData.lighting.sync = {
      ...dashboardData.lighting.sync,
      moodEnabled: data.moodEnabled,
      beatEnabled: data.beatEnabled,
      bpmOffset: data.bpmOffset,
      beatPhaseMs: data.beatPhaseMs,
      audioSyncEnabled: data.audioSyncEnabled,
      audioSensitivity: data.audioSensitivity,
      runtime: data.runtime,
    };
  }
  renderSpotifySync(dashboardData?.lighting?.sync, dashboardData?.lighting?.hue);
  return data;
}

function applyHueSelection(selection = {}) {
  const groupSelect = document.getElementById("hue-group-select");
  if (groupSelect) {
    groupSelect.value = selection.selectedGroupId || "";
  }

  const selected = new Set(selection.selectedLightIds || []);
  document.querySelectorAll(".hue-light-pick").forEach((el) => {
    el.checked = selected.has(el.dataset.lightId);
  });
}

function renderHueDevicesPanel(data) {
  const table = document.getElementById("hue-lights-table");
  const groupSelect = document.getElementById("hue-group-select");
  if (!table || !groupSelect || !data) return;

  const currentGroup = groupSelect.value;
  groupSelect.innerHTML =
    `<option value="">— No group —</option>` +
    (data.groups || [])
      .map(
        (group) =>
          `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`
      )
      .join("");

  const savedGroup = data.selectedGroupId || currentGroup || "";
  groupSelect.value = savedGroup;

  const selected = new Set(data.selectedLightIds || []);
  renderTable(
    table,
    [
      {
        label: "",
        render: (row) =>
          `<input type="checkbox" class="hue-light-pick" data-light-id="${escapeHtml(row.id)}"${selected.has(row.id) ? " checked" : ""} />`,
      },
      { label: "Light", render: (row) => escapeHtml(row.name) },
      { label: "On", render: (row) => (row.on ? "Yes" : "No") },
      { label: "Reachable", render: (row) => (row.reachable ? "Yes" : "No") },
    ],
    data.lights || [],
    "No lights found on this bridge."
  );

  applyHueSelection({
    selectedGroupId: savedGroup,
    selectedLightIds: data.selectedLightIds || [],
  });
}

function ensureHueDevicesLoaded() {
  if (hueDevicesCache) {
    renderHueDevicesPanel(hueDevicesCache);
    return;
  }
  refreshHueDevices();
}

async function refreshHueDevices({ updateStatusesOnly = false } = {}) {
  const table = document.getElementById("hue-lights-table");
  const groupSelect = document.getElementById("hue-group-select");
  if (!table || !groupSelect) return;

  const requestId = ++hueDevicesRequestId;
  const preservedGroup = groupSelect.value;
  const preservedLights = getSelectedHueLightIds();

  const response = await fetch("/api/lighting/hue/devices");
  const data = await response.json();
  if (requestId !== hueDevicesRequestId) return;

  if (!response.ok) {
    table.innerHTML = `<div class="empty-state">${escapeHtml(data.error || "Failed to load lights")}</div>`;
    return;
  }

  if (updateStatusesOnly && hueDevicesCache) {
    hueDevicesCache.lights = data.lights;
    document.querySelectorAll("[data-hue-light-row]").forEach(() => {});
    const rows = table.querySelectorAll("tbody tr");
    (data.lights || []).forEach((light, index) => {
      const row = rows[index];
      if (!row) return;
      const cells = row.querySelectorAll("td");
      if (cells[2]) cells[2].textContent = light.on ? "Yes" : "No";
      if (cells[3]) cells[3].textContent = light.reachable ? "Yes" : "No";
    });
    return;
  }

  if (!data.selectedGroupId && preservedGroup) {
    data.selectedGroupId = preservedGroup;
  }
  if ((!data.selectedLightIds || !data.selectedLightIds.length) && preservedLights.length) {
    data.selectedLightIds = preservedLights;
  }

  hueDevicesCache = data;
  renderHueDevicesPanel(data);
}

function getSelectedHueLightIds() {
  return [...document.querySelectorAll(".hue-light-pick:checked")].map((el) => el.dataset.lightId);
}

function setHueTestStatus(message) {
  const statusEl = document.getElementById("hue-test-status");
  if (!statusEl) return;
  statusEl.textContent = message || "";
}

function renderSlots(slots, slotsUrls, slotsTimer) {
  const statusEl = document.getElementById("slots-status");
  const queueTable = document.getElementById("slots-queue-table");
  const urlsTable = document.getElementById("slots-urls-table");

  if (statusEl && slots?.lastPick) {
    statusEl.textContent = `Last pick: ${slots.lastPick.slotName} (${slots.lastPick.username}) · ${slots.requests?.length ?? 0} waiting`;
  } else if (statusEl) {
    statusEl.textContent = `${slots?.requests?.length ?? 0} slot request(s) in queue`;
  }

  if (queueTable) {
    renderTable(
      queueTable,
      [
        { label: "Slot", render: (row) => escapeHtml(row.slotName) },
        { label: "Viewer", render: (row) => escapeHtml(row.username) },
        { label: "Time", render: (row) => new Date(row.createdAt).toLocaleTimeString() },
      ],
      slots?.requests || [],
      "No slot requests yet. Chat !sr <slot name>"
    );
  }

  if (urlsTable && slotsUrls) {
    renderObsUrlTable(urlsTable, [
      ["Slots session timer (OBS)", slotsUrls.timer],
      ["Slots control panel", slotsUrls.controlPanel],
      ["Slots widget (queue + pick)", slotsUrls.widget],
      ["Pick alert (slot machine)", slotsUrls.pickAlert],
    ]);
  }

  renderSlotsTimer(slotsTimer);
}

async function refreshSlots() {
  const [slotsRes, timerRes] = await Promise.all([
    fetch("/api/slots"),
    fetch("/api/slots-timer"),
  ]);
  if (!slotsRes.ok) return;
  const slots = await slotsRes.json();
  const slotsTimer = timerRes.ok ? await timerRes.json() : null;
  if (dashboardData) {
    dashboardData.slots = slots;
    dashboardData.slotsTimer = slotsTimer;
    renderSlots(slots, dashboardData.slotsUrls, slotsTimer);
  }
}

function renderDrinking(drinking, drinkingUrls) {
  const statusEl = document.getElementById("drinking-status");
  const urlsTable = document.getElementById("drinking-urls-table");
  const goalInput = document.getElementById("drinking-goal-dash-input");

  if (statusEl && drinking) {
    const goal = drinking.sessionGoal || 12;
    const count = drinking.sessionCount || 0;
    const cheers = drinking.cheersSessionCount || 0;
    const remaining = Math.max(0, goal - count);
    if (remaining <= 0 && count > 0) {
      statusEl.textContent = `Shotgun goal crushed — ${count} beers · ${cheers} chat cheers`;
    } else {
      statusEl.textContent = `${count} shotgun${count === 1 ? "" : "s"} · ${remaining} to goal · ${cheers} cheers from chat`;
    }
  }

  if (goalInput && drinking?.sessionGoal) {
    goalInput.value = drinking.sessionGoal;
  }

  if (urlsTable && drinkingUrls) {
    renderObsUrlTable(urlsTable, [
      ["Shotgun cam scene (1920×1080)", drinkingUrls.shotgunCam],
      ["Beer counter overlay", drinkingUrls.beerCounter],
      ["Shotgun alert pop-up", drinkingUrls.shotgunAlert],
      ["Scene preview widget", drinkingUrls.sceneWidget],
      ["Control panel", drinkingUrls.controlPanel],
    ]);
  }
}

async function refreshDrinking() {
  const response = await fetch("/api/drinking");
  if (!response.ok) return;
  const drinking = await response.json();
  if (dashboardData) {
    dashboardData.drinking = drinking;
    renderDrinking(drinking, dashboardData.drinkingUrls);
  }
}

async function drinkingAction(action, extra = {}) {
  const response = await fetch("/api/drinking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Action failed");
  if (dashboardData) {
    dashboardData.drinking = data;
    renderDrinking(data, dashboardData.drinkingUrls);
  }
  return data;
}

function renderStakeStatus(status) {
  const container = document.getElementById("stake-status");
  const availableList = document.getElementById("stake-available-stats");
  const blockedList = document.getElementById("stake-blocked-stats");
  if (!container) return;

  if (!status) {
    container.innerHTML = `<p class="subtitle">Loading Stake.us status...</p>`;
    return;
  }

  const connected = status.connected;
  const pillClass = connected ? "pill pill-live" : "pill";
  container.innerHTML = `
    <p><span class="${pillClass}">${connected ? "Connected" : "Not connected"}</span></p>
    <p class="subtitle" style="margin-top:10px;">${escapeHtml(status.message || status.note || "")}</p>
    ${
      status.profile
        ? `<p class="subtitle" style="margin-top:8px;">Account: <strong>${escapeHtml(status.profile.name)}</strong> · Member since ${new Date(status.profile.createdAt).toLocaleDateString()}</p>`
        : ""
    }
    ${
      status.profile?.flagProgress
        ? `<p class="subtitle" style="margin-top:6px;">VIP progress: ${escapeHtml(status.profile.flagProgress.flag)} (${Math.round(status.profile.flagProgress.progress * 100)}%)</p>`
        : ""
    }
  `;

  if (availableList) {
    availableList.innerHTML = (status.availableStats || [])
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }

  if (blockedList) {
    blockedList.innerHTML = (status.blockedStats || [])
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
  }
}

function renderStakeLeaderboard(data) {
  const title = document.getElementById("stake-race-title");
  const meta = document.getElementById("stake-race-meta");
  const table = document.getElementById("stake-leaderboard-table");
  if (!table) return;

  const race = data?.race;
  if (title) title.textContent = race?.name || "Active race";
  if (meta) {
    meta.innerHTML = race
      ? `
        <p><strong>Status:</strong> ${escapeHtml(race.status)}</p>
        <p><strong>Currency:</strong> ${escapeHtml(race.currencyLabel || race.currency || "—")}</p>
        <p><strong>Window:</strong> ${new Date(race.startTime).toLocaleString()} → ${new Date(race.endTime).toLocaleString()}</p>
      `
      : `<p class="subtitle">No active race found.</p>`;
  }

  renderTable(
    table,
    [
      { label: "Rank", render: (row) => `#${escapeHtml(row.position)}` },
      {
        label: "Player",
        render: (row) =>
          row.hidden
            ? `<span style="color:var(--text-muted);font-style:italic;">${escapeHtml(row.username)}</span>`
            : escapeHtml(row.username),
      },
      { label: "Wagered", render: (row) => escapeHtml(row.wageredLabel) },
      { label: "Prize", render: (row) => escapeHtml(row.payoutLabel) },
    ],
    data?.entries || [],
    "No leaderboard entries yet."
  );
}

function renderStakeUrls(stakeUrls) {
  const table = document.getElementById("stake-urls-table");
  if (!table || !stakeUrls) return;
  renderObsUrlTable(table, [
    ["Race leaderboard widget", stakeUrls.raceLeaderboard],
    ["Code na5ty referral leaderboard (monthly)", `${stakeUrls.affiliateLeaderboard}?period=month`],
    ["Code na5ty referral leaderboard (30 days)", `${stakeUrls.affiliateLeaderboard}?period=30days`],
    ["Code na5ty referral leaderboard (lifetime)", `${stakeUrls.affiliateLeaderboard}?period=lifetime`],
  ]);
}

function renderStakeAffiliateLeaderboard(data) {
  const note = document.getElementById("stake-affiliate-note");
  const meta = document.getElementById("stake-affiliate-meta");
  const table = document.getElementById("stake-affiliate-table");
  const codeEl = document.getElementById("stake-affiliate-code");
  if (!table) return;

  if (codeEl && data?.campaign?.code) codeEl.textContent = data.campaign.code;
  if (note) note.textContent = data?.note || "";

  if (meta && data?.campaign) {
    meta.innerHTML = `
      <p><strong>Referrals:</strong> ${escapeHtml(data.campaign.referCount)}</p>
      <p><strong>Commission rate:</strong> ${escapeHtml(data.campaign.commissionRate)}</p>
      <p><strong>Total referral deposits:</strong> ${escapeHtml(data.campaign.totalDeposits)}</p>
      ${
        data.trackingSince
          ? `<p><strong>Monthly tracking since:</strong> ${new Date(data.trackingSince).toLocaleString()}</p>`
          : ""
      }
      ${
        data.updatedAt
          ? `<p><strong>Updated:</strong> ${new Date(data.updatedAt).toLocaleString()}</p>`
          : ""
      }
      ${
        data.activeCount != null
          ? `<p><strong>Active last 30 days:</strong> ${escapeHtml(data.activeCount)}</p>`
          : ""
      }
    `;
  }

  renderTable(
    table,
    [
      { label: "Rank", render: (row) => `#${escapeHtml(row.rank)}` },
      { label: "Referral", render: (row) => escapeHtml(row.name) },
      {
        label:
          stakeAffiliatePeriod === "month"
            ? "This month"
            : stakeAffiliatePeriod === "30days"
              ? "Last 30 days"
              : "Lifetime",
        render: (row) => escapeHtml(row.metricLabel),
      },
      { label: "Deposits", render: (row) => escapeHtml(row.depositCount) },
      {
        label: "Last active",
        render: (row) =>
          row.lastDepositAt ? new Date(row.lastDepositAt).toLocaleDateString() : "—",
      },
    ],
    data?.entries || [],
    "No referral leaderboard data yet."
  );
}

async function refreshStakeAffiliate() {
  const response = await fetch(
    `/api/stake/affiliate/leaderboard?period=${encodeURIComponent(stakeAffiliatePeriod)}&limit=50`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    renderStakeAffiliateLeaderboard({ entries: [], note: error.error || "Failed to load referral leaderboard" });
    return;
  }
  renderStakeAffiliateLeaderboard(await response.json());
}

async function refreshStake() {
  const [statusRes, leaderboardRes] = await Promise.all([
    fetch("/api/stake/status"),
    fetch("/api/stake/leaderboard?limit=25"),
  ]);

  const status = statusRes.ok ? await statusRes.json() : { connected: false, message: "Failed to load status" };
  renderStakeStatus(status);

  if (leaderboardRes.ok) {
    const leaderboard = await leaderboardRes.json();
    renderStakeLeaderboard(leaderboard);
  } else {
    const error = await leaderboardRes.json().catch(() => ({}));
    renderStakeLeaderboard({ race: null, entries: [] });
    if (error.error) showError(error.error);
  }

  if (dashboardData?.stakeUrls) renderStakeUrls(dashboardData.stakeUrls);
  await refreshStakeAffiliate();
}

function renderDashboard(data) {
  dashboardData = data;
  const profile = data.profile;
  const isOwner = data.role === "owner" || dashboardRole === "owner";

  applyNavAccess({
    role: data.role,
    allowedPages: data.allowedPages,
    isOwner,
  });

  document.getElementById("display-name").textContent = profile.displayName;
  document.getElementById("channel-meta").textContent = data.channel
    ? `${data.channel.isLive ? "Live" : "Offline"} · ${data.channel.slug}`
    : `@${profile.username}`;

  const avatar = document.getElementById("avatar");
  if (profile.profileImage) avatar.src = profile.profileImage;

  if (isOwner && data.webhookNote) {
    webhookNotice.textContent = data.webhookNote;
    webhookNotice.classList.remove("hidden");
  } else {
    webhookNotice.classList.add("hidden");
  }

  renderStreamHero(data);
  renderStats(data);
  renderChannelDetails(data.channel);
  renderOverviewQuickLinks(data);
  refreshOnlyPixels(data);

  if (!isOwner) {
    loginView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    showPage(currentPage);
    return;
  }

  renderApiAccess(data);
  renderWorkout(data.workout, data.obsUrls);
  renderSlots(data.slots, data.slotsUrls, data.slotsTimer);
  renderDrinking(data.drinking, data.drinkingUrls);
  renderWidgets(data.widgetsUrls, data.spotify, {
    webhookReady: data.webhookReady,
    webhookError: data.webhookError,
    webhookNote: data.webhookNote,
  });
  renderLighting(data.lighting);
  renderStakeUrls(data.stakeUrls);
  renderCommandsTable(data.bot?.commands || []);
  renderTimersTable(data.bot?.timers || []);
  renderMessagesTable(data.chat?.messages || []);
  renderSubsTable(data.chat?.subscriptions || []);
  renderRewardsTable(data.rewards || []);
  renderRedemptionsTable("pending-table", data.redemptions?.pending || [], "No pending redemptions.");
  renderRedemptionsTable("accepted-table", data.redemptions?.accepted || [], "No accepted redemptions.");
  renderSubscriptionsTable(data.eventSubscriptions || []);
  renderLeaderboards(data);

  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  showPage(currentPage);
}

function showLogin() {
  sessionProfile = null;
  sessionRole = "player";
  onlyPixelsState.signedIn = false;
  onlyPixelsState.currentUsername = "";
  dashboardView.classList.add("hidden");
  loginView.classList.remove("hidden");
  document.body.classList.remove("is-dashboard", "nav-open");
}

function showDashboardShell(me) {
  const profile = me?.profile || {};
  document.getElementById("display-name").textContent =
    profile.displayName || profile.username || "Streamer";
  document.getElementById("channel-meta").textContent = profile.username
    ? `@${profile.username}`
    : "";
  const avatar = document.getElementById("avatar");
  if (avatar && profile.profileImage) avatar.src = profile.profileImage;
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  document.body.classList.add("is-dashboard");
  closeMobileNav();
}

async function loadDashboard() {
  const meResponse = await fetch("/api/me", { credentials: "same-origin" });
  const me = await meResponse.json().catch(() => ({ loggedIn: false }));

  if (!me.loggedIn) {
    showLogin();
    return;
  }

  applyNavAccess(me);
  sessionProfile = me.profile || null;
  sessionRole = me.role || (me.isOwner ? "owner" : "player");
  showDashboardShell(me);

  dashboardData = dashboardData || {};
  dashboardData.profile = me.profile;
  dashboardData.role = sessionRole;
  if (me.kickRewards) dashboardData.kickRewards = me.kickRewards;
  refreshOnlyPixels(dashboardData);
  showPage(currentPage);

  const response = await fetch("/api/dashboard", { credentials: "same-origin" });
  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();
  if (!response.ok) {
    showError(data.error || "Failed to load dashboard");
    return;
  }

  renderDashboard(data);
}

document.addEventListener("click", (event) => {
  const gotoLink = event.target.closest("[data-goto-page]");
  if (gotoLink) {
    event.preventDefault();
    const page = gotoLink.dataset.gotoPage;
    showPage(page);
    if (page === "slots") refreshSlots();
    if (page === "drinking") refreshDrinking();
    if (page === "stake") refreshStake();
    return;
  }

  const button = event.target.closest(".copy-url-btn");
  if (button) {
    const url = button.dataset.url || "";
    if (!url) return;
    event.preventDefault();
    copyText(url, button);
    return;
  }

  const code = event.target.closest(".copyable-url, .embed-code");
  if (code?.textContent) {
    event.preventDefault();
    copyText(code.textContent.trim());
  }
});

mainNav.addEventListener("click", (event) => {
  const link = event.target.closest(".nav-link");
  if (!link) return;
  showPage(link.dataset.page);
  if (link.dataset.page === "slots") refreshSlots();
  if (link.dataset.page === "drinking") refreshDrinking();
  if (link.dataset.page === "stake") refreshStake();
});

const menuToggle = document.getElementById("menu-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const hubSearchInput = document.getElementById("hub-search-input");

menuToggle?.addEventListener("click", () => openMobileNav());
sidebarClose?.addEventListener("click", () => closeMobileNav());
sidebarBackdrop?.addEventListener("click", () => closeMobileNav());
hubSearchInput?.addEventListener("input", (event) => {
  filterHubCards(event.target.value || "");
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  showLogin();
});

leaderboardTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (!button || !dashboardData) return;
  leaderboardPeriod = button.dataset.period;
  leaderboardTabs.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab === button);
  });
  renderLeaderboards(dashboardData);
});

document.getElementById("leaderboard-refresh-btn")?.addEventListener("click", () => {
  refreshLeaderboards(true);
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(commandForm);
  const response = await fetch("/api/bot/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trigger: formData.get("trigger"),
      response: formData.get("response"),
    }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Failed to add command");
  commandForm.reset();
  showError("");
  loadDashboard();
});

timerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(timerForm);
  const response = await fetch("/api/bot/timers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: formData.get("message"),
      intervalMinutes: formData.get("intervalMinutes"),
    }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Failed to add timer");
  timerForm.reset();
  showError("");
  loadDashboard();
});

document.getElementById("commands-table").addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-command");
  if (!button) return;
  const response = await fetch(`/api/bot/commands/${button.dataset.id}`, { method: "DELETE" });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Failed to delete command");
  loadDashboard();
});

document.getElementById("timers-table").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-timer");
  if (deleteButton) {
    const response = await fetch(`/api/bot/timers/${deleteButton.dataset.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) return showError(data.error || "Failed to delete timer");
    return loadDashboard();
  }

  const toggleButton = event.target.closest(".toggle-timer");
  if (!toggleButton) return;
  const response = await fetch(`/api/bot/timers/${toggleButton.dataset.id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: toggleButton.dataset.enabled === "true" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Failed to update timer");
  loadDashboard();
});

testBotBtn.addEventListener("click", async () => {
  const response = await fetch("/api/bot/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Bot is connected and working!" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Failed to send test message");
  showError("");
  alert("Test message sent!");
});


document.getElementById("test-sub-btn")?.addEventListener("click", async () => {
  const resultEl = document.getElementById("test-webhook-result");
  const response = await fetch("/api/test/sub", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 1 }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Sub test failed");
  showError("");
  if (resultEl) {
    resultEl.textContent = `Subs: ${data.workout?.subs ?? 0} · Mins: ${data.workout?.minutesBank ?? 0} · Alert sent to OBS banner`;
  }
  if (dashboardData) {
    dashboardData.workout = data.workout;
    renderWorkout(data.workout, dashboardData.obsUrls);
  }
});

document.getElementById("test-chat-btn")?.addEventListener("click", async () => {
  const resultEl = document.getElementById("test-webhook-result");
  const response = await fetch("/api/test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Test chat from dashboard" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Chat test failed");
  showError("");
  if (resultEl) {
    resultEl.textContent = `Messages: ${data.workout?.messageCount ?? 0}`;
  }
  if (dashboardData) {
    dashboardData.workout = data.workout;
    renderWorkout(data.workout, dashboardData.obsUrls);
  }
});

document.getElementById("stake-affiliate-tabs")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".tab");
  if (!button) return;
  stakeAffiliatePeriod = button.dataset.period;
  document.querySelectorAll("#stake-affiliate-tabs .tab").forEach((tab) => {
    tab.classList.toggle("active", tab === button);
  });
  await refreshStakeAffiliate();
});

document.getElementById("stake-refresh-btn")?.addEventListener("click", async () => {
  showError("");
  await refreshStake();
});

async function postSlotsTimerAction(actionBody) {
  const response = await fetch("/api/slots-timer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionBody),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Timer action failed");
  return data;
}

document.getElementById("spotify-disconnect-btn")?.addEventListener("click", async () => {
  const response = await fetch("/auth/spotify/disconnect", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showError(data.error || "Failed to disconnect Spotify");
  showError("");
  await loadDashboard();
});

document.getElementById("hue-discover-btn")?.addEventListener("click", async () => {
  const resultsEl = document.getElementById("hue-discover-results");
  const ipInput = document.getElementById("hue-bridge-ip");
  if (resultsEl) resultsEl.textContent = "Searching…";
  const response = await fetch("/api/lighting/hue/discover", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (resultsEl) resultsEl.textContent = data.error || "Discovery failed";
    return;
  }
  const bridges = data.bridges || [];
  if (!bridges.length) {
    if (resultsEl) {
      resultsEl.textContent =
        "Cloud discovery found nothing — enter 192.168.1.177 manually, press the link button, then Connect.";
    }
    if (ipInput && !ipInput.value) ipInput.value = "192.168.1.177";
    return;
  }
  if (ipInput && bridges[0]?.ip) {
    ipInput.value = bridges[0].ip;
  }
  if (resultsEl) {
    const label = bridges[0].name ? `${bridges[0].name} (${bridges[0].ip})` : bridges[0].ip;
    const via = bridges[0].source === "local" ? "on your network" : "via Hue cloud";
    resultsEl.textContent = bridges.length === 1
      ? `Found bridge ${label} ${via}`
      : `Found ${bridges.length} bridges — using ${label}`;
  }
});

document.getElementById("hue-connect-btn")?.addEventListener("click", async () => {
  const ipInput = document.getElementById("hue-bridge-ip");
  const bridgeIp = ipInput?.value?.trim();
  if (!bridgeIp) return showError("Enter a bridge IP or click Discover bridges");
  showError("");
  setHueTestStatus("Connecting… press the round link button on your Hue Bridge now (you have ~30 seconds).");
  const response = await fetch("/api/lighting/hue/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bridgeIp }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Connect failed");
    return;
  }
  setHueTestStatus("");
  hueDevicesCache = null;
  await loadDashboard();
  showPage("lighting");
});

document.getElementById("hue-disconnect-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/lighting/hue/disconnect", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showError(data.error || "Failed to disconnect Hue");
  showError("");
  setHueTestStatus("");
  await loadDashboard();
});

document.getElementById("hue-refresh-devices-btn")?.addEventListener("click", () => {
  hueDevicesCache = null;
  refreshHueDevices();
});

document.getElementById("hue-group-select")?.addEventListener("change", (event) => {
  const groupId = event.target.value;
  if (!groupId || !hueDevicesCache?.groups) return;
  const group = hueDevicesCache.groups.find((entry) => entry.id === groupId);
  if (!group) return;
  const groupLights = new Set(group.lightIds || []);
  document.querySelectorAll(".hue-light-pick").forEach((el) => {
    el.checked = groupLights.has(el.dataset.lightId);
  });
});

document.getElementById("hue-save-selection-btn")?.addEventListener("click", async () => {
  const groupSelect = document.getElementById("hue-group-select");
  const groupId = groupSelect?.value || "";
  const lightIds = getSelectedHueLightIds();
  const response = await fetch("/api/lighting/hue/selection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lightIds,
      groupId: groupId || null,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Could not save selection");
    return;
  }

  const selection = {
    selectedGroupId: data.selectedGroupId || null,
    selectedLightIds: data.selectedLightIds || [],
  };

  if (hueDevicesCache) {
    hueDevicesCache = { ...hueDevicesCache, ...selection };
  }
  if (dashboardData?.lighting?.hue) {
    dashboardData.lighting.hue = { ...dashboardData.lighting.hue, ...selection };
  }

  applyHueSelection(selection);
  setHueTestStatus("Selection saved.");
});

async function runHueTest(action) {
  setHueTestStatus(`Running ${action}…`);
  const response = await fetch("/api/lighting/hue/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Test failed");
    return;
  }
  if (action === "off" && data.stoppedStreams?.length) {
    setHueTestStatus(
      `Stopped ${data.stoppedStreams.join(", ")} and turned lights off. Sync paused 3 min.`
    );
  } else {
    setHueTestStatus(`Test ${action} sent to your lights.`);
  }
  refreshHueDevices({ updateStatusesOnly: true });
}

document.getElementById("hue-test-pulse-btn")?.addEventListener("click", () => runHueTest("pulse"));
document.getElementById("hue-test-on-btn")?.addEventListener("click", () => runHueTest("on"));
document.getElementById("hue-test-off-btn")?.addEventListener("click", () => runHueTest("off"));

document.getElementById("hue-reset-btn")?.addEventListener("click", async () => {
  setHueTestStatus("Resetting lights on the bridge…");
  const response = await fetch("/api/lighting/hue/reset", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Reset failed");
    return;
  }
  const stopped = data.stoppedStreams?.length
    ? `Stopped: ${data.stoppedStreams.join(", ")}. `
    : "";
  setHueTestStatus(`${stopped}Lights released from the bridge. Sync paused 3 min.`);
  refreshHueDevices({ updateStatusesOnly: true });
});

async function runGoveeTest(action) {
  setGoveeTestStatus(`Running ${action}…`);
  const response = await fetch("/api/lighting/govee/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setGoveeTestStatus(data.error || "Test failed");
    return;
  }
  const first = data.statuses?.[0];
  const stillOn = Number(data.stillOn) || 0;
  const statusHint = stillOn
    ? ` ${stillOn} device(s) still report ON — close GoveeLAN app if open, then retry.`
    : first?.status
      ? ` Device reports on=${first.status.onOff ? "yes" : "no"}.`
      : first?.confirmed === false
        ? " Command sent — if lights stay on, close GoveeLAN on this PC and retry."
        : "";
  setGoveeTestStatus(`Govee test ${action} sent to ${data.count || 0} device(s).${statusHint}`);
}

document.getElementById("govee-scan-btn")?.addEventListener("click", async () => {
  const scanIps = document
    .getElementById("govee-scan-ips")
    ?.value.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  setGoveeTestStatus("Scanning LAN for Govee devices…");
  const response = await fetch("/api/lighting/govee/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scanIps }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setGoveeTestStatus(data.error || "Scan failed");
    if (data.devices) {
      goveeDevicesCache = data;
      renderGoveeDevicesPanel(data);
    }
    return;
  }
  goveeDevicesCache = data;
  renderGoveeDevicesPanel(data);
  setGoveeTestStatus(
    data.discoveredNow
      ? `Found ${data.discoveredNow} device(s) on LAN.`
      : "Scan finished — no new devices replied."
  );
  if (dashboardData?.lighting) {
    dashboardData.lighting.govee = {
      ...dashboardData.lighting.govee,
      knownDevices: data.devices,
      selectedDevices: data.selectedDevices,
      connected: Boolean(data.devices?.length),
      lastScanAt: data.lastScanAt,
      lastScanError: null,
    };
    renderGovee(dashboardData.lighting.govee);
  }
});

document.getElementById("govee-refresh-btn")?.addEventListener("click", () => {
  refreshGoveeDevices();
});

document.getElementById("govee-save-selection-btn")?.addEventListener("click", async () => {
  const deviceKeys = getSelectedGoveeKeys();
  const response = await fetch("/api/lighting/govee/selection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKeys }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setGoveeTestStatus(data.error || "Could not save Govee selection");
    return;
  }
  if (goveeDevicesCache) {
    goveeDevicesCache.selectedDevices = data.selectedDevices || [];
  }
  if (dashboardData?.lighting?.govee) {
    dashboardData.lighting.govee.selectedDevices = data.selectedDevices || [];
  }
  renderGoveeDevicesPanel(goveeDevicesCache || { devices: [], selectedDevices: data.selectedDevices });
  setGoveeTestStatus("Govee selection saved.");
});

document.getElementById("govee-test-pulse-btn")?.addEventListener("click", () => runGoveeTest("pulse"));
document.getElementById("govee-test-on-btn")?.addEventListener("click", () => runGoveeTest("on"));
document.getElementById("govee-test-off-btn")?.addEventListener("click", () => runGoveeTest("off"));

document.getElementById("lighting-layout-sync-btn")?.addEventListener("click", async () => {
  setLightingLayoutHint("Syncing lights from Hue + Govee selections…");
  const response = await fetch("/api/lighting/layout/sync", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setLightingLayoutHint(data.error || "Sync failed");
    return;
  }
  if (dashboardData?.lighting) {
    dashboardData.lighting.layout = data;
  }
  renderLightingLayout(data);
  setLightingLayoutHint(`Synced ${data.lights?.length || 0} lights. Drag them into place, then Save.`);
});

document.getElementById("lighting-layout-save-btn")?.addEventListener("click", () => saveLightingLayout());

document.getElementById("lighting-chat-off-btn")?.addEventListener("click", async () => {
  setLightingLayoutHint("Turning lights off and pausing beat sync…");
  const response = await fetch("/api/lighting/chat-off", { method: "POST" });
  const { data, text } = await readApiJson(response);
  if (!response.ok) {
    setLightingLayoutHint(layoutApiError(response, data, text));
    return;
  }
  if (dashboardData?.lighting?.sync) {
    dashboardData.lighting.sync.runtime = {
      ...dashboardData.lighting.sync.runtime,
      lightsChatMuted: true,
      status: "lights-muted",
    };
    renderSpotifySync(dashboardData.lighting.sync, dashboardData.lighting.hue);
  }
  setLightingLayoutHint("Lights off — same as !lightsoff. Use Resume lights or !lightson when ready.");
});

document.getElementById("lighting-chat-on-btn")?.addEventListener("click", async () => {
  setLightingLayoutHint("Resuming beat sync…");
  const response = await fetch("/api/lighting/chat-on", { method: "POST" });
  const { data, text } = await readApiJson(response);
  if (!response.ok) {
    setLightingLayoutHint(layoutApiError(response, data, text));
    return;
  }
  if (dashboardData?.lighting?.sync) {
    dashboardData.lighting.sync.runtime = {
      ...dashboardData.lighting.sync.runtime,
      lightsChatMuted: false,
    };
    renderSpotifySync(dashboardData.lighting.sync, dashboardData.lighting.hue);
  }
  setLightingLayoutHint("Beat sync resumed — same as !lightson.");
});

document.getElementById("lighting-layout-map-btn")?.addEventListener("click", async () => {
  const saved = await saveLightingLayout();
  if (!saved) return;
  clearLightingLayoutMapClasses();
  setLightingLayoutHint("Color map running — watch which color is on each physical light…");
  const response = await fetch("/api/lighting/layout/map-colors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ holdMs: 10000 }),
  });
  const { data, text } = await readApiJson(response);
  if (!response.ok) {
    setLightingLayoutHint(layoutApiError(response, data, text));
    return;
  }

  highlightLightingLayoutMap(data.assignments || []);
  const legend = formatMapLegend((data.assignments || []).filter((entry) => !entry.error));
  const warn = (data.warnings || []).length
    ? ` (${data.warnings.length} light(s) unreachable)`
    : "";
  setLightingLayoutHint(
    legend ? `Map: ${legend}${warn}. Drag dots to match, then Save.` : `Color map done${warn}.`
  );
  setTimeout(() => clearLightingLayoutMapClasses(), 30000);
});

document.getElementById("lighting-layout-split-btn")?.addEventListener("click", async () => {
  if (!lightingLayoutSelectedId) {
    setLightingLayoutHint("Click your dual-strip Govee dot first, then Split 2 strips.");
    return;
  }

  setLightingLayoutHint("Splitting strip into top + bottom chase steps…");
  const response = await fetch("/api/lighting/layout/split-strip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lightId: lightingLayoutSelectedId, parts: 2 }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setLightingLayoutHint(data.error || "Split failed");
    return;
  }

  lightingLayoutDraft = {
    flashPattern: data.flashPattern || lightingLayoutDraft?.flashPattern || "chase",
    lights: (data.lights || []).map((light) => ({ ...light })),
  };
  if (dashboardData?.lighting) {
    dashboardData.lighting.layout = data;
  }
  const patternEl = document.getElementById("lighting-layout-pattern");
  if (patternEl && data.flashPattern) patternEl.value = data.flashPattern;
  renderLightingLayout(data);
  setLightingLayoutHint("Split into 2 strips. Drag top/bottom, Save, then Test pattern with Chase.");
});

document.getElementById("lighting-layout-test-btn")?.addEventListener("click", async () => {
  await saveLightingLayout();
  setLightingLayoutHint("Running pattern preview…");
  const response = await fetch("/api/lighting/layout/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beats: 4 }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setLightingLayoutHint(data.error || "Pattern test failed");
    return;
  }
  setLightingLayoutHint(`Previewed ${data.pattern} across ${data.lights} lights (${data.beats} beats).`);
});

document.getElementById("spotify-sync-save-btn")?.addEventListener("click", async () => {
  const data = await saveSpotifySyncSettings();
  if (!data) return;
  setHueTestStatus(
    data.moodEnabled || data.beatEnabled
      ? "Concert sync on — lights stay dark until the next drop."
      : "Spotify sync disabled."
  );
});

document.getElementById("spotify-sync-bpm-down")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.bpmOffset) || 0;
  await saveSpotifySyncSettings({ bpmOffset: current - 5 });
  setHueTestStatus("Beat timing slowed −5 BPM. Skip to next song or wait for next drop.");
});

document.getElementById("spotify-sync-bpm-up")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.bpmOffset) || 0;
  await saveSpotifySyncSettings({ bpmOffset: current + 5 });
  setHueTestStatus("Beat timing sped up +5 BPM. Skip to next song or wait for next drop.");
});

document.getElementById("spotify-sync-phase-early")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.beatPhaseMs) || 0;
  await saveSpotifySyncSettings({ beatPhaseMs: current - 50 });
  setHueTestStatus("Flashes shifted 50ms earlier — replay from start to test.");
});

document.getElementById("spotify-sync-phase-late")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.beatPhaseMs) || 0;
  await saveSpotifySyncSettings({ beatPhaseMs: current + 50 });
  setHueTestStatus("Flashes shifted 50ms later — replay from start to test.");
});

document.getElementById("spotify-sync-audio-down")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.audioSensitivity) || 6;
  await saveSpotifySyncSettings({ audioSensitivity: Math.max(1, current - 1) });
  setHueTestStatus("Audio sensitivity lowered — fewer false hits.");
});

document.getElementById("spotify-sync-audio-up")?.addEventListener("click", async () => {
  const current = Number(dashboardData?.lighting?.sync?.audioSensitivity) || 6;
  await saveSpotifySyncSettings({ audioSensitivity: Math.min(10, current + 1) });
  setHueTestStatus("Audio sensitivity raised — catches more beats.");
});

document.getElementById("spotify-sync-calibrate-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/lighting/sync/calibrate", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setHueTestStatus(data.error || "Start playing a song first, then calibrate");
    return;
  }
  setHueTestStatus(`Saved calibration for ${data.calibration?.name || "this song"}.`);
  if (dashboardData?.lighting?.sync) {
    dashboardData.lighting.sync.runtime = data.runtime;
    renderSpotifySync(dashboardData.lighting.sync, dashboardData.lighting.hue);
  }
});

let widgetsChatDebugTimer = null;

function formatWebhookDebug(data) {
  const lines = [
    `Webhook URL: ${data.webhookUrl || "?"}`,
    `Expected channel: ${data.expectedBroadcasterId || "1183030"}`,
    `Kick signed in: ${data.kickSignedInOnServer ? "yes" : "no"}`,
    `chat.message.sent subscribed: ${data.chatWebhookActive ? "yes" : "no"}`,
    `Messages for channel: ${data.messageCountForChannel ?? 0}`,
    `Stored by broadcaster: ${JSON.stringify(data.storedByBroadcaster || {})}`,
    `Webhook hits since deploy: ${data.totalHits ?? 0} (from Kick ${data.kickHits ?? 0}, other ${data.otherHits ?? 0})`,
    `Last Kick webhook: ${data.lastKickHitAt || "never"}`,
    `Last chat webhook: ${data.lastChatAt || "never"}`,
  ];

  if (data.lastChat) {
    lines.push(
      `Last chat: [${data.lastChat.channelId}] ${data.lastChat.username}: ${data.lastChat.content}`
    );
  }

  if (data.lastRejection) {
    lines.push(
      `Last rejection: ${data.lastRejection.eventType} — ${data.lastRejection.reason} at ${data.lastRejection.at}`
    );
  }

  if (Array.isArray(data.hints) && data.hints.length) {
    lines.push("", "Hints:");
    for (const hint of data.hints) lines.push(`- ${hint}`);
  }

  if (Array.isArray(data.recent) && data.recent.length) {
    lines.push("", "Recent webhook events:");
    for (const event of data.recent.slice(0, 8)) {
      const summary =
        event.eventType === "chat.message.sent"
          ? `${event.summary?.username}: ${event.summary?.content}`
          : event.eventType;
      lines.push(
        `- ${event.at} ${event.valid ? "OK" : "REJECT"} ${event.eventType} [${event.channelId || "?"}] ${summary || ""}`
      );
    }
  }

  return lines.join("\n");
}

async function refreshWidgetsChatDebug() {
  const debugEl = document.getElementById("widgets-chat-debug");
  if (!debugEl || debugEl.classList.contains("hidden")) return;

  try {
    const response = await fetch("/api/webhooks/debug");
    const data = await response.json();
    debugEl.textContent = formatWebhookDebug(data);
  } catch (error) {
    debugEl.textContent = `Debug fetch failed: ${error.message}`;
  }
}

document.getElementById("widgets-debug-chat-btn")?.addEventListener("click", async () => {
  const debugEl = document.getElementById("widgets-chat-debug");
  if (!debugEl) return;

  debugEl.classList.toggle("hidden");
  const visible = !debugEl.classList.contains("hidden");
  if (!visible) {
    if (widgetsChatDebugTimer) {
      clearInterval(widgetsChatDebugTimer);
      widgetsChatDebugTimer = null;
    }
    return;
  }

  await refreshWidgetsChatDebug();
  widgetsChatDebugTimer = setInterval(refreshWidgetsChatDebug, 3000);
});

document.getElementById("widgets-test-chat-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Test message from Widgets tab", username: "TestViewer" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Chat test failed — sign in with Kick first");
  showError("");
  const chatStatusEl = document.getElementById("widgets-chat-status");
  if (chatStatusEl) {
    chatStatusEl.textContent = "Test message sent — chat box should update in a few seconds.";
    chatStatusEl.className = "subtitle ok";
  }
});

async function postTestAlert(type) {
  const statusEl = document.getElementById("widgets-alert-status");
  const debugEl = document.getElementById("widgets-alert-debug");
  const debugEnabled =
    new URLSearchParams(location.search).get("debugAlerts") === "1" ||
    localStorage.getItem("debugAlerts") === "1";
  const debugLines = [];
  const startedAt = performance.now();

  function logAlertDebug(step, detail = "") {
    const ms = Math.round(performance.now() - startedAt);
    const line = `[+${ms}ms] ${step}${detail ? ` — ${detail}` : ""}`;
    debugLines.push(line);
    console.log(`[alert-test] ${line}`);
    if (!debugEl) return;
    debugEl.classList.remove("hidden");
    debugEl.textContent = debugLines.join("\n");
  }

  if (debugEl && debugEnabled) {
    debugEl.classList.remove("hidden");
    debugEl.textContent = "";
  }

  if (statusEl) {
    statusEl.textContent = "Sending…";
    statusEl.className = "subtitle";
  }

  const quantity = type === "gift" ? 5 : type === "kicks" ? 100 : 1;
  const params = new URLSearchParams({
    type,
    username: "TestViewer",
    quantity: String(quantity),
  });
  const iframeCount = document.querySelectorAll("iframe").length;

  logAlertDebug(
    "start",
    `type=${type} origin=${location.origin} iframes=${iframeCount}${
      debugEnabled ? "" : " (add ?debugAlerts=1 for full log)"
    }`
  );

  async function requestAlert(method) {
    const url =
      method === "GET"
        ? `/api/test/alert?${params}`
        : "/api/test/alert";
    const reqStarted = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    logAlertDebug(`${method} fetch`, url);

    try {
      const response =
        method === "GET"
          ? await fetch(url, {
              method: "GET",
              cache: "no-store",
              credentials: "same-origin",
              signal: controller.signal,
            })
          : await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              signal: controller.signal,
              body: JSON.stringify({
                type,
                username: "TestViewer",
                quantity,
              }),
            });
      logAlertDebug(
        `${method} response`,
        `${response.status} in ${Math.round(performance.now() - reqStarted)}ms`
      );
      return response;
    } catch (error) {
      logAlertDebug(
        `${method} error`,
        `${error.name}: ${error.message} after ${Math.round(
          performance.now() - reqStarted
        )}ms`
      );
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  let response;
  let postError = null;
  try {
    response = await requestAlert("POST");
  } catch (error) {
    postError = error;
    logAlertDebug("POST failed, trying GET fallback");
    try {
      response = await requestAlert("GET");
    } catch (getError) {
      if (getError.name === "AbortError" || postError?.name === "AbortError") {
        throw new Error(
          "Server not responding (request timed out). Hard refresh with Ctrl+Shift+R. " +
            "If this keeps happening, close extra dashboard tabs — too many preview iframes can block requests."
        );
      }
      throw new Error(
        `Could not reach server — open http://localhost:3000 (${getError.message})`
      );
    }
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    throw new Error("Server returned an invalid response");
  }

  if (!response.ok) throw new Error(data.error || "Alert test failed");

  logAlertDebug("ok", `nonce=${data.alertNonce}`);

  const state = {
    alertNonce: data.alertNonce,
    lastAlert: data.lastAlert,
  };

  const previewFrames = document.querySelectorAll(
    'iframe[src*="stream-alerts.html"]'
  );
  for (const frame of previewFrames) {
    try {
      frame.contentWindow?.postMessage(
        { type: "stream-alert-push", state, force: true },
        window.location.origin
      );
    } catch {
      /* iframe not ready */
    }
  }

  // Poll again shortly in case the iframe missed postMessage during load
  setTimeout(() => {
    for (const frame of previewFrames) {
      try {
        frame.contentWindow?.postMessage(
          { type: "stream-alert-push", state, force: true },
          window.location.origin
        );
      } catch {
        /* ignore */
      }
    }
  }, 300);

  if (statusEl) {
    const label = data.lastAlert?.detail || data.lastAlert?.label || type;
    statusEl.textContent = `Sent: ${label} — check preview above and OBS`;
    statusEl.className = "subtitle ok";
  }

  return data;
}

function wireWidgetsAlertTest(buttonId, type) {
  document.getElementById(buttonId)?.addEventListener("click", async () => {
    try {
      await postTestAlert(type);
      showError("");
    } catch (error) {
      const statusEl = document.getElementById("widgets-alert-status");
      if (statusEl) {
        statusEl.textContent = error.message;
        statusEl.className = "subtitle err";
      }
      showError(error.message);
    }
  });
}

wireWidgetsAlertTest("widgets-test-follow-btn", "follow");
wireWidgetsAlertTest("widgets-test-sub-btn", "sub");
wireWidgetsAlertTest("widgets-test-gift-btn", "gift");
wireWidgetsAlertTest("widgets-test-kicks-btn", "kicks");

document.getElementById("slots-set-hour-btn")?.addEventListener("click", async () => {
  try {
    await postSlotsTimerAction({ action: "setHour" });
    showError("");
    await refreshSlots();
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("slots-timer-start-btn")?.addEventListener("click", async () => {
  try {
    await postSlotsTimerAction({ action: "start" });
    showError("");
    await refreshSlots();
  } catch (error) {
    showError(error.message || "Set time first");
  }
});

document.getElementById("slots-timer-stop-btn")?.addEventListener("click", async () => {
  try {
    await postSlotsTimerAction({ action: "stop" });
    showError("");
    await refreshSlots();
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("slots-timer-reset-btn")?.addEventListener("click", async () => {
  if (!confirm("Reset the slots session timer?")) return;
  try {
    await postSlotsTimerAction({ action: "reset" });
    showError("");
    await refreshSlots();
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("slots-pick-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pick" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Pick failed");
  showError("");
  renderSlots(data.slots, dashboardData?.slotsUrls, dashboardData?.slotsTimer);
});

document.getElementById("slots-clear-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "clear" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Clear failed");
  showError("");
  renderSlots(data.slots, dashboardData?.slotsUrls, dashboardData?.slotsTimer);
});

document.getElementById("slots-test-request-btn")?.addEventListener("click", async () => {
  const slotName = prompt("Test slot name:", "Sweet Bonanza");
  if (!slotName) return;
  const response = await fetch("/api/test/slots-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slotName, username: "TestViewer" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Test request failed");
  showError("");
  renderSlots(data.slots, dashboardData?.slotsUrls, dashboardData?.slotsTimer);
});

document.getElementById("slots-test-pick-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/test/slots-pick", { method: "POST" });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Test pick failed");
  showError("");
  renderSlots(data.slots, dashboardData?.slotsUrls, dashboardData?.slotsTimer);
});

document.getElementById("slots-preview-pick-btn")?.addEventListener("click", async () => {
  const stateRes = await fetch("/api/slots");
  const state = await stateRes.json();
  if (!state.requests?.length) {
    const seedRes = await fetch("/api/test/slots-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slotName: "Preview Slot", username: "PreviewUser" }),
    });
    const seedData = await seedRes.json();
    if (!seedRes.ok) return showError(seedData.error || "Failed to seed preview request");
  }

  const response = await fetch("/api/slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pick" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Preview pick failed");

  showError("");
  renderSlots(data.slots, dashboardData?.slotsUrls, dashboardData?.slotsTimer);

  const pickFrame = document.querySelector(".slots-pick-frame");
  if (pickFrame) {
    pickFrame.src = `/slots/slots-pick.html?obs=1&replay=1&ts=${Date.now()}`;
  }
});

document.getElementById("drinking-cheer-dash-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("cheer", { by: "Dashboard" });
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-shotgun-dash-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("add", { by: "Dashboard" });
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-shotgun-3-dash-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("add", { count: 3, by: "Dashboard" });
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-undo-dash-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("remove");
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-reset-dash-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("reset");
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-goal-dash-btn")?.addEventListener("click", async () => {
  const input = document.getElementById("drinking-goal-dash-input");
  const goal = parseInt(input?.value, 10);
  if (!goal || goal < 1) return showError("Enter a valid goal (1–99)");
  try {
    await drinkingAction("setGoal", { goal });
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

document.getElementById("drinking-test-cheers-btn")?.addEventListener("click", async () => {
  const response = await fetch("/api/test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "!cheers", username: "TestViewer" }),
  });
  const data = await response.json();
  if (!response.ok) return showError(data.error || "Test !cheers failed");
  if (dashboardData && data.drinking) {
    dashboardData.drinking = data.drinking;
    renderDrinking(data.drinking, dashboardData.drinkingUrls);
  }
  showError("");
});

document.getElementById("drinking-test-alert-btn")?.addEventListener("click", async () => {
  try {
    await drinkingAction("add", { by: "Test" });
    showError("");
  } catch (error) {
    showError(error.message);
  }
});

const params = new URLSearchParams(window.location.search);
const error = params.get("error");
const spotifyConnected = params.get("spotify") === "connected";
if (error) {
  const friendly = {
    kick_not_configured: "Kick is not configured.",
    invalid_state: "Login session expired. Please try again.",
    invalid_spotify_state: "Spotify login expired. Click Connect Spotify again.",
    "invalid redirect uri":
      "Kick redirect URI mismatch. Add the URL shown below in Kick Developer settings, then try again.",
    access_denied: "This dashboard is private. Your Kick account is not authorized to sign in.",
  };
  showError(friendly[error] || decodeURIComponent(error));
  window.history.replaceState({}, "", "/");
} else if (spotifyConnected) {
  showError("");
  const notice = document.getElementById("webhook-notice");
  if (notice) {
    notice.textContent = "Spotify connected. Open the Widgets tab to confirm playback.";
    notice.classList.remove("hidden");
  }
  window.history.replaceState({}, "", "/");
}

loadDashboard();
setInterval(loadDashboard, 15000);
setInterval(() => {
  if (currentPage === "leaderboard" && allowedPages.includes("leaderboard")) {
    refreshLeaderboards(true);
  }
}, 60000);

async function loadKickRedirectHint() {
  const hint = document.getElementById("kick-redirect-hint");
  if (!hint) return;

  try {
    const response = await fetch("/api/auth/kick-info");
    if (!response.ok) return;
    const data = await response.json();
    if (!data.redirectUri) return;

    hint.innerHTML =
      `Kick Developer → Redirect URL must include exactly:<br><code>${escapeHtml(data.redirectUri)}</code>`;
    hint.classList.remove("hidden");
  } catch {
    // ignore
  }
}

loadKickRedirectHint();

const onlyPixelsState = { currentUsername: "", signedIn: false, bound: false };

function setOnlyPixelsLinkCode(code) {
  const box = document.getElementById("only-pixels-code-box");
  const value = document.getElementById("only-pixels-code-value");
  if (!box || !value) return;
  value.textContent = code || "------";
  box.hidden = !code;
}

function setOnlyPixelsStatus(message, type = "") {
  const el = document.getElementById("only-pixels-register-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `only-pixels-note${type ? ` ${type}` : ""}`;
}

async function registerOnlyPixelsUsername(kickUsername) {
  const response = await fetch("/api/rewards/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kickUsername }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Register failed");
  return data;
}

function renderOnlyPixelsApplication(application) {
  const box = document.getElementById("only-pixels-application-box");
  const status = document.getElementById("only-pixels-application-status");
  const note = document.getElementById("only-pixels-application-note");
  if (!box || !status || !note) return;
  box.hidden = !application;
  if (!application) return;

  const state = String(application.status || "pending");
  status.textContent =
    state === "approved"
      ? "Approved — partnership ready"
      : state === "banned"
        ? "Streamer partnership denied"
        : "Pending staff review";
  note.textContent =
    state === "approved"
      ? "Register as a Streamer in the in-city Kick menu with this same username. Partnership activates automatically."
      : state === "banned"
        ? application.reason || "You still have full viewer access, including chat rewards, tips, and viewer claims."
        : "Staff will review your streamer application. You can still claim viewer rewards in city while pending.";
}

async function loadOnlyPixelsApplication() {
  const response = await fetch("/api/rewards/partner-application");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not load partner application");
  renderOnlyPixelsApplication(data.application);
  refreshOnlyPixelsPartners(Boolean(data.isStaff));
  return data;
}

function applyOnlyPixelsSummary(summary) {
  if (!summary) return;
  onlyPixelsState.lastSummary = summary;
  onlyPixelsState.currentUsername = summary.kickUsername || onlyPixelsState.currentUsername;
  renderOnlyPixelsPointsHero(summary);
  renderOnlyPixelsStats(summary.streamers);
}

function setOnlyPixelsSignedInLabel(username, role) {
  const el = document.getElementById("only-pixels-signed-in");
  if (!el) return;
  if (!username) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `Signed in as <strong>@${escapeHtml(username)}</strong>${role === "owner" ? " · broadcaster" : ""}`;
}

function renderOnlyPixelsPointsHero(summary, { signedInUsername } = {}) {
  const hero = document.getElementById("only-pixels-points-hero");
  if (!hero) return;

  if (!summary) {
    const username = signedInUsername || onlyPixelsState.currentUsername || "";
    if (username) {
      hero.innerHTML = `<p class="subtitle">Loading Kick Points for <strong>@${escapeHtml(username)}</strong>...</p>`;
      return;
    }
    hero.innerHTML = '<p class="subtitle">Sign in with Kick above to see your points.</p>';
    return;
  }

  const total = Number(summary.total_messages_24h || 0);
  const channels = Number(summary.active_channels || 0);
  const username = summary.kickUsername || onlyPixelsState.currentUsername || "";
  hero.innerHTML = `
    <div class="only-pixels-points-total">${escapeHtml(String(total))}</div>
    <div class="only-pixels-points-label">
      Kick Points (24h) for <strong>@${escapeHtml(username)}</strong>
      ${channels > 0 ? ` · ${channels} channel${channels === 1 ? "" : "s"} with points` : " · chat on a partnered streamer to earn"}
    </div>`;
}

function renderOnlyPixelsCommandGroups(commands) {
  const list = Array.isArray(commands) ? commands : [];
  if (!list.length) {
    return '<p class="only-pixels-stat-meta">No commands configured for this channel.</p>';
  }

  const groups = new Map();
  for (const cmd of list) {
    const key = cmd.group || "other";
    if (!groups.has(key)) {
      groups.set(key, { label: cmd.groupLabel || key, items: [] });
    }
    groups.get(key).items.push(cmd);
  }

  return [...groups.values()]
    .map((group) => {
      const chips = group.items
        .map(
          (cmd) => `
            <span class="only-pixels-cmd" title="${escapeHtml(cmd.description || "")}">
              <code>${escapeHtml(cmd.chat)}</code>
              <span class="only-pixels-cmd-desc">${escapeHtml(cmd.description || "")}</span>
            </span>`
        )
        .join("");
      return `
        <div class="only-pixels-cmd-group">
          <div class="only-pixels-cmd-label">${escapeHtml(group.label)}</div>
          <div class="only-pixels-cmd-list">${chips}</div>
        </div>`;
    })
    .join("");
}

function renderOnlyPixelsKeywordUsage(usage) {
  const rows = Array.isArray(usage) ? usage : [];
  if (!rows.length) {
    return '<span class="only-pixels-stat-meta">No command keywords used yet — regular chat still earns points.</span>';
  }
  return rows
    .map((row) => `<span class="only-pixels-used-chip"><code>${escapeHtml(row.chat)}</code> ×${escapeHtml(String(row.count))}</span>`)
    .join("");
}

function renderOnlyPixelsStats(streamers) {
  const panel = document.getElementById("only-pixels-stats");
  if (!panel) return;

  const entries = Object.entries(streamers || {}).sort(
    (a, b) => Number(b[1]?.message_count_24h || 0) - Number(a[1]?.message_count_24h || 0)
  );

  if (!entries.length) {
    panel.innerHTML =
      '<p class="subtitle">No points yet — chat in a partnered Kick channel, then hit Refresh.</p>';
    return;
  }

  panel.innerHTML = entries
    .map(([slug, row]) => {
      const msgs = Number(row.message_count_24h || 0);
      const gifts = Number(row.gift_kicks_all_time || 0);
      return `
        <article class="only-pixels-streamer-card">
          <div class="only-pixels-stat-head">
            <div>
              <strong class="only-pixels-streamer-name">@${escapeHtml(slug)}</strong>
              <div class="only-pixels-stat-meta">${escapeHtml(String(msgs))} Kick Points (24h)${gifts > 0 ? ` · ${gifts} KICKS gifted` : ""}</div>
            </div>
            <div class="only-pixels-pts-badge">${escapeHtml(String(msgs))}</div>
          </div>
          <div class="only-pixels-used-row">
            <span class="only-pixels-used-label">Used today</span>
            ${renderOnlyPixelsKeywordUsage(row.keyword_usage)}
          </div>
          <div class="only-pixels-commands">
            <div class="only-pixels-commands-title">Chat commands</div>
            ${renderOnlyPixelsCommandGroups(row.chat_commands)}
          </div>
        </article>`;
    })
    .join("");
}

async function loadOnlyPixelsStats(kickUsername, { quiet = false } = {}) {
  const panel = document.getElementById("only-pixels-stats");
  if (!kickUsername) {
    renderOnlyPixelsPointsHero(null);
    if (panel) panel.innerHTML = "";
    return null;
  }

  renderOnlyPixelsPointsHero(null, { signedInUsername: kickUsername });
  if (!quiet && panel) {
    panel.innerHTML = '<p class="subtitle">Loading...</p>';
  }

  const response = await fetch(`/api/rewards/summary/${encodeURIComponent(kickUsername)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Lookup failed");

  onlyPixelsState.lastSummary = data;
  applyOnlyPixelsSummary(data);
  return data;
}

async function loadOnlyPixelsRegistration(username) {
  if (!username) return;
  try {
    const response = await fetch(`/api/rewards/register/${encodeURIComponent(username)}`);
    if (!response.ok) return;
    const data = await response.json();
    onlyPixelsState.currentUsername = data.registration?.kickUsername || username;
    setOnlyPixelsStatus(
      `Streamer application submitted as @${onlyPixelsState.currentUsername}. Staff will review it here.`,
      "ok"
    );
    loadOnlyPixelsStats(onlyPixelsState.currentUsername, { quiet: true }).catch(() => {});
  } catch {
    // ignore
  }
}

function bindOnlyPixelsEvents() {
  if (onlyPixelsState.bound) return;
  onlyPixelsState.bound = true;
  bindOnlyPixelsPartnerEvents();

  document.getElementById("only-pixels-register-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("only-pixels-username");
    const kickUsername = input?.value?.trim();
    if (!kickUsername) return;

    setOnlyPixelsStatus("Submitting streamer application...");
    try {
      const data = await registerOnlyPixelsUsername(kickUsername);
      onlyPixelsState.currentUsername = data.registration.kickUsername;
      setOnlyPixelsStatus(
        `Streamer application submitted as @${onlyPixelsState.currentUsername}. Staff will review it here.`,
        "ok"
      );
      const lookup = document.getElementById("only-pixels-lookup-username");
      if (lookup) lookup.value = onlyPixelsState.currentUsername;
      renderOnlyPixelsApplication(data.application);
      loadOnlyPixelsStats(onlyPixelsState.currentUsername, { quiet: true }).catch(() => {});
    } catch (error) {
      setOnlyPixelsStatus(error.message, "err");
    }
  });

  document.getElementById("only-pixels-copy-code")?.addEventListener("click", async () => {
    const code = document.getElementById("only-pixels-code-value")?.textContent?.trim();
    if (!code || code === "------") return;
    try {
      await navigator.clipboard.writeText(code);
      setOnlyPixelsStatus("Link code copied.", "ok");
    } catch {
      setOnlyPixelsStatus("Could not copy — select the code manually.", "err");
    }
  });

  document.getElementById("only-pixels-refresh-code")?.addEventListener("click", async () => {
    const username =
      onlyPixelsState.currentUsername ||
      document.getElementById("only-pixels-username")?.value?.trim();
    if (!username) return;
    setOnlyPixelsStatus("Refreshing link code...");
    try {
      const data = await registerOnlyPixelsUsername(username);
      setOnlyPixelsLinkCode(data.linkCode || data.registration?.linkCode);
      setOnlyPixelsStatus("Link code refreshed.", "ok");
    } catch (error) {
      setOnlyPixelsStatus(error.message, "err");
    }
  });

  document.getElementById("only-pixels-lookup-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const kickUsername = document.getElementById("only-pixels-lookup-username")?.value?.trim();
    if (!kickUsername) return;
    try {
      await loadOnlyPixelsStats(kickUsername);
    } catch (error) {
      const panel = document.getElementById("only-pixels-stats");
      if (panel) {
        panel.innerHTML = `<p class="only-pixels-note err">${escapeHtml(error.message)}</p>`;
      }
    }
  });

  document.getElementById("only-pixels-refresh-stats")?.addEventListener("click", async () => {
    const kickUsername =
      onlyPixelsState.currentUsername ||
      document.getElementById("only-pixels-lookup-username")?.value?.trim() ||
      document.getElementById("only-pixels-username")?.value?.trim();
    if (!kickUsername) {
      setOnlyPixelsStatus("Register or enter your Kick username first.", "err");
      return;
    }
    try {
      await loadOnlyPixelsStats(kickUsername);
      setOnlyPixelsStatus("Points refreshed.", "ok");
    } catch (error) {
      setOnlyPixelsStatus(error.message, "err");
    }
  });
}

function refreshOnlyPixels(dashboard) {
  bindOnlyPixelsEvents();
  const profile = dashboard?.profile || sessionProfile;
  const role = dashboard?.role || sessionRole || dashboardRole || "player";
  const isOwner =
    role === "owner" ||
    dashboard?.isOwner === true ||
    dashboardRole === "owner" ||
    sessionRole === "owner";
  const usernameInput = document.getElementById("only-pixels-username");
  const lookupInput = document.getElementById("only-pixels-lookup-username");
  const lookupForm = document.getElementById("only-pixels-lookup-form");
  const kickName = profile?.username || onlyPixelsState.currentUsername || "";

  if (lookupForm) {
    lookupForm.classList.toggle("hidden", !isOwner);
  }

  loadOnlyPixelsApplication().catch((error) => {
    setOnlyPixelsStatus(error.message, "err");
  });

  if (kickName) {
    onlyPixelsState.currentUsername = kickName;
    onlyPixelsState.signedIn = true;
    setOnlyPixelsSignedInLabel(kickName, role);
    if (usernameInput) {
      usernameInput.value = kickName;
      usernameInput.readOnly = true;
    }
    if (lookupInput) lookupInput.value = kickName;
  } else if (!onlyPixelsState.signedIn) {
    setOnlyPixelsSignedInLabel("", role);
    renderOnlyPixelsPointsHero(null);
  }

  if (dashboard?.kickRewards) {
    applyOnlyPixelsSummary(dashboard.kickRewards);
  } else if (kickName) {
    renderOnlyPixelsPointsHero(null, { signedInUsername: kickName });
    loadOnlyPixelsStats(kickName, { quiet: true }).catch((error) => {
      const panel = document.getElementById("only-pixels-stats");
      if (panel) {
        panel.innerHTML = `<p class="only-pixels-note err">${escapeHtml(error.message)}</p>`;
      }
    });
  }

  if (kickName) {
    loadOnlyPixelsRegistration(kickName);
  }

  if (dashboard?.registration?.linkCode) {
    setOnlyPixelsLinkCode(dashboard.registration.linkCode);
  }
}

async function loadOnlyPixelsPartners() {
  const list = document.getElementById("only-pixels-partners-list");
  if (!list) return;
  const response = await fetch("/api/rewards/partner-applications");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || "Failed to load applications");
  }
  renderOnlyPixelsPartners(data.applications || []);
}

function renderOnlyPixelsPartners(applications) {
  const list = document.getElementById("only-pixels-partners-list");
  if (!list) return;
  if (!applications.length) {
    list.innerHTML = '<p class="subtitle">No applications yet.</p>';
    return;
  }
  const counts = applications.reduce((bag, row) => {
    const status = row.status || "pending";
    bag[status] = (bag[status] || 0) + 1;
    return bag;
  }, {});
  const countLabel = `<p class="subtitle" style="margin-bottom:8px;">${counts.pending || 0} pending · ${counts.approved || 0} approved · ${counts.banned || 0} banned</p>`;
  list.innerHTML =
    countLabel +
    applications
      .map((row) => {
        const slug = row.kickUsername || "";
        const status = row.status || "pending";
        const statusLabel = status === "banned" ? "PARTNERSHIP DENIED" : status.toUpperCase();
        let actions = "";
        if (status === "pending") {
          actions = `
            <button class="btn btn-kick btn-compact" type="button" data-partner-action="approve" data-partner-slug="${escapeHtml(slug)}">Approve</button>
            <button class="btn btn-secondary btn-compact" type="button" data-partner-action="ban" data-partner-slug="${escapeHtml(slug)}">Deny partnership</button>`;
        } else if (status === "approved") {
          actions = `<button class="btn btn-secondary btn-compact" type="button" data-partner-action="ban" data-partner-slug="${escapeHtml(slug)}">Revoke partnership</button>`;
        } else {
          actions = `<button class="btn btn-secondary btn-compact" type="button" data-partner-action="unban" data-partner-slug="${escapeHtml(slug)}">Return to pending</button>`;
        }
        return `
        <div class="only-pixels-partner-row">
          <div class="only-pixels-partner-meta">
            <strong>@${escapeHtml(slug)}</strong>
            <span>${escapeHtml(statusLabel)}${row.broadcasterId ? ` · Kick id ${escapeHtml(String(row.broadcasterId))}` : ""}</span>
            ${row.reason ? `<span>Reason: ${escapeHtml(row.reason)}</span>` : ""}
            ${row.moderatedBy ? `<span>Last action by @${escapeHtml(row.moderatedBy)}</span>` : ""}
          </div>
          <div class="only-pixels-partner-actions">
            ${actions}
          </div>
        </div>`;
      })
      .join("");
}

function setOnlyPixelsPartnersStatus(message, type = "") {
  const el = document.getElementById("only-pixels-partners-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `only-pixels-note${type ? ` ${type}` : ""}`;
}

function refreshOnlyPixelsPartners(isStaff) {
  const panel = document.getElementById("only-pixels-partners-panel");
  if (!panel) {
    console.warn("[only-pixels] partners panel missing from DOM — hard refresh the page");
    return;
  }
  if (isStaff) {
    panel.classList.remove("hidden");
    panel.hidden = false;
  } else {
    panel.classList.add("hidden");
    panel.hidden = true;
    return;
  }
  loadOnlyPixelsPartners().catch((error) => {
    setOnlyPixelsPartnersStatus(error.message, "err");
    const list = document.getElementById("only-pixels-partners-list");
    if (list) {
      list.innerHTML = `<p class="only-pixels-note err">${escapeHtml(error.message)}</p>`;
    }
  });
}

function bindOnlyPixelsPartnerEvents() {
  if (onlyPixelsState.partnersBound) return;
  onlyPixelsState.partnersBound = true;

  document.getElementById("only-pixels-partners-refresh")?.addEventListener("click", async () => {
    setOnlyPixelsPartnersStatus("Refreshing…");
    try {
      await loadOnlyPixelsPartners();
      setOnlyPixelsPartnersStatus("");
    } catch (error) {
      setOnlyPixelsPartnersStatus(error.message, "err");
    }
  });

  document.getElementById("only-pixels-partners-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-partner-action]");
    if (!btn) return;
    const slug = btn.getAttribute("data-partner-slug");
    const action = btn.getAttribute("data-partner-action");
    if (!slug || !action) return;
    let reason = "";
    if (action === "ban") {
      reason = prompt(`Optional partnership denial reason for @${slug}:`, "") || "";
      if (!confirm(`Deny streamer partnership for @${slug}? They will keep viewer access.`)) return;
    }
    setOnlyPixelsPartnersStatus(`${action === "approve" ? "Approving" : action === "ban" ? "Denying partnership for" : "Returning"} @${slug}…`);
    try {
      const response = await fetch(`/api/rewards/partner-applications/${encodeURIComponent(slug)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Moderation action failed");
      setOnlyPixelsPartnersStatus(`@${slug} is now ${data.application?.status || action}.`, "ok");
      renderOnlyPixelsPartners(data.applications || []);
    } catch (error) {
      setOnlyPixelsPartnersStatus(error.message, "err");
    }
  });
}

if (location.hash === "#only-pixels") {
  currentPage = "only-pixels";
}
if (location.hash === "#discord" || location.hash.startsWith("#discord?")) {
  currentPage = "discord";
}

function setDiscordStatus(message, type = "") {
  const el = document.getElementById("discord-sub-status");
  if (!el) return;
  el.textContent = message;
  el.className = `only-pixels-note${type ? ` ${type}` : ""}`;
}

function setDiscordStatusValue(id, text, stateClass = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `discord-status-value${stateClass ? ` ${stateClass}` : ""}`;
}

function renderDiscordPanel(status = {}) {
  const linked = Boolean(status.linked);
  const active = Boolean(status.activeSubscriber);
  const granted = Boolean(status.roleGranted);
  const configured = Boolean(status.discordConfigured);
  const kickName = status.kickUsername || "unknown";
  const isOwner = status.eligibilityReason === "owner";

  const kickEl = document.getElementById("discord-status-kick");
  if (kickEl) kickEl.textContent = `@${kickName}`;

  if (isOwner) {
    setDiscordStatusValue("discord-status-kick-state", "Owner", "is-owner");
  } else if (active) {
    setDiscordStatusValue("discord-status-kick-state", "Subscribed", "is-yes");
  } else {
    setDiscordStatusValue("discord-status-kick-state", "Not subscribed", "is-no");
  }

  if (linked) {
    setDiscordStatusValue(
      "discord-status-discord-state",
      `Linked${status.discordUsername ? ` · ${status.discordUsername}` : ""}`,
      "is-yes"
    );
  } else {
    setDiscordStatusValue("discord-status-discord-state", "Not linked", "is-no");
  }

  if (granted) {
    setDiscordStatusValue("discord-status-role-state", "Granted", "is-yes");
  } else if (!configured) {
    setDiscordStatusValue("discord-status-role-state", "Bot not configured", "is-warn");
  } else {
    setDiscordStatusValue("discord-status-role-state", "Not granted", "is-warn");
  }

  const lines = [];
  if (!configured) {
    lines.push("Discord bot env vars are missing on the server.");
  } else if (isOwner) {
    lines.push("You’re the channel owner — subscriber role is allowed.");
  } else if (active) {
    lines.push(
      status.expiresAt
        ? `Kick sub on record until ${new Date(status.expiresAt).toLocaleString()}`
        : "Kick sub on record"
    );
  } else {
    lines.push(status.note || `No Kick sub on record for @${kickName} yet.`);
  }
  if (!linked) lines.push("Link Discord to claim the role.");
  setDiscordStatus(lines.join(" "), active && linked ? "ok" : "");

  const claimBtn = document.getElementById("discord-claim-btn");
  const unlinkBtn = document.getElementById("discord-unlink-btn");
  const linkBtn = document.getElementById("discord-link-btn");
  if (claimBtn) claimBtn.disabled = !configured || !linked;
  if (unlinkBtn) unlinkBtn.disabled = !linked;
  if (linkBtn) linkBtn.textContent = linked ? "Relink Discord" : "Link Discord";
}

async function refreshDiscordPanel(dashboard) {
  try {
    const response = await fetch("/api/discord/status");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load Discord status");
    renderDiscordPanel(data);
    if (dashboard) dashboard.discord = data;
  } catch (error) {
    setDiscordStatus(error.message, "err");
  }

  const ownerPanel = document.getElementById("discord-owner-subs-panel");
  if (ownerPanel && (dashboardRole === "owner" || dashboardData?.role === "owner")) {
    ownerPanel.classList.remove("hidden");
    refreshDiscordOwnerSubs();
  }
}

async function refreshDiscordOwnerSubs() {
  const list = document.getElementById("discord-owner-subs-list");
  if (!list) return;
  try {
    const response = await fetch("/api/discord/subscribers");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load roster");
    const rows = data.subscribers || [];
    if (!rows.length) {
      list.innerHTML =
        '<p class="subtitle">No active subs tracked yet — new/renew/gift webhooks will fill this.</p>';
    } else {
      list.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Kick user</th><th>Expires</th><th>Source</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (row) => `<tr>
                <td>${escapeHtml(row.username)}</td>
                <td>${escapeHtml(row.expiresAt ? new Date(row.expiresAt).toLocaleString() : "—")}</td>
                <td>${escapeHtml(row.source || "—")}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    }
    renderDiscordRecheckMeta(data);
  } catch (error) {
    list.innerHTML = `<p class="subtitle err">${escapeHtml(error.message)}</p>`;
  }
  refreshDiscordPanelMeta();
}

function renderDiscordRecheckMeta(data = {}) {
  const el = document.getElementById("discord-recheck-meta");
  if (!el) return;
  const run = data.recheck;
  const intervalMin = Math.round((data.recheckIntervalMs || 900000) / 60000);
  const batch = data.recheckBatchSize || 8;
  const parts = [
    `Every ~${intervalMin}m, randomly checks up to ${batch} people with the Discord role. Expired Kick subs lose the role; channel owner is kept.`,
  ];
  if (run?.finishedAt) {
    parts.push(
      `Last run ${escapeHtml(new Date(run.finishedAt).toLocaleString())}: checked ${run.checked || 0}, kept ${run.kept || 0}, revoked ${run.revoked || 0}.`
    );
  } else {
    parts.push("No recheck has run yet since the last deploy.");
  }
  const activeGrants = (data.grants || []).filter((g) => g.active);
  parts.push(`Active Discord role grants on record: ${activeGrants.length}.`);
  el.innerHTML = parts.join(" ");
  renderDiscordRoleWatchMeta(data);
}

function renderDiscordRoleWatchMeta(data = {}) {
  const el = document.getElementById("discord-role-watch-meta");
  if (!el) return;
  const watch = data.roleWatch || {};
  const parts = [
    "Watches Discord audit logs so manually adding/removing the subscriber role posts in #kick.",
  ];
  if (!watch.enabled) {
    parts.push("Currently disabled (DISCORD_ROLE_WATCH=0).");
  } else if (!watch.started) {
    parts.push("Not started yet — waiting for Discord config / deploy.");
  } else {
    const secs = Math.round((watch.pollMs || 12000) / 1000);
    parts.push(`Polling every ~${secs}s.`);
    if (watch.lastPollAt) {
      parts.push(`Last poll ${escapeHtml(new Date(watch.lastPollAt).toLocaleString())}.`);
    }
    if (watch.lastEventAt) {
      parts.push(
        `Last manual role event ${escapeHtml(new Date(watch.lastEventAt).toLocaleString())} (${watch.eventsSeen || 0} total).`
      );
    } else {
      parts.push("No manual role events seen yet since deploy.");
    }
  }
  if (watch.lastError) {
    parts.push(
      `<span class="err">Error: ${escapeHtml(watch.lastError)}. Grant the bot View Audit Log` +
        (data.botInviteUrl
          ? ` — <a href="${escapeHtml(data.botInviteUrl)}" target="_blank" rel="noopener">re-invite bot</a>`
          : "") +
        ".</span>"
    );
  } else if (watch.started) {
    parts.push("Bot needs View Audit Log permission.");
  }
  el.innerHTML = parts.join(" ");
}

async function refreshDiscordPanelMeta() {
  const meta = document.getElementById("discord-panel-meta");
  if (!meta) return;
  try {
    const response = await fetch("/api/discord/panel");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load panel info");
    const parts = [
      `Channel <code>${escapeHtml(data.channelId || "—")}</code>.`,
    ];
    if (data.panel?.messageId) {
      parts.push(
        `Last posted message <code>${escapeHtml(data.panel.messageId)}</code>` +
          (data.panel.postedAt
            ? ` at ${escapeHtml(new Date(data.panel.postedAt).toLocaleString())}`
            : "") +
          "."
      );
    } else {
      parts.push("No panel posted from na5ty.com yet.");
    }
    if (!data.publicKeyConfigured || data.publicKeyStatus?.valid === false) {
      const keyErr = data.publicKeyStatus?.error
        ? escapeHtml(data.publicKeyStatus.error)
        : "Add DISCORD_PUBLIC_KEY";
      parts.push(
        `<strong>${keyErr}</strong>. Then set Interactions URL to ` +
          `<code>${escapeHtml(data.interactionsUrl || "/api/discord/interactions")}</code> ` +
          "in the Discord Developer Portal (General Information → Public Key + Interactions Endpoint URL)."
      );
    }
    if (data.botInviteUrl) {
      parts.push(
        `If post says Missing Access, give the bot channel perms or ` +
          `<a href="${escapeHtml(data.botInviteUrl)}" target="_blank" rel="noopener">re-invite the bot</a>.`
      );
    }
    parts.push(
      "Manual Discord role add/remove is watched when <strong>Server Members Intent</strong> is enabled " +
        "(Developer Portal → Bot → Privileged Gateway Intents)."
    );
    meta.innerHTML = parts.join(" ");
  } catch (error) {
    meta.textContent = error.message;
  }
}

document.getElementById("discord-claim-btn")?.addEventListener("click", async () => {
  setDiscordStatus("Claiming subscriber role...");
  try {
    const response = await fetch("/api/discord/claim", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Claim failed");
    renderDiscordPanel(data.discord || {});
    setDiscordStatus(data.message || "Role granted.", "ok");
  } catch (error) {
    setDiscordStatus(error.message, "err");
  }
});

document.getElementById("discord-refresh-btn")?.addEventListener("click", () => {
  refreshDiscordPanel(dashboardData);
});

document.getElementById("discord-owner-refresh")?.addEventListener("click", () => {
  refreshDiscordOwnerSubs();
});

document.getElementById("discord-post-panel-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("discord-post-panel-btn");
  if (btn) btn.disabled = true;
  setDiscordStatus("Posting Discord channel panel...");
  try {
    const response = await fetch("/api/discord/panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not post panel");
    if (data.warning) {
      setDiscordStatus(data.warning, "err");
    } else {
      setDiscordStatus(data.message || "Panel posted.", "ok");
    }
    refreshDiscordPanelMeta();
  } catch (error) {
    setDiscordStatus(error.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function postDiscordAnnounceTest(action) {
  const response = await fetch("/api/discord/announce-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || "Announce test failed");
  }
  return data;
}

document.getElementById("discord-test-thankyou-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("discord-test-thankyou-btn");
  if (btn) btn.disabled = true;
  setDiscordStatus("Posting public thank-you test...");
  try {
    const data = await postDiscordAnnounceTest("granted");
    setDiscordStatus(data.message || "Posted.", data.posted ? "ok" : "err");
  } catch (error) {
    setDiscordStatus(error.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("discord-test-revoke-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("discord-test-revoke-btn");
  if (btn) btn.disabled = true;
  setDiscordStatus("Posting public role-removed test...");
  try {
    const data = await postDiscordAnnounceTest("revoked");
    setDiscordStatus(data.message || "Posted.", data.posted ? "ok" : "err");
  } catch (error) {
    setDiscordStatus(error.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("discord-recheck-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("discord-recheck-btn");
  if (btn) btn.disabled = true;
  setDiscordStatus("Rechecking Discord subscriber roles...");
  try {
    const response = await fetch("/api/discord/recheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forceAll: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || data.reason || "Recheck failed");
    }
    setDiscordStatus(
      `Recheck done — checked ${data.checked || 0}, kept ${data.kept || 0}, revoked ${data.revoked || 0}.`,
      "ok"
    );
    refreshDiscordOwnerSubs();
  } catch (error) {
    setDiscordStatus(error.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("discord-mark-sub-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("discord-mark-sub-btn");
  const input = document.getElementById("discord-mark-sub-username");
  const username = input?.value?.trim();
  if (!username) {
    setDiscordStatus("Enter a Kick username to mark as sub.", "err");
    return;
  }
  if (btn) btn.disabled = true;
  setDiscordStatus(`Marking @${username} as an active Kick sub...`);
  try {
    const response = await fetch("/api/discord/mark-subscriber", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || "Could not mark subscriber");
    }
    setDiscordStatus(data.message || `Marked @${username}.`, "ok");
    if (input) input.value = "";
    refreshDiscordOwnerSubs();
  } catch (error) {
    setDiscordStatus(error.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("discord-unlink-btn")?.addEventListener("click", async () => {
  if (!confirm("Unlink Discord and remove the subscriber role if present?")) return;
  try {
    const response = await fetch("/api/discord/unlink", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unlink failed");
    renderDiscordPanel(data.discord || {});
  } catch (error) {
    setDiscordStatus(error.message, "err");
  }
});

