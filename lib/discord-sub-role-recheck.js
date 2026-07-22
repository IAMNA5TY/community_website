/**
 * Discord subscriber-role maintenance.
 *
 * Kick has no live sub list API. We do NOT revoke from timers / guessed expiry.
 * Revoke only when someone appears in na5ty Kick chat without a subscriber badge
 * (see observeChatSubscriberBadge + revokeFromChatEvidence).
 */

const discord = require("./discord");

let lastRun = null;
let lastChatRevoke = null;
let running = false;
let chatRevokeInFlight = new Set();

function getRecheckIntervalMs() {
  return Math.max(
    5 * 60 * 1000,
    Number(process.env.DISCORD_SUB_RECHECK_MS || 15 * 60 * 1000) || 15 * 60 * 1000
  );
}

function getBatchSize() {
  return Math.max(
    1,
    Math.min(50, Number(process.env.DISCORD_SUB_RECHECK_BATCH || 8) || 8)
  );
}

/**
 * Status-only pass — never removes Discord roles.
 * Live revoke happens from Kick chat badge observation.
 */
async function runRecheck(kickSubscriberStore, options = {}) {
  if (running) {
    return { ok: false, skipped: true, reason: "already-running", lastRun };
  }
  if (!discord.configured()) {
    return { ok: false, skipped: true, reason: "discord-not-configured", lastRun };
  }

  running = true;
  const startedAt = new Date().toISOString();

  try {
    const active = kickSubscriberStore.listActiveGrants();
    const results = active.map((grant) => ({
      discordId: grant.discordId,
      kickUsername: grant.kickUsername,
      action: "keep",
      reason: "chat-badge-revokes-only",
    }));

    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      checked: results.length,
      kept: results.length,
      revoked: 0,
      errors: 0,
      mode: "status-only",
      note:
        "Roles are only removed when the person chats in na5ty Kick without a sub badge.",
      results: options.forceAll ? results : results.slice(0, getBatchSize()),
      lastChatRevoke,
    };
    return { ok: true, ...lastRun };
  } finally {
    running = false;
  }
}

async function revokeFromChatEvidence(
  kickSubscriberStore,
  { discordId, kickUsername, kickUserId } = {}
) {
  const id = String(discordId || "").trim();
  if (!id) return { ok: false, skipped: true, reason: "no-discord-id" };
  if (!discord.configured()) {
    return { ok: false, skipped: true, reason: "discord-not-configured" };
  }
  if (kickSubscriberStore.isChannelOwner(kickUserId, kickUsername)) {
    return { ok: true, skipped: true, reason: "owner" };
  }
  if (chatRevokeInFlight.has(id)) {
    return { ok: false, skipped: true, reason: "in-flight" };
  }

  const grant = kickSubscriberStore.getGrant(id);
  if (!grant?.active) {
    return { ok: true, skipped: true, reason: "already-inactive" };
  }

  chatRevokeInFlight.add(id);
  try {
    try {
      await discord.removeSubRole(id);
    } catch (error) {
      if (error.status !== 404) {
        kickSubscriberStore.recordGrant(id, {
          kickUsername,
          kickUserId,
          active: true,
          lastCheckedAt: new Date().toISOString(),
          revokeReason: `chat-revoke-failed:${error.message}`,
        });
        return { ok: false, action: "error", reason: error.message };
      }
    }

    kickSubscriberStore.recordGrant(id, {
      kickUsername,
      kickUserId,
      active: false,
      lastCheckedAt: new Date().toISOString(),
      revokeReason: "chat-no-subscriber-badge",
    });

    try {
      await discord.announceSubRoleChange({
        kickName: kickUsername || id,
        action: "revoked",
        reason: "chat-no-badge",
      });
    } catch (error) {
      console.warn("[discord-recheck] chat revoke announcement failed:", error.message);
    }

    lastChatRevoke = {
      at: new Date().toISOString(),
      discordId: id,
      kickUsername: kickUsername || null,
    };

    console.log(
      `[discord-recheck] revoked sub role for ${kickUsername || id} (chatted without sub badge)`
    );

    return {
      ok: true,
      action: "revoked",
      reason: "chat-no-subscriber-badge",
      discordId: id,
      kickUsername,
    };
  } finally {
    chatRevokeInFlight.delete(id);
  }
}

function getLastRun() {
  return lastRun
    ? { ...lastRun, lastChatRevoke }
    : lastChatRevoke
      ? { lastChatRevoke }
      : null;
}

function getLastChatRevoke() {
  return lastChatRevoke;
}

function startRecheckLoop(kickSubscriberStore) {
  // No timer-based revokes — Kick chat badges drive removal.
  console.log(
    "[discord-recheck] timer revokes disabled — Discord role removed when Kick chat shows no sub badge"
  );
  lastRun = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checked: 0,
    kept: 0,
    revoked: 0,
    errors: 0,
    mode: "chat-badge-only",
    note:
      "Roles are only removed when the person chats in na5ty Kick without a sub badge.",
  };
}

module.exports = {
  runRecheck,
  revokeFromChatEvidence,
  getLastRun,
  getLastChatRevoke,
  startRecheckLoop,
  getRecheckIntervalMs,
  getBatchSize,
};
