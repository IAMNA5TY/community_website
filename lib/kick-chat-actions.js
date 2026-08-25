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
  ["!skydive", "skydive"],
  ["shae", "shae"],
  ["poop", "poop"],
  ["shit", "poop"],
]);

function normalizeLine(content) {
  return String(content || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\[emote:\d+:([^\]]+)\]/g, ":$1:")
    .replace(/^@[a-z0-9_-]+\s+/i, "")
    .toLowerCase();
}

function unwrapChatToken(token) {
  let t = String(token || "").toLowerCase().trim();
  const emote = t.match(/\[emote:\d+:([^\]]+)\]/);
  if (emote) t = emote[1];
  t = t.replace(/^:+/, "").replace(/:+$/, "");
  t = t.replace(/[^a-z0-9]+$/gi, "");
  return t;
}

function isKickEmoteOnly(content) {
  const t = String(content || "").trim();
  if (!t) return false;
  return /^(\[emote:\d+:[^\]]+\]\s*)+$/i.test(t);
}

function parseChatControlAction(content) {
  const raw = String(content || "").trim();
  const emoteOnly = isKickEmoteOnly(raw);
  const line = normalizeLine(content);
  if (!line) return null;

  const rawFirst = line.match(/^(\S+)/)?.[1] || line;
  // Strip trailing punctuation (tip! / forward.) but keep leading ! for !daily / !balance.
  const stripped = rawFirst.replace(/[^a-z0-9]+$/gi, "");
  const typedCandidates = [line, rawFirst, stripped, stripped.replace(/^!/, "")];
  // Emote names can still fire a few keywords (shae). Paid joke commands must be typed letters.
  const candidates = emoteOnly
    ? [unwrapChatToken(line), unwrapChatToken(rawFirst), unwrapChatToken(stripped)]
    : typedCandidates.concat([
        unwrapChatToken(line),
        unwrapChatToken(rawFirst),
        unwrapChatToken(stripped),
      ]);
  let action = null;
  for (const key of candidates) {
    if (key && CONTROL_ACTIONS.has(key)) {
      action = CONTROL_ACTIONS.get(key);
      break;
    }
  }
  if (!action) return null;
  if (emoteOnly && action === "poop") return null;

  return {
    action,
    message: raw,
  };
}

module.exports = {
  parseChatControlAction,
  CONTROL_ACTIONS,
};
