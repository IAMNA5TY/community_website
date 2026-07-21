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

    // Owner-channel OBS chat + commands — chat.message.sent webhook is off on purpose.
    this.forwardOwnerChat(messageData, username, content);
  }

  isOwnerChannel() {
    const ownerSlug = String(
      process.env.KICK_OWNER_SLUG ||
        process.env.DEFAULT_BROADCASTER_SLUG ||
        "na5ty"
    ).toLowerCase();
    return this.slug === ownerSlug;
  }

  ownerBroadcasterId() {
    return String(
      kickRewardsStore.getBroadcasterIdForSlug?.(this.slug) ||
        this.channelId ||
        process.env.DEFAULT_BROADCASTER_ID ||
        "1183030"
    );
  }

  buildOwnerChatPayload(messageData, username, content) {
    const sender = messageData.sender || messageData.user || {};
    const badges = sender.identity?.badges || sender.badges || [];
    return {
      message_id:
        messageData.id ||
        messageData.message_id ||
        `pusher-${this.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      created_at: messageData.created_at || new Date().toISOString(),
      emotes: messageData.emotes || [],
      sender: {
        username,
        user_id: sender.id || sender.user_id || sender.userId || null,
        profile_picture:
          sender.profile_picture ||
          sender.profilePicture ||
          sender.profile_pic ||
          null,
        identity: sender.identity || { badges },
        is_broadcaster: Boolean(sender.is_broadcaster || sender.slug === this.slug),
        is_moderator: Boolean(
          sender.is_moderator ||
            badges.some?.((badge) =>
              ["moderator", "broadcaster"].includes(
                String(badge.type || badge.name || "").toLowerCase()
              )
            )
        ),
        is_subscriber: Boolean(sender.is_subscriber || sender.isSubscriber),
      },
    };
  }

  forwardOwnerChat(messageData, username, content) {
    if (!this.isOwnerChannel()) return;

    const ownerId = this.ownerBroadcasterId();
    const payload = this.buildOwnerChatPayload(messageData, username, content);
    const isWorkoutCommand =
      /^[!/](walk|start|stop|reset)\b/i.test(content) ||
      /^[!/]walk\s*[+-]/i.test(content);

    // Feed OBS / Streamlabs chat-box (/api/chat/messages + SSE).
    try {
      const eventStore = require("./event-store");
      const chatEvents = require("./chat-events");
      const message = eventStore.addChatMessage(ownerId, payload);
      chatEvents.broadcastMessage(message);
    } catch (error) {
      console.warn(`[pusher-monitor] OBS chat store failed: ${error.message}`);
    }

    const bumpMessageCount = () => {
      try {
        require("./workout-state").incrementMessagesForBroadcaster?.(ownerId);
      } catch {
        /* ignore */
      }
    };

    try {
      const botEngine = require("./bot-engine");
      const kickConfig = {
        clientId: process.env.KICK_CLIENT_ID,
        clientSecret: process.env.KICK_CLIENT_SECRET,
        redirectUri: process.env.KICK_REDIRECT_URI,
      };

      // Workout commands: update bank first, then count the chat line.
      // Normal chat: count immediately.
      if (!isWorkoutCommand) bumpMessageCount();

      botEngine
        .handleChatMessage(ownerId, payload, kickConfig)
        .catch((error) => {
          console.warn(`[pusher-monitor] bot command failed: ${error.message}`);
        })
        .finally(() => {
          if (isWorkoutCommand) bumpMessageCount();
        });
    } catch (error) {
      console.warn(`[pusher-monitor] bot engine unavailable: ${error.message}`);
      bumpMessageCount();
    }
  }

  async connectSocket() {
    if (!this.chatroomId || this.stopped) return;

    // Drop any stale socket first (same effect as the Reconnect button).
    if (this.ws) {
      try {
        this.ws.removeAllListeners("close");
        this.ws.removeAllListeners("error");
        this.ws.removeAllListeners("message");
        this.ws.removeAllListeners("open");
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;

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
      ws.on("close", () => {
        this.connected = false;
        this.scheduleReconnect();
      });
      ws.on("error", (error) => {
        this.lastError = error.message;
        this.connected = false;
        reject(error);
      });
    });
  }

  async start() {
    // Allow auto-restart after a previous stop/reconnect cycle.
    this.stopped = false;
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
            chatPriority: true,
          });
        } catch {
          // ignore persist errors
        }
      }
    }

    if (!this.chatroomId) {
      this.lastError = this.lastError || "no chatroom id";
      // Don't self-reconnect in a tight loop — KickPusherMonitor retries slowly.
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
    this.retryTimer = null;
    this.started = false;
    this.startQueue = [];
    this.startRunning = false;
    this.failedAt = new Map(); // slug -> timestamp of last failed chatroom lookup
  }

  async drainStartQueue() {
    if (this.startRunning) return;
    this.startRunning = true;
    try {
      while (this.startQueue.length) {
        const slug = this.startQueue.shift();
        if (!slug) continue;

        let monitor = this.monitors.get(slug);
        if (!monitor) {
          monitor = new StreamMonitor(slug);
          this.monitors.set(slug, monitor);
        }

        const meta = kickRewardsStore.getStoredChannelMeta?.(slug);
        const hasCache = Boolean(meta?.chatroomId || monitor.chatroomId);

        // Skip rapid re-lookup if this slug recently failed chatroom resolve.
        // Keep the monitor instance so status/debug shows it; retryOneFailed will retry.
        const failedAt = this.failedAt.get(slug) || 0;
        if (!hasCache && !monitor.chatroomId && Date.now() - failedAt < 20000) {
          continue;
        }

        try {
          // Cached chatroom connects are fast; only give long timeout to Kick lookups.
          const timeoutMs = hasCache ? 15000 : 45000;
          await Promise.race([
            monitor.start(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("monitor start timeout")), timeoutMs)
            ),
          ]);
          if (monitor.chatroomId) {
            this.failedAt.delete(slug);
            console.log(`[pusher-monitor] started ${slug} chatroom=${monitor.chatroomId}`);
          } else {
            this.failedAt.set(slug, Date.now());
            console.warn(`[pusher-monitor] ${slug} waiting for chatroom id`);
          }
        } catch (error) {
          this.failedAt.set(slug, Date.now());
          console.warn(`[pusher-monitor] ${slug} failed to start:`, error.message);
        }
        // Stagger only when we had to hit Kick/Cloudflare for a chatroom id.
        await new Promise((resolve) => setTimeout(resolve, hasCache ? 150 : 2500));
      }
    } finally {
      this.startRunning = false;
      if (this.startQueue.length) {
        this.drainStartQueue().catch((error) => {
          console.warn("[pusher-monitor] start queue error:", error.message);
        });
      }
    }
  }

  queueSlug(slug, { front = false } = {}) {
    if (!slug) return;
    if (this.startQueue.includes(slug)) {
      // Allow live partners to jump ahead even if already queued at the back.
      if (front) {
        const idx = this.startQueue.indexOf(slug);
        if (idx > 0) {
          this.startQueue.splice(idx, 1);
          this.startQueue.unshift(slug);
        }
      }
      this.drainStartQueue().catch((error) => {
        console.warn("[pusher-monitor] start queue error:", error.message);
      });
      return;
    }
    if (front) this.startQueue.unshift(slug);
    else this.startQueue.push(slug);
    this.drainStartQueue().catch((error) => {
      console.warn("[pusher-monitor] start queue error:", error.message);
    });
  }

  refreshTargets() {
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
        this.failedAt.delete(slug);
        console.log(`[pusher-monitor] stopped ${slug}`);
      }
    }

    // Prefer channels that already have a cached chatroom id (instant connect).
    const withCache = [];
    const needsLookup = [];
    for (const slug of slugs) {
      const meta = kickRewardsStore.getStoredChannelMeta?.(slug);
      const monitor = this.monitors.get(slug);
      if (monitor?.connected) continue;
      // Already queued / connecting — don't thrash.
      if (this.startQueue.includes(slug)) continue;
      if (meta?.chatroomId || monitor?.chatroomId) withCache.push(slug);
      else needsLookup.push(slug);
    }

    for (const slug of withCache) this.queueSlug(slug);
    for (const slug of needsLookup) this.queueSlug(slug);
  }

  /** Slowly retry failed chatroom lookups AND disconnected sockets. */
  retryOneFailed() {
    const now = Date.now();
    for (const [slug, monitor] of this.monitors) {
      if (monitor.connected) continue;
      if (this.startQueue.includes(slug)) continue;
      const failedAt = this.failedAt.get(slug) || 0;
      if (now - failedAt < 20000) continue;
      // Same path as the Reconnect button — don't leave chats stuck offline.
      this.forceReconnect(slug);
      this.failedAt.set(slug, now);
      return;
    }
    // Also pick up priority slugs that never got a monitor instance.
    const wanted =
      typeof kickRewardsStore.getChatMonitorSlugs === "function"
        ? kickRewardsStore.getChatMonitorSlugs()
        : [];
    for (const slug of wanted) {
      if (this.monitors.has(slug) || this.startQueue.includes(slug)) continue;
      this.queueSlug(slug, { front: true });
      return;
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    console.log("[pusher-monitor] starting Kick Pusher chat monitor");
    this.refreshTargets();
    this.refreshTimer = setInterval(() => this.refreshTargets(), REFRESH_MS);
    this.retryTimer = setInterval(() => this.retryOneFailed(), 20000);
  }

  stop() {
    this.started = false;
    this.startQueue = [];
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
  }

  forceReconnect(slug) {
    const key = String(slug || "").toLowerCase();
    if (!key) return false;
    this.failedAt.delete(key);
    const meta = kickRewardsStore.getStoredChannelMeta?.(key);
    const existing = this.monitors.get(key);
    // Already healthy on the seeded chatroom — don't thrash the start queue.
    if (
      existing?.connected &&
      existing.chatroomId &&
      meta?.chatroomId &&
      String(existing.chatroomId) === String(meta.chatroomId)
    ) {
      return true;
    }
    if (existing) {
      existing.stop();
      this.monitors.delete(key);
    }
    this.queueSlug(key, { front: true });
    return true;
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
      failedLookups: this.failedAt.size,
    };
  }
}

module.exports = new KickPusherMonitor();
