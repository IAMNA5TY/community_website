const WebSocket = require("ws");
const kickRewardsStore = require("./kick-rewards-store");
const { fetchChannelV2, slugVariants } = require("./kick-channel-client");
const { parseChatControlAction } = require("./kick-chat-actions");

const PUSHER_URL =
  process.env.KICK_PUSHER_URL ||
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false";

const REFRESH_MS = Math.max(15000, Number(process.env.KICK_PUSHER_REFRESH_MS) || 30000);
const DEBUG_SLUGS = new Set(
  String(process.env.KICK_CHAT_DEBUG_SLUGS || "")
    .split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean)
);
const DEBUG_LOG_MAX = 40;

function isKickChatMessageEvent(eventName) {
  if (!eventName) return false;
  const event = String(eventName);
  if (event === "App\\Events\\ChatMessageEvent") return true;
  if (event.includes("ChatMessageEvent")) return true;
  const lower = event.toLowerCase().replace(/\\/g, "/");
  if (
    lower.includes("livechatmessage") ||
    lower.includes("chatroommessage") ||
    lower.includes("channelchatmessage")
  ) {
    return true;
  }
  return false;
}

function extractChatPayload(messageData) {
  if (!messageData || typeof messageData !== "object") {
    return { username: "", content: "" };
  }

  const sender = messageData.sender || messageData.user || {};
  const username = String(
    sender.username || sender.slug || messageData.username || ""
  )
    .trim()
    .replace(/^@/, "");

  const content = String(
    messageData.content ||
      messageData.message ||
      messageData.text ||
      messageData.body ||
      ""
  ).trim();

  return { username, content };
}

class StreamMonitor {
  constructor(slug) {
    this.slug = String(slug || "").toLowerCase();
    this.ws = null;
    this.chatroomId = null;
    this.channelId = null;
    this.streamId = null;
    this.stopped = false;
    this.reconnectDelay = 5000;
    this.reconnectTimer = null;
    this.messagesRecorded = 0;
    this.lastMessageAt = null;
    this.connected = false;
    this.lastError = null;
    this.recentDebugLog = [];
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.start().catch((error) => {
        this.lastError = error.message;
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(Math.floor(this.reconnectDelay * 1.4), 60000);
  }

  subscribe(channel) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel },
      })
    );
  }

  onMessage(raw) {
    let packet;
    try {
      packet = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (packet.event === "pusher:ping") {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
      }
      return;
    }

    if (!isKickChatMessageEvent(packet.event)) return;

    let messageData = packet.data;
    if (typeof messageData === "string") {
      try {
        messageData = JSON.parse(messageData);
      } catch {
        return;
      }
    }

    const { username, content } = extractChatPayload(messageData);
    if (!username || !content) return;

    const control = parseChatControlAction(content);
    const entry = {
      at: new Date().toISOString(),
      username,
      content: content.slice(0, 200),
      keyword: control?.action || null,
    };

    if (DEBUG_SLUGS.has(this.slug)) {
      this.recentDebugLog.unshift(entry);
      if (this.recentDebugLog.length > DEBUG_LOG_MAX) {
        this.recentDebugLog.length = DEBUG_LOG_MAX;
      }
      console.log(
        `[pusher-monitor][${this.slug}] ${username}: ${content.slice(0, 120)}${control?.action ? ` → ${control.action}` : ""}`
      );
    }

    kickRewardsStore.recordChatMessage({
      streamer: this.slug,
      username,
      content,
      createdAt: new Date().toISOString(),
    });
    this.messagesRecorded += 1;
    this.lastMessageAt = new Date().toISOString();
  }

  async connectSocket() {
    if (!this.chatroomId || this.stopped) return;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(PUSHER_URL);
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.reconnectDelay = 5000;
        this.subscribe(`chatrooms.${this.chatroomId}.v2`);
        this.subscribe(`chatroom_${this.chatroomId}`);
        if (this.channelId) {
          this.subscribe(`channel.${this.channelId}`);
        }
        if (this.streamId) {
          this.subscribe(`livestream.${this.streamId}`);
        }
        console.log(`[pusher-monitor] connected ${this.slug} chatroom=${this.chatroomId}`);
        resolve();
      });

      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", () => this.scheduleReconnect());
      ws.on("error", (error) => {
        this.lastError = error.message;
        reject(error);
      });
    });
  }

  async start() {
    if (this.stopped) return;
    this.clearReconnect();

    const stored = kickRewardsStore.getStoredChannelMeta(this.slug);
    if (stored?.chatroomId && !this.chatroomId) {
      this.chatroomId = stored.chatroomId;
      this.channelId = stored.channelId || null;
    }

    if (!this.chatroomId) {
      let channel = null;
      for (const variant of slugVariants(this.slug)) {
        try {
          channel = await fetchChannelV2(variant);
          if (channel?.chatroom?.id) break;
        } catch (error) {
          this.lastError = error.message;
        }
      }
      this.chatroomId = channel?.chatroom?.id || null;
      this.channelId = channel?.chatroom?.channel_id || channel?.id || null;
      this.streamId = channel?.livestream?.id || null;

      if (this.chatroomId) {
        try {
          kickRewardsStore.upsertMonitoredStreamer(this.slug, null, {
            chatroomId: this.chatroomId,
            channelId: this.channelId,
          });
        } catch {
          // ignore persist errors
        }
      }
    }

    if (!this.chatroomId) {
      this.lastError = this.lastError || "no chatroom id";
      // Slow retry — avoid hammering Kick when many channels fail.
      this.reconnectDelay = Math.max(this.reconnectDelay, 45000);
      this.scheduleReconnect();
      return;
    }

    this.lastError = null;
    await this.connectSocket();
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  status() {
    return {
      slug: this.slug,
      connected: this.connected,
      chatroomId: this.chatroomId,
      messagesRecorded: this.messagesRecorded,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      recentDebugLog: DEBUG_SLUGS.has(this.slug) ? this.recentDebugLog.slice(0, DEBUG_LOG_MAX) : undefined,
    };
  }
}

