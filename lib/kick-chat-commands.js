/**
 * Kick chat commands viewers can type in a streamer's channel (whole message = one word).
 * Kept in sync with kick-chat-actions.js + FiveM Config.KickChatControls.
 */

const COMMAND_CATALOG = [
  {
    chat: "left",
    action: "left",
    group: "movement",
    description: "Move streamer left · 5s",
    needsPoints: true,
  },
  {
    chat: "right",
    action: "right",
    group: "movement",
    description: "Move streamer right · 5s",
    needsPoints: true,
  },
  {
    chat: "forward",
    action: "forward",
    group: "movement",
    description: "Move streamer forward · 5s",
    needsPoints: true,
  },
  {
    chat: "back",
    action: "back",
    group: "movement",
    description: "Move streamer backward · 5s",
    needsPoints: true,
  },
  {
    chat: "handsup",
    action: "handsup",
    group: "movement",
    description: "Hands up · 5s",
    needsPoints: true,
  },
  {
    chat: "vehicle",
    action: "toggle_vehicle",
    group: "movement",
    description: "Enter / exit vehicle",
    needsPoints: true,
  },
  {
    chat: "donate",
    action: "donate",
    group: "rewards",
    description: "Give streamer $25 in-city",
    needsPoints: false,
  },
  {
    chat: "tip",
    action: "tip",
    group: "rewards",
    description: "Tip streamer $500 · max 10/day",
    needsPoints: false,
  },
  {
    chat: "dailymech",
    action: "dailymech",
    group: "rewards",
    description: "Vehicle parts to streamer · 1/day · in-city",
    needsPoints: false,
  },
  {
    chat: "coke",
    action: "coke",
    group: "rewards",
    description: "Supply D0SiL 1 bag · 1/day · in-city",
    needsPoints: false,
    streamers: ["d0sil"],
  },
  {
    chat: "daily",
    action: "daily",
    group: "rewards",
    description: "Unlock Daily Carhub in /kickmenu",
    needsPoints: false,
    streamers: ["na5ty"],
  },
  {
    chat: "balance",
    action: "balance",
    group: "info",
    description: "Check your points in chat",
    needsPoints: false,
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

function getChatCommandsForStreamer(streamerSlug) {
  const slug = normalizeStreamer(streamerSlug);
  return COMMAND_CATALOG.filter((cmd) => {
    if (cmd.streamers && !cmd.streamers.some((s) => normalizeStreamer(s) === slug)) {
      return false;
    }
    return true;
  }).map((cmd) => ({
    chat: cmd.chat,
    action: cmd.action,
    group: cmd.group,
    groupLabel: GROUP_LABELS[cmd.group] || cmd.group,
    description: cmd.description,
    needsPoints: Boolean(cmd.needsPoints),
  }));
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
  formatKeywordUsage,
};
