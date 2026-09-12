const DEFAULT_AVATAR =
  "https://kick.com/img/default-profile-pictures/default-avatar-2.webp";

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

const KICK_EMOTE_CDN = "https://files.kick.com/emotes";
const emoteNameCache = new Map();

function rememberEmotes(emotes = []) {
  for (const emote of emotes) {
    if (emote?.id && emote?.name) {
      emoteNameCache.set(String(emote.name).toLowerCase(), {
        id: String(emote.id),
        source: emote.source === "twitch" ? "twitch" : "kick",
      });
    }
  }
}

const TWITCH_EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";

function emoteImgTag(id, name, source = "kick") {
  const safeId = escapeAttr(String(id));
  const safeName = escapeHtml(String(name || ""));
  const src =
    source === "twitch"
      ? `${TWITCH_EMOTE_CDN}/${safeId}/default/dark/2.0`
      : `${KICK_EMOTE_CDN}/${safeId}/fullsize`;
  return `<img class="chat-emote" src="${src}" alt=":${safeName}:" title=":${safeName}:" loading="lazy">`;
}

function formatChatContent(content, emotes = []) {
  rememberEmotes(emotes);
  const text = String(content || "");
  const byName = new Map(emoteNameCache);

  const parts = [];
  const emoteToken = /\[emote:(\d+):([^\]]+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = emoteToken.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "emote", id: match[1], name: match[2], source: "kick" });
    emoteNameCache.set(String(match[2]).toLowerCase(), { id: String(match[1]), source: "kick" });
    lastIndex = match.index + match[0].length;
  }

  if (!parts.length) {
    parts.push({ type: "text", value: text });
  } else if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }

  let html = "";
  for (const part of parts) {
    if (part.type === "emote") {
      html += emoteImgTag(part.id, part.name, part.source || "kick");
      continue;
    }

    let chunk = escapeHtml(part.value);
    chunk = chunk.replace(/:([a-zA-Z0-9_]+):/g, (full, name) => {
      const hit = byName.get(name.toLowerCase());
      if (!hit) return full;
      const id = typeof hit === "string" ? hit : hit.id;
      const source = typeof hit === "string" ? "kick" : hit.source;
      return emoteImgTag(id, name, source);
    });
    for (const emote of emotes || []) {
      if (emote?.source !== "twitch" || !emote.name) continue;
      const token = escapeHtml(String(emote.name));
      if (!token) continue;
      chunk = chunk.split(token).join(emoteImgTag(emote.id, emote.name, "twitch"));
    }
    html += chunk;
  }

  return html;
}

function lineClass(message) {
  if (message.isModerator || message.isBroadcaster) return "mod broadcaster";
  if (message.isSubscriber) return "sub";
  return "";
}

function renderMessage(message) {
  const isTwitch = message.platform === "twitch" || message.source === "twitch";
  const avatar = message.profilePicture || DEFAULT_AVATAR;
  const platform = isTwitch
    ? `<span class="chat-platform chat-platform--twitch" title="Twitch">TW</span>`
    : "";
  return `
    <div class="chat-line ${lineClass(message)}${isTwitch ? " twitch" : ""}" data-id="${escapeAttr(message.id)}">
      <img
        class="chat-avatar"
        src="${escapeAttr(avatar)}"
        alt=""
        loading="eager"
        onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}'"
      >
      <div class="chat-body">
        <span class="chat-user">${platform}${escapeHtml(message.username)}</span>
        <span class="chat-text">${formatChatContent(message.content, message.emotes)}</span>
      </div>
    </div>
  `;
}

