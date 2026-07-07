const pending = new Map();
const TTL_MS = 10 * 60 * 1000;

function save(state, data) {
  pending.set(state, { ...data, createdAt: Date.now() });
}

function take(state) {
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) {
    return null;
  }
  return entry;
}

function prune() {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) {
      pending.delete(state);
    }
  }
}

module.exports = {
  save,
  take,
  prune,
};
