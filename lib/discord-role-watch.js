'use strict';

/**
 * Poll Discord audit logs for subscriber-role add/remove.
 * Needs View Audit Log (no privileged Gateway intent).
 *
 * When RoleLogic (or any other bot/mod) strips Kick Supporter from someone we
 * still consider eligible, we put the role back immediately.
 *
 * Action type 25 = MEMBER_ROLE_UPDATE
 * https://discord.com/developers/docs/resources/audit-log
 */

const fs = require('fs');
const path = require('path');
const discord = require('./discord');
const { getDataDir, ensureDataDir } = require('./data-dir');

const AUDIT_ACTION_MEMBER_ROLE_UPDATE = 25;
const POLL_MS = Math.max(
  5000,
  Number(process.env.DISCORD_ROLE_WATCH_POLL_MS || 8000) || 8000
);
const CURSOR_PATH = () => path.join(getDataDir(), 'discord-role-watch-cursor.json');

let kickSubscriberStore = null;
let started = false;
let timer = null;
let lastAuditId = null;
let lastPollAt = null;
let lastError = null;
let lastEventAt = null;
let lastRestoreAt = null;
let lastRestoreCount = 0;
let pollCount = 0;
let eventsSeen = 0;
let restoresTotal = 0;
let botUserIdCache = '';
let cursorLoaded = false;
let pollInFlight = false;
let recheckQueued = false;

function enabled() {
  return String(process.env.DISCORD_ROLE_WATCH || '1').trim() !== '0';
}

