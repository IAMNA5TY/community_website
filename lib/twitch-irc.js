function unescapeTag(value) {
  return String(value || "")
    .replace(/\\:/g, ";")
    .replace(/\\s/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n");
}

function parseTags(tagString) {
  const tags = {};
  if (!tagString) return tags;
  for (const part of String(tagString).split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      tags[part] = "";
    } else {
      tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
  }
  return tags;
}

function parseIrcLine(line) {
  let rest = String(line || "").replace(/\r?\n$/, "");
  if (!rest) return null;

  let tags = {};
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    tags = parseTags(rest.slice(1, space));
    rest = rest.slice(space + 1);
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  let trailing = "";
  const trailIdx = rest.indexOf(" :");
  if (trailIdx !== -1) {
    trailing = rest.slice(trailIdx + 2);
    rest = rest.slice(0, trailIdx);
  }

  const parts = rest.split(" ").filter(Boolean);
  if (!parts.length) return null;

  return {
    tags,
    prefix,
    command: parts[0],
    params: parts.slice(1),
    trailing,
  };
}

function nickFromPrefix(prefix) {
  const raw = String(prefix || "");
  const bang = raw.indexOf("!");
  return (bang === -1 ? raw : raw.slice(0, bang)).replace(/^@/, "").toLowerCase();
}

function parseBadgeMap(badgeTag) {
  const badges = [];
  for (const part of String(badgeTag || "").split(",")) {
    if (!part) continue;
    const [type, version] = part.split("/");
    if (!type) continue;
    badges.push({ type: type.toLowerCase(), name: type.toLowerCase(), version: version || "" });
  }
  return badges;
}

function parseTwitchEmotes(emoteTag, text) {
  if (!emoteTag || !text) return [];
  const emotes = [];
  for (const item of String(emoteTag).split("/")) {
    if (!item) continue;
    const colon = item.indexOf(":");
    if (colon === -1) continue;
    const id = item.slice(0, colon);
    const ranges = item.slice(colon + 1);
    if (!id || !ranges) continue;
    for (const range of ranges.split(",")) {
      const [startRaw, endRaw] = range.split("-");
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      emotes.push({
        id: String(id),
        name: String(text).slice(start, end + 1),
        source: "twitch",
      });
    }
  }
  return emotes;
}

function giftCount(tags = {}) {
  const mass = parseInt(tags["msg-param-mass-gift-count"], 10);
  if (Number.isFinite(mass) && mass > 0) return mass;
  const gifts = parseInt(tags["msg-param-gift-count"], 10);
  if (Number.isFinite(gifts) && gifts > 0) return gifts;
  return 1;
}

function classifyUsernotice(tags = {}) {
  const id = String(tags["msg-id"] || "").toLowerCase();
  if (id === "sub" || id === "resub" || id === "giftpaidupgrade" || id === "anongiftpaidupgrade") {
    return { kind: "sub", quantity: 1 };
  }
  if (id === "subgift" || id === "anonsubgift") {
    return { kind: "sub", quantity: 1 };
  }
  if (id === "submysterygift" || id === "anonsubmysterygift") {
    return { kind: "sub", quantity: giftCount(tags) };
  }
  return { kind: id || "notice", quantity: 0 };
}

function toChatPayload(parsed) {
  if (!parsed) return null;
  const tags = parsed.tags || {};
  const login = String(tags.login || nickFromPrefix(parsed.prefix) || "")
    .trim()
    .replace(/^@/, "");
  const username = String(tags["display-name"] || login || "").trim() || login;
  if (!username) return null;

  const badges = parseBadgeMap(tags.badges);
  const content = String(parsed.trailing || "").trim();
  const emotes = parseTwitchEmotes(tags.emotes, parsed.trailing || "");
  const isBroadcaster =
    badges.some((badge) => badge.type === "broadcaster") ||
    Boolean(tags["user-id"] && tags["room-id"] && tags["user-id"] === tags["room-id"]);
  const isModerator =
    tags.mod === "1" ||
    badges.some((badge) => badge.type === "moderator" || badge.type === "broadcaster");
  const isSubscriber =
    tags.subscriber === "1" ||
    badges.some((badge) => badge.type === "subscriber" || badge.type === "founder");

  return {
    message_id: tags.id || `twitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    created_at: tags["tmi-sent-ts"]
      ? new Date(Number(tags["tmi-sent-ts"])).toISOString()
      : new Date().toISOString(),
    emotes,
    platform: "twitch",
    sender: {
      username,
      user_id: tags["user-id"] || null,
      profile_picture: null,
      identity: { badges },
      is_broadcaster: Boolean(isBroadcaster),
      is_moderator: Boolean(isModerator || isBroadcaster),
      is_subscriber: Boolean(isSubscriber),
    },
  };
}

function channelList(raw) {
  return String(raw || "iamna5ty")
    .split(",")
    .map((name) => name.trim().toLowerCase().replace(/^#/, ""))
    .filter(Boolean);
}

module.exports = {
  parseTags,
  parseIrcLine,
  nickFromPrefix,
  parseBadgeMap,
  parseTwitchEmotes,
  classifyUsernotice,
  toChatPayload,
  channelList,
};