function startChatBoxWidget(options = {}) {
  const root = options.root || document.getElementById("chatWidget");
  const listEl = options.listEl || document.getElementById("chatMessages");
  const statusEl = options.statusEl || document.getElementById("chatStatus");
  const params = new URLSearchParams(location.search);
  const obsMode = params.get("obs") === "1" || params.get("obs") === "true";
  const embedMode = params.get("embed") === "1" || params.get("embed") === "true";
  const maxMessages = Math.max(5, parseInt(params.get("max"), 10) || 25);
  const broadcasterId = params.get("broadcasterId");

  if (!root || !listEl) return;

  const baseUrl = location.protocol.startsWith("http")
    ? `${location.protocol}//${location.host}`
    : "http://127.0.0.1:3000";
  const apiQuery = new URLSearchParams({ limit: String(maxMessages) });
  if (broadcasterId) apiQuery.set("broadcasterId", broadcasterId);
  const API_MESSAGES = `${baseUrl}/api/chat/messages?${apiQuery.toString()}`;
  const API_EVENTS = `${baseUrl}/api/chat/events`;

  if (params.get("compact") === "1") {
    root.classList.add("compact");
  }

  const width = parseInt(params.get("width"), 10);
  if (width > 0) {
    document.documentElement.style.setProperty("--chat-stack-width", `${width}px`);
  }

  const seen = new Set();
  let messages = [];
  let lastFingerprint = "";
  let initialized = false;
  let sseConnected = false;
  let pollTimer = null;

  function setStatus(text, kind = "") {
    if (!statusEl || params.get("debug") !== "1") return;
    statusEl.textContent = text;
    statusEl.className = `chat-status${kind ? ` ${kind}` : ""}`;
  }

  function fingerprint(msgs) {
    return msgs.map((message) => message.id).join("|");
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight;
    });
  }

  function showEmpty() {
    if (listEl.querySelector(".chat-empty")) return;
    const hint = "No messages yet — na5ty.com → Widgets → Send test chat";
    listEl.innerHTML = `<div class="chat-empty">${hint}</div>`;
  }

  function createMessageElement(message, animate = true) {
    const holder = document.createElement("div");
    holder.innerHTML = renderMessage(message).trim();
    const element = holder.firstElementChild;
    if (!animate) {
      element.style.animation = "none";
    }
    return element;
  }

  function trimOldest() {
    while (messages.length > maxMessages) {
      messages.shift();
      const oldest = listEl.querySelector(".chat-line");
      if (oldest) oldest.remove();
    }
  }

  function appendMessage(message, { animate = true } = {}) {
    if (!message?.id || seen.has(message.id)) return false;

    seen.add(message.id);
    messages.push(message);

    const empty = listEl.querySelector(".chat-empty");
    if (empty) empty.remove();

    listEl.appendChild(createMessageElement(message, animate));
    trimOldest();
    scrollToBottom();
    lastFingerprint = fingerprint(messages);
    return true;
  }

  function hydrateInitial(nextMessages = []) {
    const trimmed = nextMessages.slice(-maxMessages);
    messages = [];
    seen.clear();
    listEl.innerHTML = "";

    if (!trimmed.length) {
      showEmpty();
      lastFingerprint = "";
      return;
    }

    for (const message of trimmed) {
      appendMessage(message, { animate: false });
    }
    lastFingerprint = fingerprint(messages);
  }

  function syncNewMessages(nextMessages = []) {
    const trimmed = nextMessages.slice(-maxMessages);
    const fp = fingerprint(trimmed);
    if (fp === lastFingerprint) return;

    for (const message of trimmed) {
      appendMessage(message, { animate: true });
    }
    lastFingerprint = fingerprint(messages);
  }

  async function fetchMessages() {
    const response = await fetch(API_MESSAGES, { cache: "no-store" });
    if (!response.ok) throw new Error(`Chat API ${response.status}`);
    const data = await response.json();
    return data.messages || [];
  }

  async function pollMessages() {
    try {
      const latest = await fetchMessages();

      if (!initialized) {
        hydrateInitial(latest);
        initialized = true;
        setStatus(latest.length ? "Live" : "Waiting for chat", latest.length ? "live" : "");
        return;
      }

      syncNewMessages(latest);
      setStatus(messages.length ? "Live" : "Waiting for chat", messages.length ? "live" : "");
    } catch (error) {
      console.error("Chat widget poll error:", error);
      setStatus("Chat server offline", "error");
    }
  }

  function schedulePoll(ms) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollMessages, ms);
  }

  function connectEvents() {
    const source = new EventSource(API_EVENTS);

    source.onopen = () => {
      sseConnected = true;
      schedulePoll(obsMode ? 4000 : 8000);
      setStatus(messages.length ? "Live" : "Connected", messages.length ? "live" : "");
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.event === "message" && payload.message) {
          if (
            broadcasterId &&
            payload.message.broadcasterUserId &&
            String(payload.message.broadcasterUserId) !== String(broadcasterId)
          ) {
            return;
          }
          appendMessage(payload.message, { animate: true });
          setStatus("Live", "live");
        }
      } catch (error) {
        console.error("Chat widget event error:", error);
      }
    };

    source.onerror = () => {
      sseConnected = false;
      source.close();
      setStatus("Reconnecting...", "error");
      schedulePoll(obsMode ? 1500 : 2500);
      setTimeout(connectEvents, 2000);
    };
  }

  const pollMs = embedMode ? 1500 : obsMode ? 2500 : 5000;
  pollMessages();
  connectEvents();
  schedulePoll(pollMs);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollMessages();
  });
}
