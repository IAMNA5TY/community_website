'use strict';

/**
 * Poll Discord audit logs for manual subscriber-role add/remove.
 * Needs View Audit Log (no privileged Gateway intent).
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
  8000,
  Number(process.env.DISCORD_ROLE_WATCH_POLL_MS || 12000) || 12000
);
const CURSOR_PATH = () => path.join(getDataDir(), 'discord-role-watch-cursor.json');

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
let cursorLoaded = false;

function enabled() {
  return String(process.env.DISCORD_ROLE_WATCH || '1').trim() !== '0';
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

async function handleEntry(entry, roleId, botUserId) {
  const action = entryTouchesRole(entry, roleId);
  if (!action) return false;

  const targetId = String(entry?.target_id || '');
  if (!targetId) return false;

  // Skip changes made by this bot (button grant / chat revoke already announce).
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

  loadCursor();
  const botUserId = await resolveBotUserId();

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

    if (maxId && String(maxId) !== String(lastAuditId)) {
      saveCursor(maxId);
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

  loadCursor();
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
