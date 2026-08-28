/**
 * Kick chat commands viewers can type in a streamer's channel (whole message = one word).
 * Kept in sync with kick-chat-actions.js + FiveM Config.KickChatControls.
 *
 * Paid movement costs apply to everyone except the owner account (na5ty).
 */

const COMMAND_CATALOG = [
  {
    chat: "left",
    action: "left",
    group: "movement",
    description: "Move streamer left · 5s",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "right",
    action: "right",
    group: "movement",
    description: "Move streamer right · 5s",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "forward",
    action: "forward",
    group: "movement",
    description: "Move streamer forward · 5s",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "back",
    action: "back",
    group: "movement",
    description: "Move streamer backward · 5s",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "handsup",
    action: "handsup",
    group: "movement",
    description: "Hands up · 5s",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "vehicle",
    action: "toggle_vehicle",
    group: "movement",
    description: "Enter / exit vehicle",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "skydive",
    action: "skydive",
    group: "movement",
    description: "Rocket / skydive the streamer",
    needsPoints: true,
    pointCost: 1,
  },
  {
    chat: "poop",
    action: "poop",
    group: "movement",
    description: "Make the streamer shit · 15 Kick Points",
    needsPoints: true,
    pointCost: 15,
  },
  {
    chat: "donate",
    action: "donate",
    group: "rewards",
    description: "Give streamer $25 in-city",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "tip",
    action: "tip",
    group: "rewards",
    description: "Tip streamer $500 · max 10/day",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "dailymech",
    action: "dailymech",
    group: "rewards",
    description: "Vehicle parts to streamer · 1/day · in-city",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "coke",
    action: "coke",
    group: "rewards",
    description: "Supply D0SiL 1 bag · 2/day · no in-city needed",
    needsPoints: false,
    pointCost: 0,
    streamers: ["d0sil"],
  },
  {
    chat: "daily",
    action: "daily",
    group: "rewards",
    description: "Unlock Daily Carhub in /kickmenu",
    needsPoints: false,
    pointCost: 0,
    streamers: ["na5ty"],
  },
  {
    chat: "balance",
    action: "balance",
    group: "info",
    description: "Check your points — replies in this Kick chat",
    needsPoints: false,
    pointCost: 0,
  },
];

const GROUP_LABELS = {
  movement: "Movement (costs Kick Points)",
  rewards: "Rewards & triggers",
  info: "Info",
};

function normalizeStreamer(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function compactStreamer(value) {
  return normalizeStreamer(value).replace(/[_-]/g, "");
}

function getOwnerChatSlug() {
  return normalizeStreamer(
    process.env.KICK_OWNER_SLUG ||
      process.env.DEFAULT_BROADCASTER_SLUG ||
      "na5ty"
  );
}

/** Owner account (na5ty) never pays for chat commands in any stream. */
function isFreeCommandUser(username) {
  const name = normalizeStreamer(username);
  const owner = getOwnerChatSlug();
  if (!name || !owner) return false;
  return name === owner || compactStreamer(name) === compactStreamer(owner);
}

function getCommandPointCost(actionOrChat, options = {}) {
  const key = String(actionOrChat || "")
    .trim()
    .toLowerCase()
    .replace(/^!/, "");
  if (!key) return 0;
  if (isFreeCommandUser(options.chatter || options.username)) return 0;
  const cmd = COMMAND_CATALOG.find(
    (row) => row.action === key || row.chat === key
  );
  if (!cmd) return 0;
  if (Number.isFinite(Number(cmd.pointCost))) return Math.max(0, Number(cmd.pointCost));
  return cmd.needsPoints ? 1 : 0;
}

function getChatCommandsForStreamer(streamerSlug, options = {}) {
  const slug = normalizeStreamer(streamerSlug);
  const chatter = options.chatter || options.username || "";
  const freeForUser = isFreeCommandUser(chatter);
  return COMMAND_CATALOG.filter((cmd) => {
    if (cmd.streamers && !cmd.streamers.some((s) => normalizeStreamer(s) === slug)) {
      return false;
    }
    return true;
  }).map((cmd) => {
    const pointCost = getCommandPointCost(cmd.action, { chatter });
    const groupLabel =
      freeForUser && cmd.group === "movement"
        ? "Movement (free for you)"
        : GROUP_LABELS[cmd.group] || cmd.group;
    return {
      chat: cmd.chat,
      action: cmd.action,
      group: cmd.group,
      groupLabel,
      description: cmd.description,
      needsPoints: !freeForUser && (Boolean(cmd.needsPoints) || pointCost > 0),
      pointCost,
    };
  });
}

function formatKeywordUsage(keywords) {
  if (!keywords || typeof keywords !== "object") return [];
  return Object.entries(keywords)
    .filter(([, count]) => Number(count) > 0)
    .map(([action, count]) => {
      const cmd = COMMAND_CATALOG.find((c) => c.action === action);
      return {
        action,
        chat: cmd?.chat || action,
        count: Number(count),
      };
    })
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  COMMAND_CATALOG,
  GROUP_LABELS,
  getChatCommandsForStreamer,
  getCommandPointCost,
  formatKeywordUsage,
  isFreeCommandUser,
  getOwnerChatSlug,
};