class KickPusherMonitor {
  constructor() {
    this.monitors = new Map();
    this.refreshTimer = null;
    this.started = false;
    this.startQueue = [];
    this.startRunning = false;
  }

  async drainStartQueue() {
    if (this.startRunning) return;
    this.startRunning = true;
    while (this.startQueue.length) {
      const slug = this.startQueue.shift();
      if (!slug || this.monitors.has(slug)) continue;
      const monitor = new StreamMonitor(slug);
      this.monitors.set(slug, monitor);
      try {
        await monitor.start();
        console.log(`[pusher-monitor] started ${slug}`);
      } catch (error) {
        console.warn(`[pusher-monitor] ${slug} failed to start:`, error.message);
      }
      // Stagger Kick channel lookups to avoid Cloudflare / rate limits.
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    this.startRunning = false;
  }

  refreshTargets() {
    // Only watch real chat partners — not every Kick City DB row (was 40+ and broke lookups).
    const slugs = new Set(
      typeof kickRewardsStore.getChatMonitorSlugs === "function"
        ? kickRewardsStore.getChatMonitorSlugs()
        : kickRewardsStore.getMonitoredStreamers()
    );
    const extra = String(process.env.KICK_MONITOR_EXTRA_SLUGS || "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean);
    for (const slug of extra) slugs.add(slug);

    for (const [slug, monitor] of this.monitors) {
      if (!slugs.has(slug)) {
        monitor.stop();
        this.monitors.delete(slug);
        console.log(`[pusher-monitor] stopped ${slug}`);
      }
    }

    for (const slug of slugs) {
      if (!this.monitors.has(slug) && !this.startQueue.includes(slug)) {
        this.startQueue.push(slug);
      }
    }
    this.drainStartQueue().catch((error) => {
      console.warn("[pusher-monitor] start queue error:", error.message);
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    console.log("[pusher-monitor] starting Kick Pusher chat monitor");
    this.refreshTargets();
    this.refreshTimer = setInterval(() => this.refreshTargets(), REFRESH_MS);
  }

  stop() {
    this.started = false;
    this.startQueue = [];
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
  }

  getStatus() {
    return {
      enabled: this.started,
      streamers: [...this.monitors.values()].map((monitor) => monitor.status()),
      monitoredSlugs:
        typeof kickRewardsStore.getChatMonitorSlugs === "function"
          ? kickRewardsStore.getChatMonitorSlugs()
          : kickRewardsStore.getMonitoredStreamers(),
      queuedStarts: this.startQueue.length,
    };
  }
}

module.exports = new KickPusherMonitor();
