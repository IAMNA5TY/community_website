const CONTROL_ACTIONS = new Map([
  ["left", "left"],
  ["right", "right"],
  ["forward", "forward"],
  ["back", "back"],
  ["handsup", "handsup"],
  ["vehicle", "toggle_vehicle"],
  ["donate", "donate"],
  ["tip", "tip"],
  ["daily", "daily"],
  ["!daily", "daily"],
  ["balance", "balance"],
  ["!balance", "balance"],
  ["!bal", "balance"],
]);

function normalizeLine(content) {
  return String(content || "")
    .trim()
    .replace(/\[emote:\d+:([^\]]+)\]/g, ":$1:")
    .toLowerCase();
}

function parseChatControlAction(content) {
  const line = normalizeLine(content);
  if (!line) return null;

  const firstWord = line.match(/^(\S+)/)?.[1] || line;
  const action = CONTROL_ACTIONS.get(firstWord) || CONTROL_ACTIONS.get(line);
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