function restoreExternalRemovesEnabled() {
  return String(process.env.DISCORD_RESTORE_EXTERNAL_REMOVES || '1').trim() !== '0';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCursor() {
  if (cursorLoaded) return;
  cursorLoaded = true;
  try {
    ensureDataDir();
    if (!fs.existsSync(CURSOR_PATH())) return;
    const parsed = JSON.parse(fs.readFileSync(CURSOR_PATH(), 'utf8'));
    if (parsed?.lastAuditId) lastAuditId = String(parsed.lastAuditId);
  } catch {
    /* ignore */
  }
}

function saveCursor(id) {
  if (!id) return;
  lastAuditId = String(id);
  try {
    ensureDataDir();
    fs.writeFileSync(
      CURSOR_PATH(),
      JSON.stringify(
        { lastAuditId, updatedAt: new Date().toISOString() },
        null,
        2
      )
    );
  } catch (error) {
    console.warn('[discord-role-watch] cursor save failed:', error.message);
  }
}

async function fetchAuditEntries(guildId) {
  const params = new URLSearchParams({
    action_type: String(AUDIT_ACTION_MEMBER_ROLE_UPDATE),
    limit: '50'
  });
  const data = await discord.botFetch(`/guilds/${guildId}/audit-logs?${params}`);
  return Array.isArray(data?.audit_log_entries) ? data.audit_log_entries : [];
}

function entryTouchesRole(entry, roleId) {
  const changes = Array.isArray(entry?.changes) ? entry.changes : [];
  for (const change of changes) {
    if (change?.key !== '$add' && change?.key !== '$remove') continue;
    const list = Array.isArray(change.new_value) ? change.new_value : [];
    if (list.some((r) => String(r?.id || '') === String(roleId))) {
      return change.key === '$add' ? 'granted' : 'revoked';
    }
  }
  return null;
}

function kickNameForDiscordUser(discordUserId) {
  const link = kickSubscriberStore?.getLinkForDiscordId?.(discordUserId) || null;
  if (link?.kickUsername) return link.kickUsername;
  return discordUserId;
}

function actorLabel(entry, botUserId) {
  const actorId = String(entry?.user_id || '');
  if (!actorId) return 'unknown';
  if (botUserId && actorId === String(botUserId)) return 'na5ty-bot';
  // RoleLogic app id (public Top.gg listing)
  if (actorId === '1389130157427785779') return 'RoleLogic';
  return actorId;
}

function resolveKeep(discordUserId) {
  if (typeof kickSubscriberStore?.resolveSubRoleKeepReason === 'function') {
    return kickSubscriberStore.resolveSubRoleKeepReason(discordUserId);
  }
  const grant = kickSubscriberStore?.getGrant?.(discordUserId);
  if (grant?.active) {
    return { keep: true, reason: 'active-grant', grant };
  }
  if (discord.peekRecentBotRoleChange(discordUserId, 'granted')) {
    return { keep: true, reason: 'recent-bot-grant' };
  }
  return { keep: false, reason: 'no-evidence', grant };
}

function queueFullRecheck() {
  if (recheckQueued || !kickSubscriberStore) return;
  recheckQueued = true;
  setTimeout(() => {
    recheckQueued = false;
    try {
      const recheck = require('./discord-sub-role-recheck');
      recheck
        .runRecheck(kickSubscriberStore, { forceAll: true })
        .catch((error) => {
          console.warn('[discord-role-watch] follow-up recheck failed:', error.message);
        });
    } catch (error) {
      console.warn('[discord-role-watch] follow-up recheck unavailable:', error.message);
    }
  }, 1500);
  // unref so this doesn't keep the process alive alone
}

async function restoreSubRole(targetId, keep, actor) {
  const kickName =
    keep.kickUsername ||
    keep.grant?.kickUsername ||
    keep.link?.kickUsername ||
    kickNameForDiscordUser(targetId);

  await discord.ensureSubRole(targetId);
  kickSubscriberStore?.recordGrant?.(targetId, {
    kickUsername: kickName,
    kickUserId: keep.kickUserId || keep.grant?.kickUserId || keep.link?.kickUserId || null,
    active: true,
    lastCheckedAt: new Date().toISOString(),
    revokeReason: null
  });
  restoresTotal += 1;
  lastRestoreAt = new Date().toISOString();
  console.log(
    `[discord-role-watch] Re-applied Kick Supporter for ${kickName} (${targetId}) after ${actor} remove — ${keep.reason}`
  );
}

async function handleEntry(entry, roleId, botUserId) {
  const action = entryTouchesRole(entry, roleId);
  if (!action) return { handled: false, restored: false };

  const targetId = String(entry?.target_id || '');
  if (!targetId) return { handled: false, restored: false };

  const kickName = kickNameForDiscordUser(targetId);
  const link = kickSubscriberStore?.getLinkForDiscordId?.(targetId);
  const actor = actorLabel(entry, botUserId);
  const announceRemoves =
    String(process.env.DISCORD_ROLE_WATCH_ANNOUNCE_REMOVES || '0').trim() === '1';

  if (action === 'granted') {
    // Skip bot's own grants for announce (button already thanked).
    if (botUserId && String(entry?.user_id || '') === String(botUserId)) {
      return { handled: false, restored: false };
    }
    if (discord.wasRecentBotRoleChange(targetId, 'granted')) {
      return { handled: false, restored: false };
    }
    // Don't thank RoleLogic / other bots — only human/manual adds.
    if (actor === 'RoleLogic' || actor === 'na5ty-bot') {
      return { handled: false, restored: false };
    }
    kickSubscriberStore?.recordGrant?.(targetId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: true,
      lastCheckedAt: new Date().toISOString()
    });
    await discord.announceSubRoleChange({
      kickName,
      action,
      reason: 'manual'
    });
    console.log(
      `[discord-role-watch] Manual role granted → announced for ${kickName} (${targetId})`
    );
    return { handled: true, restored: false };
  }

  // REVOKED — put the role back when we still believe they should have it.
  // This is the RoleLogic false-remove path.
  const keep = resolveKeep(targetId);
  const recentGrant = discord.peekRecentBotRoleChange(targetId, 'granted');
  const shouldKeep =
    restoreExternalRemovesEnabled() &&
    (Boolean(keep?.keep) || Boolean(recentGrant));

  // Our own intentional revoke (unlink / explicit remove) — leave it off.
  // Do this even if they are still Kick-eligible; unlink means drop Discord role.
  if (
    botUserId &&
    String(entry?.user_id || '') === String(botUserId) &&
    discord.peekRecentBotRoleChange(targetId, 'revoked')
  ) {
    return { handled: false, restored: false };
  }

  if (shouldKeep) {
    try {
      await restoreSubRole(
        targetId,
        keep?.keep
          ? keep
          : { keep: true, reason: 'recent-bot-grant', kickUsername: kickName },
        actor
      );
      return { handled: false, restored: true };
    } catch (error) {
      console.warn(
        `[discord-role-watch] re-apply failed for ${targetId}:`,
        error.message || error
      );
      return { handled: false, restored: false };
    }
  }

  if (botUserId && String(entry?.user_id || '') === String(botUserId)) {
    return { handled: false, restored: false };
  }
  if (discord.wasRecentBotRoleChange(targetId, 'revoked')) {
    return { handled: false, restored: false };
  }

  // Never announce RoleLogic batch removes as "you lost sub".
  if (actor === 'RoleLogic') {
    console.log(
      `[discord-role-watch] Ignoring RoleLogic remove for ${kickName} (${targetId}) — no keep evidence (disable RoleLogic Kick sync)`
    );
    return { handled: false, restored: false };
  }

  if (announceRemoves) {
    kickSubscriberStore?.recordGrant?.(targetId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: false,
      revokeReason: 'manual-discord-remove',
      lastCheckedAt: new Date().toISOString()
    });
    await discord.announceSubRoleChange({
      kickName,
      action: 'revoked',
      reason: 'manual'
    });
    console.log(
      `[discord-role-watch] Manual role removed → announced for ${kickName} (${targetId})`
    );
    return { handled: true, restored: false };
  }

  console.log(
    `[discord-role-watch] Ignoring role remove for ${kickName} (${targetId}) by ${actor} — ${keep?.reason || 'no-evidence'}`
  );
  return { handled: false, restored: false };
}

