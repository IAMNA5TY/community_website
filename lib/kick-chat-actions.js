const CONTROL_ACTIONS = new Map([
  ["left", "left"],
  ["right", "right"],
  ["forward", "forward"],
  ["back", "back"],
  ["handsup", "handsup"],
  ["vehicle", "toggle_vehicle"],
  ["donate", "donate"],
  ["tip", "tip"],
  ["dailymech", "dailymech"],
  ["coke", "coke"],
  ["daily", "daily"],
  ["!daily", "daily"],
  ["balance", "balance"],
  ["!balance", "balance"],
  ["!bal", "balance"],
  ["skydive", "skydive"],
]);

function normalizeLine(content) {
  return String(content || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\[emote:\d+:([^\]]+)\]/g, ":$1:")
    .replace(/^@[a-z0-9_-]+\s+/i, "")
    .toLowerCase();
}

function parseChatControlAction(content) {
  const line = normalizeLine(content);
  if (!line) return null;

  const rawFirst = line.match(/^(\S+)/)?.[1] || line;
  // Strip trailing punctuation (tip! / forward.) but keep leading ! for !daily / !balance.
  const stripped = rawFirst.replace(/[^a-z0-9]+$/gi, "");
  const candidates = [line, rawFirst, stripped, stripped.replace(/^!/, "")];
  let action = null;
  for (const key of candidates) {
    if (CONTROL_ACTIONS.has(key)) {
      action = CONTROL_ACTIONS.get(key);
      break;
    }
  }
  if (!action) return null;

  return {
    action,
    message: String(content || "").trim(),
  };
}

module.exports = {
  parseChatControlAction,
  CONTROL_ACTIONS,
};
