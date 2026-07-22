const WebSocket = require("ws");
const discord = require("./discord");

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const Intent = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
};

// Ignore role updates we ourselves just made (avoid double thank-you).
const recentBotRoleChanges = new Map();
const BOT_CHANGE_TTL_MS = 20_000;

// Last known role sets per Discord user id.
const memberRoleCache = new Map();
const seenMembers = new Set();

let kickSubscriberStore = null;
let socket = null;
let heartbeatTimer = null;
let lastSequence = null;
let sessionId = null;
let resumeGatewayUrl = null;
let started = false;
let reconnectTimer = null;

function rememberBotRoleChange(discordUserId, action) {
  const id = String(discordUserId || "").trim();
  if (!id) return;
  recentBotRoleChanges.set(`${id}:${action}`, Date.now());
}

function wasRecentBotRoleChange(discordUserId, action) {
  const key = `${String(discordUserId || "").trim()}:${action}`;
  const at = recentBotRoleChanges.get(key);
  if (!at) return false;
  if (Date.now() - at > BOT_CHANGE_TTL_MS) {
    recentBotRoleChanges.delete(key);
    return false;
  }
  recentBotRoleChanges.delete(key);
  return true;
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(op, d) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ op, d }));
}

function startHeartbeat(intervalMs) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    send(1, lastSequence);
  }, intervalMs);
}

function identify() {
  const cfg = discord.getConfig();
  send(2, {
    token: cfg.botToken,
    intents: Intent.GUILDS | Intent.GUILD_MEMBERS,
    properties: {
      os: "linux",
      browser: "na5ty",
      device: "na5ty",
    },
  });
}

function resume() {
  const cfg = discord.getConfig();
  if (!sessionId || lastSequence == null) {
    identify();
    return;
  }
  send(6, {
    token: cfg.botToken,
    session_id: sessionId,
    seq: lastSequence,
  });
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(Boolean(sessionId));
  }, delayMs);
}

function kickNameForDiscordUser(discordUserId, member) {
  const link =
    kickSubscriberStore?.getLinkForDiscordId?.(discordUserId) || null;
  if (link?.kickUsername) return link.kickUsername;
  return (
    member?.nick ||
    member?.user?.global_name ||
    member?.user?.username ||
    discordUserId
  );
}

async function announceManualRoleChange(discordUserId, member, action) {
  if (wasRecentBotRoleChange(discordUserId, action)) {
    return;
  }

  const kickName = kickNameForDiscordUser(discordUserId, member);
  const link = kickSubscriberStore?.getLinkForDiscordId?.(discordUserId);

  if (action === "granted") {
    kickSubscriberStore?.recordGrant?.(discordUserId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: true,
      lastCheckedAt: new Date().toISOString(),
    });
  } else {
    kickSubscriberStore?.recordGrant?.(discordUserId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: false,
      revokeReason: "manual-discord-remove",
      lastCheckedAt: new Date().toISOString(),
    });
  }

  try {
    await discord.announceSubRoleChange({
      kickName,
      action,
      reason: "manual",
    });
    console.log(
      `[discord-gateway] role ${action} detected for ${kickName} (${discordUserId})`
    );
  } catch (error) {
    console.warn("[discord-gateway] announce failed:", error.message);
  }
}

function handleGuildMemberUpdate(member) {
  const cfg = discord.getConfig();
  const guildId = String(member?.guild_id || "");
  if (!cfg.guildId || guildId !== String(cfg.guildId)) return;

  const roleId = String(cfg.subRoleId || "");
  if (!roleId) return;

  const discordUserId = String(member?.user?.id || "").trim();
  if (!discordUserId) return;

  const newRoles = (member.roles || []).map(String);
  const hadSeen = seenMembers.has(discordUserId);
  const prevRoles = memberRoleCache.get(discordUserId) || [];
  memberRoleCache.set(discordUserId, newRoles);

  if (!hadSeen) {
    // First observation after connect — cache only, don't announce.
    seenMembers.add(discordUserId);
    return;
  }

  const hadRole = prevRoles.includes(roleId);
  const hasRole = newRoles.includes(roleId);
  if (hadRole === hasRole) return;

  announceManualRoleChange(discordUserId, member, hasRole ? "granted" : "revoked").catch(
    (error) => console.warn("[discord-gateway] member update failed:", error.message)
  );
}