async function resolveBotUserId() {
  if (botUserIdCache) return botUserIdCache;
  try {
    const me = await discord.botFetch('/users/@me');
    botUserIdCache = String(me?.id || '');
  } catch {
    botUserIdCache = '';
  }
  return botUserIdCache;
}

async function pollOnce() {
  if (pollInFlight) return;
  const cfg = discord.getConfig();
  if (!cfg.guildId || !cfg.subRoleId || !cfg.botToken) {
    lastError = 'Missing DISCORD_GUILD_ID, DISCORD_SUB_ROLE_ID, or DISCORD_BOT_TOKEN';
    return;
  }

  pollInFlight = true;
  loadCursor();
  const botUserId = await resolveBotUserId();
  let restoredThisPoll = 0;

  try {
    const entries = await fetchAuditEntries(cfg.guildId);
    lastPollAt = new Date().toISOString();
    lastError = null;
    pollCount += 1;

    const sorted = [...entries].sort((a, b) => {
      try {
        const idA = BigInt(String(a.id || '0'));
        const idB = BigInt(String(b.id || '0'));
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // First boot with no saved cursor: seed to newest only — never replay history
    // (replays were re-posting "role removed" after every deploy).
    if (!lastAuditId) {
      if (sorted.length) {
        saveCursor(String(sorted[sorted.length - 1].id));
        console.log(
          `[discord-role-watch] Seeded audit cursor at ${lastAuditId} (no replay)`
        );
      }
      return;
    }

    let maxId = lastAuditId;

    for (const entry of sorted) {
      const id = String(entry?.id || '');
      if (!id) continue;

      try {
        if (BigInt(id) <= BigInt(lastAuditId)) continue;
      } catch {
        continue;
      }

      try {
        const result = await handleEntry(entry, cfg.subRoleId, botUserId);
        if (result?.handled) {
          eventsSeen += 1;
          lastEventAt = new Date().toISOString();
        }
        if (result?.restored) {
          restoredThisPoll += 1;
          lastEventAt = new Date().toISOString();
        }
      } catch (err) {
        console.warn('[discord-role-watch] handle entry failed:', err.message || err);
      }

      if (!maxId || BigInt(id) > BigInt(maxId)) maxId = id;
      await sleep(120);
    }

    if (maxId && String(maxId) !== String(lastAuditId)) {
      saveCursor(maxId);
    }

    lastRestoreCount = restoredThisPoll;
    if (restoredThisPoll > 0) {
      console.log(
        `[discord-role-watch] Restored Kick Supporter on ${restoredThisPoll} user(s) this poll (often RoleLogic false removes)`
      );
      queueFullRecheck();
    }
  } catch (err) {
    lastError = err.message || String(err);
    lastPollAt = new Date().toISOString();
    if (err.status === 403) {
      console.warn(
        '[discord-role-watch] Missing Access (403). Grant the bot View Audit Log, then re-invite if needed.'
      );
    } else {
      console.warn('[discord-role-watch] poll failed:', lastError);
    }
  } finally {
    pollInFlight = false;
  }
}

function getStatus() {
  return {
    enabled: enabled(),
    started,
    pollMs: POLL_MS,
    restoreExternalRemoves: restoreExternalRemovesEnabled(),
    lastPollAt,
    lastEventAt,
    lastRestoreAt,
    lastRestoreCount,
    restoresTotal,
    lastError,
    lastAuditId,
    pollCount,
    eventsSeen,
    needsViewAuditLog: true,
    roleLogicWarning:
      'If RoleLogic (or another Kick role bot) manages Kick Supporter, turn that sync OFF — it will keep stripping supporters. Use na5ty.com claim + Sync only.'
  };
}

function start(store) {
  if (started) return getStatus();
  kickSubscriberStore = store || null;
  if (!enabled()) {
    console.log('[discord-role-watch] Disabled (DISCORD_ROLE_WATCH=0)');
    return getStatus();
  }
  if (!discord.configured()) {
    console.log('[discord-role-watch] Skipped — Discord not fully configured');
    return getStatus();
  }

  loadCursor();
  started = true;
  const cfg = discord.getConfig();
  console.log(
    `[discord-role-watch] Polling audit logs every ${POLL_MS}ms for role ${cfg.subRoleId} (auto-restore external removes=${restoreExternalRemovesEnabled() ? 'on' : 'off'})`
  );
  pollOnce().catch(() => {});
  timer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return getStatus();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = {
  start,
  stop,
  getStatus,
  pollOnce
};
