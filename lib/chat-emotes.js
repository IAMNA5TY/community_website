function normalizeEmotes(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const id = entry?.id ?? entry?.emote_id ?? entry?.emoteId;
      const name = entry?.name ?? entry?.emote_name ?? entry?.emoteName;
      if (!id || !name) return null;

      return {
        id: String(id),
        name: String(name).replace(/^:+|:+$/g, ""),
      };
    })
    .filter(Boolean);
}

module.exports = {
  normalizeEmotes,
  emoteImageUrl(emoteId) {
    return `https://files.kick.com/emotes/${emoteId}/fullsize`;
  },
};