function onGatewayMessage(raw) {
  let packet;
  try {
    packet = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (packet.s != null) lastSequence = packet.s;

  switch (packet.op) {
    case 10: // Hello
      startHeartbeat(packet.d.heartbeat_interval);
      if (sessionId) resume();
      else identify();
      break;
    case 11: // Heartbeat ACK
      break;
    case 9: // Invalid session
      sessionId = null;
      setTimeout(() => identify(), packet.d ? 1000 : 5000);
      break;
    case 7: // Reconnect
      try {
        socket?.close(1012);
      } catch {
        /* ignore */
      }
      break;
    case 0: // Dispatch
      if (packet.t === "READY") {
        sessionId = packet.d.session_id;
        resumeGatewayUrl = packet.d.resume_gateway_url || null;
        console.log(
          `[discord-gateway] ready as ${packet.d.user?.username || "bot"} — watching role changes`
        );
      } else if (packet.t === "RESUMED") {
        console.log("[discord-gateway] session resumed");
      } else if (packet.t === "GUILD_CREATE") {
        const members = packet.d?.members || [];
        for (const member of members) {
          const id = String(member?.user?.id || "");
          if (!id) continue;
          memberRoleCache.set(id, (member.roles || []).map(String));
          seenMembers.add(id);
        }
      } else if (packet.t === "GUILD_MEMBER_UPDATE") {
        handleGuildMemberUpdate(packet.d);
      }
      break;
    default:
      break;
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(op, d) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ op, d }));
}

function startHeartbeat(intervalMs) {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    send(1, lastSequence);
  }, intervalMs);
}

function identify() {
  const cfg = discord.getConfig();
  send(2, {
    token: cfg.botToken,
    intents: Intent.GUILDS | Intent.GUILD_MEMBERS,
    properties: {
      os: "linux",
      browser: "na5ty",
      device: "na5ty",
    },
  });
}

function resume() {
  const cfg = discord.getConfig();
  if (!sessionId || lastSequence == null) {
    identify();
    return;
  }
  send(6, {
    token: cfg.botToken,
    session_id: sessionId,
    seq: lastSequence,
  });
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(Boolean(sessionId));
  }, delayMs);
}

function connect(isResume = false) {
  const cfg = discord.getConfig();
  if (!cfg.botToken || !cfg.guildId || !cfg.subRoleId) {
    console.warn("[discord-gateway] missing bot token / guild / sub role — not starting");
    return;
  }

  clearHeartbeat();
  const url =
    isResume && resumeGatewayUrl
      ? `${resumeGatewayUrl}/?v=10&encoding=json`
      : GATEWAY_URL;

  socket = new WebSocket(url);

  socket.on("open", () => {
    console.log("[discord-gateway] connected");
  });

  socket.on("message", onGatewayMessage);

  socket.on("close", (code, reason) => {
    clearHeartbeat();
    console.warn(
      `[discord-gateway] closed (${code}) ${reason || ""} — reconnecting`
    );
    // 4014 = disallowed intents (Server Members Intent not enabled)
    if (code === 4014) {
      console.warn(
        "[discord-gateway] Server Members Intent is required. Enable it in Discord Developer Portal → Bot → Privileged Gateway Intents."
      );
      return;
    }
    scheduleReconnect(code === 4004 ? 15000 : 5000);
  });

  socket.on("error", (error) => {
    console.warn("[discord-gateway] socket error:", error.message);
  });
}

function patchRoleHelpers() {
  if (discord.addSubRole.__roleWatchPatched) return;

  const originalAdd = discord.addSubRole.bind(discord);
  const originalRemove = discord.removeSubRole.bind(discord);

  const patchedAdd = async (discordUserId) => {
    rememberBotRoleChange(discordUserId, "granted");
    return originalAdd(discordUserId);
  };
  patchedAdd.__roleWatchPatched = true;
  discord.addSubRole = patchedAdd;

  const patchedRemove = async (discordUserId) => {
    rememberBotRoleChange(discordUserId, "revoked");
    return originalRemove(discordUserId);
  };
  patchedRemove.__roleWatchPatched = true;
  discord.removeSubRole = patchedRemove;
}

function start(store) {
  if (started) return;
  kickSubscriberStore = store;
  if (!discord.configured()) {
    console.log("[discord-gateway] skipped — Discord not configured");
    return;
  }
  started = true;
  patchRoleHelpers();
  connect(false);
}

function stop() {
  started = false;
  clearHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    socket?.close(1000);
  } catch {
    /* ignore */
  }
  socket = null;
}

module.exports = {
  start,
  stop,
  rememberBotRoleChange,
};
