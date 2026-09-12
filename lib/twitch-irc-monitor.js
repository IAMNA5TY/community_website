const tls = require("tls");
const {
  parseIrcLine,
  toChatPayload,
  classifyUsernotice,
  channelList,
} = require("./twitch-irc");
const { canUseTwitchCityChat } = require("./twitch-city-gate");

const IRC_HOST = process.env.TWITCH_IRC_HOST || "irc.chat.twitch.tv";
const IRC_PORT = Number(process.env.TWITCH_IRC_PORT || 6697) || 6697;
const DEFAULT_CHANNELS = process.env.TWITCH_CHAT_CHANNELS || process.env.TWITCH_CHAT_CHANNEL || "iamna5ty";

function ownerBroadcasterId() {
  return String(process.env.DEFAULT_BROADCASTER_ID || "1183030");
}

function cityStreamerSlug() {
  return String(
    process.env.KICK_OWNER_SLUG || process.env.DEFAULT_BROADCASTER_SLUG || "na5ty"
  ).toLowerCase();
}

class TwitchIrcMonitor {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.reconnectDelay = 4000;
    this.reconnectTimer = null;
    this.buffer = "";
    this.messagesRecorded = 0;
    this.controlsRecorded = 0;
    this.subsRecorded = 0;
    this.lastMessageAt = null;
    this.lastError = null;
    this.skippedOffline = 0;
    this.lastGate = null;
    this.channels = channelList(DEFAULT_CHANNELS);
    this.nick = `justinfan${Math.floor(100000 + Math.random() * 900000)}`;
  }

  getStatus() {
    return {
      enabled: String(process.env.TWITCH_IRC_MONITOR || "1") !== "0",
      connected: this.connected,
      channels: this.channels.slice(),
      nick: this.nick,
      messagesRecorded: this.messagesRecorded,
      controlsRecorded: this.controlsRecorded,
      subsRecorded: this.subsRecorded,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      liveOnly: String(process.env.TWITCH_CITY_REQUIRE_LIVE || "1") !== "0",
      skippedOffline: this.skippedOffline,
      lastGate: this.lastGate,
    };
  }

  start() {
    if (String(process.env.TWITCH_IRC_MONITOR || "1") === "0") {
      console.log("[twitch-irc] disabled (TWITCH_IRC_MONITOR=0)");
      return;
    }
    this.stopped = false;
    this.channels = channelList(DEFAULT_CHANNELS);
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearReconnect();
    this.closeSocket();
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  closeSocket() {
    this.connected = false;
    if (!this.socket) return;
    try {
      this.socket.removeAllListeners();
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearReconnect();
    this.closeSocket();
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(Math.floor(this.reconnectDelay * 1.5), 60000);
  }

  send(line) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(`${line}\r\n`);
  }

  connect() {
    if (this.stopped) return;
    this.closeSocket();
    this.buffer = "";
    this.nick = `justinfan${Math.floor(100000 + Math.random() * 900000)}`;

    const socket = tls.connect(
      { host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST },
      () => {
        this.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        this.send("PASS SCHMOOPIIE");
        this.send(`NICK ${this.nick}`);
      }
    );
    this.socket = socket;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      this.lastError = error.message;
      console.warn(`[twitch-irc] socket error: ${error.message}`);
    });
    socket.on("close", () => {
      this.connected = false;
      if (!this.stopped) {
        this.lastError = this.lastError || "disconnected";
        this.scheduleReconnect();
      }
    });
  }

  onData(chunk) {
    this.buffer += String(chunk || "");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(line.replace(/\r$/, ""));
    }
  }

  onLine(line) {
    if (!line) return;
    const parsed = parseIrcLine(line);
    if (!parsed) return;

    if (parsed.command === "PING") {
      this.send(`PONG :${parsed.trailing || parsed.params[0] || "tmi.twitch.tv"}`);
      return;
    }

    if (parsed.command === "001") {
      this.connected = true;
      this.reconnectDelay = 4000;
      this.lastError = null;
      for (const channel of this.channels) {
        this.send(`JOIN #${channel}`);
      }
      console.log(`[twitch-irc] connected as ${this.nick} → ${this.channels.map((c) => `#${c}`).join(", ")}`);
      return;
    }

    if (parsed.command === "NOTICE" && /login unsuccessful/i.test(parsed.trailing || "")) {
      this.lastError = parsed.trailing;
      console.warn(`[twitch-irc] ${parsed.trailing}`);
      return;
    }

    if (parsed.command === "PRIVMSG") {
      this.handlePrivmsg(parsed);
      return;
    }

    if (parsed.command === "USERNOTICE") {
      this.handleUsernotice(parsed);
    }
  }

  handlePrivmsg(parsed) {
    const payload = toChatPayload(parsed);
    if (!payload?.sender?.username || !payload.content) return;
    this.forwardChat(payload);
    this.maybeForwardCityControls(payload);
  }

  maybeForwardCityControls(payload) {
    canUseTwitchCityChat(payload.sender.username)
      .then((gate) => {
        this.lastGate = { ...gate, at: new Date().toISOString() };
        if (!gate.ok) {
          this.skippedOffline += 1;
          return;
        }
        this.forwardCityControls(payload);
      })
      .catch((error) => {
        this.lastError = error.message;
        console.warn(`[twitch-irc] city gate failed: ${error.message}`);
      });
  }

  forwardCityControls(payload) {
    try {
      const kickRewardsStore = require("./kick-rewards-store");
      const recorded = kickRewardsStore.recordChatMessage({
        streamer: cityStreamerSlug(),
        username: payload.sender.username,
        content: payload.content,
        createdAt: payload.created_at,
        messageId: payload.message_id ? `twitch:${payload.message_id}` : null,
      });
      if (recorded?.controlEvent) {
        this.controlsRecorded += 1;
      }
      if (recorded?.controlEvent?.action === "balance") {
        require("./kick-balance-reply")
          .maybeReplyBalance(cityStreamerSlug(), payload.sender.username, recorded.controlEvent)
          .catch((error) => {
            console.warn(`[twitch-irc] balance reply failed: ${error.message}`);
          });
      }
    } catch (error) {
      console.warn(`[twitch-irc] city controls failed: ${error.message}`);
    }
  }

  handleUsernotice(parsed) {
    const payload = toChatPayload(parsed);
    if (!payload?.sender?.username) return;
    const notice = classifyUsernotice(parsed.tags || {});
    const plan = String(parsed.tags?.["msg-param-sub-plan"] || "");
    const planLabel = plan === "2000" ? "Tier 2" : plan === "3000" ? "Tier 3" : "Twitch";
    if (!payload.content) {
      if (notice.kind === "sub" && notice.quantity > 1) {
        payload.content = `gifted ${notice.quantity} ${planLabel} subs`;
      } else if (notice.kind === "sub") {
        payload.content = parsed.tags?.["msg-id"] === "resub" ? `resubscribed (${planLabel})` : `subscribed (${planLabel})`;
      } else {
        payload.content = String(parsed.tags?.["system-msg"] || parsed.tags?.["msg-id"] || "twitch notice").replace(/\\s/g, " ");
      }
    }
    this.forwardChat(payload);

    if (notice.kind === "sub" && notice.quantity > 0) {
      this.subsRecorded += notice.quantity;
      try {
        require("./bot-engine").handleSubscriptionEvent(notice.quantity);
      } catch (error) {
        console.warn(`[twitch-irc] subathon bump failed: ${error.message}`);
      }
    }
  }

  forwardChat(payload) {
    const ownerId = ownerBroadcasterId();
    try {
      const eventStore = require("./event-store");
      const chatEvents = require("./chat-events");
      const message = eventStore.addChatMessage(ownerId, payload);
      chatEvents.broadcastMessage(message);
    } catch (error) {
      console.warn(`[twitch-irc] OBS chat store failed: ${error.message}`);
      return;
    }

    this.messagesRecorded += 1;
    this.lastMessageAt = new Date().toISOString();

    try {
      const botEngine = require("./bot-engine");
      botEngine
        .handleChatMessage(ownerId, payload, { skipSend: true })
        .catch((error) => {
          console.warn(`[twitch-irc] bot command failed: ${error.message}`);
        });
    } catch (error) {
      console.warn(`[twitch-irc] bot engine unavailable: ${error.message}`);
    }
  }
}

const monitor = new TwitchIrcMonitor();

module.exports = monitor;
module.exports.TwitchIrcMonitor = TwitchIrcMonitor;
