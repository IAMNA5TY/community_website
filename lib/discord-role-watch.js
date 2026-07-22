'use strict';

/**
 * Poll Discord audit logs for manual subscriber-role add/remove.
 * Needs View Audit Log (no privileged Gateway intent).
 *
 * Action type 25 = MEMBER_ROLE_UPDATE
 * https://discord.com/developers/docs/resources/audit-log
 */

const discord = require('./discord');

const AUDIT_ACTION_MEMBER_ROLE_UPDATE = 25;
const POLL_MS = Math.max(
  8000,
  Number(process.env.DISCORD_ROLE_WATCH_POLL_MS || 12000) || 12000
);
const LOOKBACK_MS = Math.max(
  60000,
  Number(process.env.DISCORD_ROLE_WATCH_LOOKBACK_MS || 5 * 60 * 1000) || 5 * 60 * 1000
);

let kickSubscriberStore = null;
let started = false;
let timer = null;
let lastAuditId = null;
let lastPollAt = null;
let lastError = null;
let lastEventAt = null;
let pollCount = 0;
let eventsSeen = 0;
let botUserIdCache = '';

function enabled() {
  return String(process.env.DISCORD_ROLE_WATCH || '1').trim() !== '0';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snowflakeToMs(id) {
  try {
    return Number((BigInt(String(id)) >> 22n) + 1420070400000n);
  } catch {
    return 0;
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

async function handleEntry(entry, roleId, botUserId) {
  const action = entryTouchesRole(entry, roleId);
  if (!action) return false;

  const targetId = String(entry?.target_id || '');
  if (!targetId) return false;

  // Skip changes made by this bot (button grant / recheck revoke already announce).
  if (botUserId && String(entry?.user_id || '') === String(botUserId)) {
    return false;
  }
  if (discord.wasRecentBotRoleChange(targetId, action)) {
    return false;
  }

  const kickName = kickNameForDiscordUser(targetId);
  const link = kickSubscriberStore?.getLinkForDiscordId?.(targetId);

  if (action === 'granted') {
    kickSubscriberStore?.recordGrant?.(targetId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: true,
      lastCheckedAt: new Date().toISOString()
    });
  } else {
    kickSubscriberStore?.recordGrant?.(targetId, {
      kickUsername: link?.kickUsername || kickName,
      kickUserId: link?.kickUserId || null,
      active: false,
      revokeReason: 'manual-discord-remove',
      lastCheckedAt: new Date().toISOString()
    });
  }

  await discord.announceSubRoleChange({
    kickName,
    action,
    reason: 'manual'
  });
  console.log(
    `[discord-role-watch] Manual role ${action} → announced for ${kickName} (${targetId})`
  );
  return true;
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
  const cfg = discord.getConfig();
  if (!cfg.guildId || !cfg.subRoleId || !cfg.botToken) {
    lastError = 'Missing DISCORD_GUILD_ID, DISCORD_SUB_ROLE_ID, or DISCORD_BOT_TOKEN';
    return;
  }

  const botUserId = await resolveBotUserId();

  try {
    const entries = await fetchAuditEntries(cfg.guildId);
    lastPollAt = new Date().toISOString();
    lastError = null;
    pollCount += 1;

    // Newest first from Discord — process oldest-first among candidates
    const sorted = [...entries].sort((a, b) => {
      try {
        const idA = BigInt(String(a.id || '0'));
        const idB = BigInt(String(b.id || '0'));
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      } catch {
        return 0;
      }
    });

    const cutoff = Date.now() - LOOKBACK_MS;
    let maxId = lastAuditId;
    const isFirstPoll = !lastAuditId;

    for (const entry of sorted) {
      const id = String(entry?.id || '');
      if (!id) continue;

      try {
        if (lastAuditId && BigInt(id) <= BigInt(lastAuditId)) {
          continue;
        }
      } catch {
        continue;
      }

      // First run: seed cursor; only replay entries inside lookback window
      if (isFirstPoll) {
        const createdMs = snowflakeToMs(id);
        if (createdMs < cutoff) {
          if (!maxId || BigInt(id) > BigInt(maxId)) maxId = id;
          continue;
        }
      }

      try {
        const handled = await handleEntry(entry, cfg.subRoleId, botUserId);
        if (handled) {
          eventsSeen += 1;
          lastEventAt = new Date().toISOString();
        }
      } catch (err) {
        console.warn('[discord-role-watch] handle entry failed:', err.message || err);
      }

      if (!maxId || BigInt(id) > BigInt(maxId)) maxId = id;
      await sleep(150);
    }

    if (maxId) lastAuditId = maxId;
    else if (isFirstPoll && sorted.length) {
      lastAuditId = String(sorted[sorted.length - 1].id);
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
  }
}

function getStatus() {
  return {
    enabled: enabled(),
    started,
    pollMs: POLL_MS,
    lastPollAt,
    lastEventAt,
    lastError,
    lastAuditId,
    pollCount,
    eventsSeen,
    needsViewAuditLog: true
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

  started = true;
  const cfg = discord.getConfig();
  console.log(
    `[discord-role-watch] Polling audit logs every ${POLL_MS}ms for role ${cfg.subRoleId}`
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
