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
    description: "Check your points in chat",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "skydive",
    action: "skydive",
    group: "troll",
    description: "Launch streamer",
    needsPoints: true,
    pointCost: 250,
  },
  {
    chat: "shae",
    action: "shae",
    group: "troll",
    description: "Cougar attack",
    needsPoints: true,
    pointCost: 45,
  },
  {
    chat: "poop",
    action: "poop",
    group: "troll",
    description: "Poop emote",
    needsPoints: true,
    pointCost: 15,
  },
  {
    chat: "fart",
    action: "fart",
    group: "troll",
    description: "Fart 1 · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "fart2",
    action: "fart2",
    group: "troll",
    description: "Fart 2 · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "reverse",
    action: "reverse",
    group: "troll",
    description: "Swap W/S · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "lag",
    action: "lag",
    group: "troll",
    description: "Fake lag · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "timecycle",
    action: "timecycle",
    group: "troll",
    description: "Random filter · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "slow",
    action: "slow",
    group: "troll",
    description: "Slow walk · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "doors",
    action: "doors",
    group: "troll",
    description: "Slam car doors · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "nuke",
    action: "nuke",
    group: "troll",
    description: "Nuke alarm · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "flip",
    action: "flip",
    group: "troll",
    description: "Flip vehicle · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "yeet",
    action: "yeet",
    group: "troll",
    description: "Flip player · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "fire",
    action: "fire",
    group: "troll",
    description: "On fire · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "twod",
    action: "twod",
    group: "troll",
    description: "2D camera · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "flipcam",
    action: "flipcam",
    group: "troll",
    description: "Flip camera · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "clone",
    action: "clone",
    group: "troll",
    description: "Clone follow · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "clones",
    action: "clones",
    group: "troll",
    description: "Clone circle · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "swat",
    action: "swat",
    group: "troll",
    description: "Attack NPC · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "animal",
    action: "animal",
    group: "troll",
    description: "Attack animal · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "kidnap",
    action: "kidnap",
    group: "troll",
    description: "Kidnap van · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "ghost",
    action: "ghost",
    group: "troll",
    description: "Ghost · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "ufo",
    action: "ufo",
    group: "troll",
    description: "UFO kidnap · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "force",
    action: "force",
    group: "troll",
    description: "Force control · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "invis",
    action: "invis",
    group: "troll",
    description: "Invisibility · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "lights",
    action: "lights",
    group: "troll",
    description: "Lights out · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "tiny",
    action: "tiny",
    group: "troll",
    description: "Shrink · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "giant",
    action: "giant",
    group: "troll",
    description: "Giant · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "wheel",
    action: "wheel",
    group: "troll",
    description: "Break wheel · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "fog",
    action: "fog",
    group: "troll",
    description: "Ultra fog · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "snow",
    action: "snow",
    group: "troll",
    description: "Snow · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "moon",
    action: "moon",
    group: "troll",
    description: "Low gravity · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "boom",
    action: "boom",
    group: "troll",
    description: "Shockwave · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "fov",
    action: "fov",
    group: "troll",
    description: "FOV camera · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "lowpoly",
    action: "lowpoly",
    group: "troll",
    description: "Low poly · test",
    needsPoints: false,
    pointCost: 0,
  },
  {
    chat: "untroll",
    action: "untroll",
    group: "troll",
    description: "Stop trolls",
    needsPoints: false,
    pointCost: 0,
  },
];

const GROUP_LABELS = {
  movement: "Movement (costs Kick Points)",
  rewards: "Rewards & triggers",
  info: "Info",
  troll: "Trolls (test · 0 pts)",
};

function normalizeStreamer(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function getCommandPointCost(actionOrChat) {
  const key = String(actionOrChat || "")
    .trim()
    .toLowerCase()
    .replace(/^!/, "");
  if (!key) return 0;
  const cmd = COMMAND_CATALOG.find(
    (row) => row.action === key || row.chat === key
  );
  if (!cmd) return 0;
  if (Number.isFinite(Number(cmd.pointCost))) return Math.max(0, Number(cmd.pointCost));
  return cmd.needsPoints ? 1 : 0;
}

function getChatCommandsForStreamer(streamerSlug) {
  const slug = normalizeStreamer(streamerSlug);
  return COMMAND_CATALOG.filter((cmd) => {
    if (cmd.streamers && !cmd.streamers.some((s) => normalizeStreamer(s) === slug)) {
      return false;
    }
    return true;
  }).map((cmd) => {
    const pointCost = getCommandPointCost(cmd.action);
    return {
      chat: cmd.chat,
      action: cmd.action,
      group: cmd.group,
      groupLabel: GROUP_LABELS[cmd.group] || cmd.group,
      description: cmd.description,
      needsPoints: Boolean(cmd.needsPoints) || pointCost > 0,
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
};
