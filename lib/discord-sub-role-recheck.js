/**
 * Periodically re-checks Discord subscriber-role grants.
 * If Kick no longer shows an active sub (and they aren't the channel owner),
 * the Discord role is removed.
 */

const discord = require("./discord");

let lastRun = null;
let running = false;

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

function getStaleMs() {
  return Math.max(
    10 * 60 * 1000,
    Number(process.env.DISCORD_SUB_RECHECK_STALE_MS || 60 * 60 * 1000) || 60 * 60 * 1000
  );
}

function pickGrantsToCheck(kickSubscriberStore, { forceAll = false } = {}) {
  const active = kickSubscriberStore.listActiveGrants();
  if (!active.length) return [];
  if (forceAll) return shuffle(active);

  const staleMs = getStaleMs();
  const now = Date.now();
  const stale = active.filter((row) => {
    const last = row.lastCheckedAt ? new Date(row.lastCheckedAt).getTime() : 0;
    return !Number.isFinite(last) || now - last >= staleMs;
  });

  // Prefer stale grants; if none are stale, still randomly sample a few.
  const pool = stale.length ? stale : active;
  return shuffle(pool).slice(0, getBatchSize());
}

async function recheckOne(grant, kickSubscriberStore) {
  const discordId = String(grant.discordId || "").trim();
  if (!discordId) return { discordId: null, action: "skip", reason: "no-discord-id" };

  const link = kickSubscriberStore.getLinkForDiscordId(discordId);
  const kickUserId = link?.kickUserId || grant.kickUserId || null;
  const kickUsername = link?.kickUsername || grant.kickUsername || null;

  const eligibility = kickSubscriberStore.isEligibleForSubRole(
    kickUserId,
    kickUsername
  );

  if (eligibility.eligible) {
    kickSubscriberStore.recordGrant(discordId, {
      kickUsername,
      kickUserId,
      active: true,
      expiresAt:
        kickSubscriberStore.getSubscriber(kickUsername)?.expiresAt ||
        kickSubscriberStore.getSubscriber(kickUserId)?.expiresAt ||
        grant.expiresAt ||
        null,
      lastCheckedAt: new Date().toISOString(),
      revokeReason: null,
    });
    return {
      discordId,
      kickUsername,
      action: "keep",
      reason: eligibility.reason,
    };
  }

  try {
    await discord.removeSubRole(discordId);
  } catch (error) {
    // Still mark inactive locally so we don't loop forever on 404s.
    if (error.status !== 404) {
      kickSubscriberStore.recordGrant(discordId, {
        kickUsername,
        kickUserId,
        active: true,
        lastCheckedAt: new Date().toISOString(),
        revokeReason: `remove-failed:${error.message}`,
      });
      return {
        discordId,
        kickUsername,
        action: "error",
        reason: error.message,
      };
    }
  }

  kickSubscriberStore.recordGrant(discordId, {
    kickUsername,
    kickUserId,
    active: false,
    lastCheckedAt: new Date().toISOString(),
    revokeReason: "no-longer-subscriber",
  });

  return {
    discordId,
    kickUsername,
    action: "revoked",
    reason: "no-longer-subscriber",
  };
}

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

  try {
    const batch = pickGrantsToCheck(kickSubscriberStore, options);
    for (const grant of batch) {
      // Small jitter between Discord API calls.
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 400)));
      // eslint-disable-next-line no-await-in-loop
      const result = await recheckOne(grant, kickSubscriberStore);
      results.push(result);
      if (result.action === "revoked") {
        console.log(
          `[discord-recheck] revoked sub role for ${result.kickUsername || result.discordId}`
        );
      }
    }

    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      checked: results.length,
      kept: results.filter((r) => r.action === "keep").length,
      revoked: results.filter((r) => r.action === "revoked").length,
      errors: results.filter((r) => r.action === "error").length,
      results,
    };
    return { ok: true, ...lastRun };
  } finally {
    running = false;
  }
}

function getLastRun() {
  return lastRun;
}

function startRecheckLoop(kickSubscriberStore) {
  const base = getRecheckIntervalMs();
  const tick = () => {
    runRecheck(kickSubscriberStore).catch((error) => {
      console.warn("[discord-recheck] failed:", error.message);
    });
  };

  // First run after a short random delay so deploys don't all hit Discord at once.
  const firstDelay = 30_000 + Math.floor(Math.random() * 60_000);
  setTimeout(() => {
    tick();
    setInterval(tick, base);
  }, firstDelay);

  console.log(
    `[discord-recheck] scheduled every ~${Math.round(base / 60000)}m (batch ${getBatchSize()})`
  );
}

module.exports = {
  runRecheck,
  getLastRun,
  startRecheckLoop,
  getRecheckIntervalMs,
  getBatchSize,
};
