'use strict';

const fs = require("fs");

/**
 * In-memory JSON store with debounced disk flushes.
 * Chat traffic used to write pretty-printed JSON on every message, which
 * blocked the event loop and could make Railway kill / stop the service.
 */
function createDeferredJsonStore({
  path: filePath,
  load,
  flushMs = 750,
  pretty = false,
  ensureDir = null,
}) {
  let memory = null;
  let dirty = false;
  let flushTimer = null;
  let writing = false;
  let writeQueued = false;

  function get() {
    if (!memory) memory = load();
    return memory;
  }

  function set(next) {
    memory = next;
    scheduleFlush();
    return memory;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch((error) => {
        console.warn(`[store] flush failed (${filePath}):`, error.message);
      });
    }, flushMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function serialize() {
    return pretty ? JSON.stringify(memory, null, 2) : JSON.stringify(memory);
  }

  function writeSync() {
    if (!memory || !dirty) return;
    if (ensureDir) ensureDir();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, serialize());
    fs.renameSync(tmp, filePath);
    dirty = false;
  }

  async function flush() {
    if (!dirty || !memory) return;
    if (writing) {
      writeQueued = true;
      return;
    }
    writing = true;
    try {
      while (dirty && memory) {
        dirty = false;
        if (ensureDir) ensureDir();
        const tmp = `${filePath}.tmp`;
        const payload = serialize();
        await fs.promises.writeFile(tmp, payload);
        await fs.promises.rename(tmp, filePath);
      }
    } finally {
      writing = false;
      if (writeQueued) {
        writeQueued = false;
        if (dirty) scheduleFlush();
      }
    }
  }

  function flushSyncNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      writeSync();
    } catch (error) {
      console.warn(`[store] sync flush failed (${filePath}):`, error.message);
    }
  }

  return {
    get,
    set,
    scheduleFlush,
    flush,
    flushSyncNow,
    get dirty() {
      return dirty;
    },
    get path() {
      return filePath;
    },
  };
}

module.exports = {
  createDeferredJsonStore,
};
