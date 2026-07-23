/**
 * Discord subscriber-role maintenance.
 *
 * Auto-revoke is OFF by default. Instead we periodically ensure anyone with an
 * active local grant still has the Discord role (re-apply if something stripped it).
 */

const discord = require("./discord");

let lastRun = null;
let lastChatRevoke = null;
let lastReconcile = null;
let running = false;
let chatRevokeInFlight = new Set();

function getRecheckIntervalMs() {
  // Faster sync so RoleLogic false removes get put back quickly.
  return Math.max(
    60 * 1000,
    Number(process.env.DISCORD_SUB_RECHECK_MS || 2 * 60 * 1000) || 2 * 60 * 1000
  );
}

function getBatchSize() {
  return Math.max(
    1,
    Math.min(50, Number(process.env.DISCORD_SUB_RECHECK_BATCH || 20) || 20)
  );
}

function reconcileEnabled() {
  return String(process.env.DISCORD_ROLE_RECONCILE || "1").trim() !== "0";
}

/**
 * For each active grant, ensure Discord still has the subscriber role.
 * Never removes roles here.
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
  const results = [];
  let restored = 0;
  let okCount = 0;
  let errors = 0;

  try {
    if (!reconcileEnabled()) {
      lastRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        checked: 0,
        kept: 0,
        restored: 0,
        revoked: 0,
        errors: 0,
        mode: "reconcile-disabled",
        note: "DISCORD_ROLE_RECONCILE=0",
        lastChatRevoke,
        lastReconcile,
      };
      return { ok: true, ...lastRun };
    }

    const active = kickSubscriberStore.listActiveGrants();
    const batch = options.forceAll ? active : active.slice(0, getBatchSize());

    for (const grant of batch) {
      const discordId = String(grant.discordId || "").trim();
      if (!discordId) {
        results.push({ discordId: null, action: "skip", reason: "no-discord-id" });
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        const ensured = await discord.ensureSubRole(discordId);
        kickSubscriberStore.recordGrant(discordId, {
          kickUsername: grant.kickUsername,
          kickUserId: grant.kickUserId,
          active: true,
          lastCheckedAt: new Date().toISOString(),
          revokeReason: null,
        });
        if (ensured.restored) {
          restored += 1;
          results.push({
            discordId,
            kickUsername: grant.kickUsername,
            action: "restored",
            reason: "missing-on-discord",
          });
          console.log(
            `[discord-recheck] re-applied sub role for ${grant.kickUsername || discordId}`
          );
        } else {
          okCount += 1;
          results.push({
            discordId,
            kickUsername: grant.kickUsername,
            action: "ok",
            reason: "already-had-role",
          });
        }
      } catch (error) {
        errors += 1;
        results.push({
          discordId,
          kickUsername: grant.kickUsername,
          action: "error",
          reason: error.message || String(error),
        });
        console.warn(
          `[discord-recheck] ensure failed for ${grant.kickUsername || discordId}:`,
          error.message || error
        );
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 200)));
    }

    lastReconcile = {
      at: new Date().toISOString(),
      checked: results.length,
      restored,
      ok: okCount,
      errors,
    };

    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      checked: results.length,
      kept: okCount,
      restored,
      revoked: 0,
      errors,
      mode: "reconcile-ensure-role",
      note:
        "Re-applies Discord sub role when our grant is active but Discord is missing it. Auto-remove stays off.",
      results,
      lastChatRevoke,
      lastReconcile,
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
  // Off by default — Kick badge payloads are too flaky and were stripping roles
  // right after claim. Set DISCORD_CHAT_ROLE_REVOKE=1 to enable later.
  if (String(process.env.DISCORD_CHAT_ROLE_REVOKE || "0").trim() !== "1") {
    return { ok: true, skipped: true, reason: "chat-revoke-disabled" };
  }

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
    ? { ...lastRun, lastChatRevoke, lastReconcile }
    : lastChatRevoke || lastReconcile
      ? { lastChatRevoke, lastReconcile }
      : null;
}

function getLastChatRevoke() {
  return lastChatRevoke;
}

function startRecheckLoop(kickSubscriberStore) {
  const base = getRecheckIntervalMs();
  console.log(
    `[discord-recheck] reconciling Discord roles every ~${Math.round(base / 1000)}s (re-apply if grant active but role missing)`
  );

  const tick = () => {
    runRecheck(kickSubscriberStore).catch((error) => {
      console.warn("[discord-recheck] reconcile failed:", error.message);
    });
  };

  // First pass soon after boot so people who already "lost" the role get it back.
  const firstDelay = 15_000 + Math.floor(Math.random() * 15_000);
  setTimeout(() => {
    tick();
    const handle = setInterval(tick, base);
    if (typeof handle.unref === "function") handle.unref();
  }, firstDelay);

  lastRun = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checked: 0,
    kept: 0,
    restored: 0,
    revoked: 0,
    errors: 0,
    mode: "reconcile-ensure-role",
    note:
      "Re-applies Discord sub role when our grant is active but Discord is missing it. Auto-remove stays off.",
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
