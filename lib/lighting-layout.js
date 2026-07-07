const fs = require("fs");
const path = require("path");
const hue = require("./hue");
const govee = require("./govee");
const hueConfig = require("./hue-config");
const goveeConfig = require("./govee-config");
const goveeRgbic = require("./govee-rgbic");
const lightingChatMute = require("./lighting-chat-mute");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "lighting-layout.json");

const FLASH_PATTERNS = ["unison", "chase", "alternate", "sides", "rainbow"];

const hueFlashGen = new Map();

function nextHueFlashGen(broadcasterUserId) {
  const id = String(broadcasterUserId);
  const gen = (hueFlashGen.get(id) || 0) + 1;
  hueFlashGen.set(id, gen);
  return gen;
}

function isCurrentHueFlash(broadcasterUserId, gen) {
  return hueFlashGen.get(String(broadcasterUserId)) === gen;
}

const MAP_COLORS = [
  { key: "blue", name: "Blue", hue: 46920 },
  { key: "red", name: "Red", hue: 0 },
  { key: "green", name: "Green", hue: 25500 },
  { key: "orange", name: "Orange", hue: 8500 },
  { key: "purple", name: "Purple", hue: 56100 },
  { key: "cyan", name: "Cyan", hue: 38550 },
];

const STRIP_MAP_COLORS = {
  top: MAP_COLORS[0],
  bottom: MAP_COLORS[1],
};

function readAll() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(configs) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2));
}

function clampPercent(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeLight(entry, fallbackOrder = 0) {
  if (!entry?.id || !entry?.source || !entry?.ref) return null;
  const stripCount = Math.max(1, Math.min(4, Number(entry.stripCount) || 1));
  const stripPart = Math.max(0, Math.min(stripCount - 1, Number(entry.stripPart) || 0));
  return {
    id: String(entry.id),
    source: entry.source === "govee" ? "govee" : "hue",
    ref: String(entry.ref),
    name: String(entry.name || entry.ref),
    x: clampPercent(entry.x, 50),
    y: clampPercent(entry.y, 12 + fallbackOrder * 16),
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : fallbackOrder,
    stripCount: entry.source === "govee" ? stripCount : 1,
    stripPart: entry.source === "govee" ? stripPart : 0,
  };
}

function buildFromSelections(broadcasterUserId) {
  const hueCfg = hueConfig.getConfig(broadcasterUserId) || {};
  const goveeCfg = goveeConfig.getConfig(broadcasterUserId) || {};
  const lights = [];
  let order = 0;

  for (const id of hueCfg.selectedLightIds || []) {
    const ref = String(id);
    lights.push(
      normalizeLight(
        {
          id: `hue:${ref}`,
          source: "hue",
          ref,
          name: `Hue light ${ref}`,
          x: 50,
          y: 12 + order * 16,
          order,
        },
        order
      )
    );
    order += 1;
  }

  for (const device of goveeCfg.selectedDevices || []) {
    if (!device?.key) continue;
    lights.push(
      normalizeLight(
        {
          id: `govee:${device.key}`,
          source: "govee",
          ref: device.key,
          name: device.name || device.sku || device.key,
          x: 50,
          y: 12 + order * 16,
          order,
        },
        order
      )
    );
    order += 1;
  }

  return lights;
}

function mergeLights(existing = [], fresh = []) {
  const existingById = new Map((existing || []).map((entry) => [entry.id, entry]));
  return fresh.map((entry, index) => {
    const prior = existingById.get(entry.id);
    if (!prior) return entry;
    return normalizeLight({ ...entry, ...prior, id: entry.id, source: entry.source, ref: entry.ref }, index);
  });
}

function getLayout(broadcasterUserId) {
  const stored = readAll()[String(broadcasterUserId)] || {};
  const pattern = FLASH_PATTERNS.includes(stored.flashPattern) ? stored.flashPattern : "unison";
  const lights = (stored.lights || []).map((entry, index) => normalizeLight(entry, index)).filter(Boolean);
  return {
    flashPattern: pattern,
    lights,
    updatedAt: stored.updatedAt || null,
  };
}

function saveLayout(broadcasterUserId, patch = {}) {
  const current = getLayout(broadcasterUserId);
  const configs = readAll();
  const id = String(broadcasterUserId);

  const flashPattern = FLASH_PATTERNS.includes(patch.flashPattern)
    ? patch.flashPattern
    : current.flashPattern;

  let lights = current.lights;
  if (Array.isArray(patch.lights)) {
    lights = patch.lights.map((entry, index) => normalizeLight(entry, index)).filter(Boolean);
  }

  configs[id] = {
    flashPattern,
    lights,
    updatedAt: new Date().toISOString(),
  };
  writeAll(configs);
  return getLayout(id);
}

function syncLayoutFromDevices(broadcasterUserId) {
  const current = getLayout(broadcasterUserId);
  const fresh = buildFromSelections(broadcasterUserId);
  return saveLayout(broadcasterUserId, {
    flashPattern: current.flashPattern,
    lights: mergeLights(current.lights, fresh),
  });
}

function sortedLights(layout) {
  return [...(layout.lights || [])].sort(
    (a, b) => a.y - b.y || a.order - b.order || a.id.localeCompare(b.id)
  );
}

function pickLightsForBeat(layout, session = {}) {
  const lights = sortedLights(layout);
  if (!lights.length) return [];

  const beatIndex = Number(session.layoutBeatIndex) || 0;
  const pattern = layout.flashPattern || "unison";

  if (pattern === "chase") {
    return [lights[beatIndex % lights.length]];
  }

  if (pattern === "alternate") {
    const oddBeat = beatIndex % 2 === 1;
    return lights.filter((light, index) => (index % 2 === 1) === oddBeat);
  }

  if (pattern === "sides") {
    const bottomHalf = beatIndex % 2 === 1;
    return lights.filter((light) => (light.y >= 50) === bottomHalf);
  }

  return lights;
}

function colorForLight(light, palette, lightIndex, accent) {
  if (!palette?.length) {
    return { hue: 0, sat: 254, bri: accent ? 254 : 228, accent };
  }
  const pattern = light.layoutPattern;
  const offset =
    pattern === "rainbow" || !pattern ? lightIndex % palette.length : 0;
  const color = palette[offset];
  return {
    hue: color.hue,
    sat: color.sat ?? 254,
    bri: accent ? 254 : color.bri ?? 228,
    accent,
  };
}

function flashHueLightsBatch(broadcasterUserId, lights, color, onMs, flashGen) {
  if (!lights.length || lightingChatMute.isMuted(broadcasterUserId)) {
    return;
  }
  const flashEpoch = lightingChatMute.getFlashEpoch();
  const refs = lights.map((light) => light.ref);
  const state = {
    on: true,
    hue: color.hue ?? 0,
    sat: color.sat ?? 254,
    bri: color.bri ?? 160,
    transitiontime: 0,
  };
  if (Number(color.sat) === 0) {
    state.sat = 0;
  }
  hue
    .applyState(broadcasterUserId, state, { lightIds: refs, groupId: "" })
    .catch((error) => {
      console.warn("[lighting-layout] hue on:", error.message);
    });

  setTimeout(() => {
    if (
      !lightingChatMute.isFlashEpochCurrent(flashEpoch) ||
      lightingChatMute.isMuted(broadcasterUserId) ||
      !isCurrentHueFlash(broadcasterUserId, flashGen)
    ) {
      return;
    }
    hue
      .applyState(broadcasterUserId, { on: false, transitiontime: 0 }, {
        lightIds: refs,
        groupId: "",
      })
      .catch((error) => {
        console.warn("[lighting-layout] hue off:", error.message);
      });
  }, onMs);
}

function flashHueLight(broadcasterUserId, light, color, onMs, flashGen) {
  if (lightingChatMute.isMuted(broadcasterUserId)) {
    return;
  }
  const flashEpoch = lightingChatMute.getFlashEpoch();
  const state = {
    on: true,
    hue: color.hue ?? 0,
    sat: color.sat ?? 254,
    bri: color.bri ?? 160,
    transitiontime: 0,
  };
  if (Number(color.sat) === 0) {
    state.sat = 0;
  }
  hue
    .applyState(broadcasterUserId, state, { lightIds: [light.ref], groupId: "" })
    .catch((error) => {
      console.warn("[lighting-layout] hue on:", error.message);
    });

  setTimeout(() => {
    if (
      !lightingChatMute.isFlashEpochCurrent(flashEpoch) ||
      lightingChatMute.isMuted(broadcasterUserId) ||
      !isCurrentHueFlash(broadcasterUserId, flashGen)
    ) {
      return;
    }
    hue
      .applyState(broadcasterUserId, { on: false, transitiontime: 0 }, {
        lightIds: [light.ref],
        groupId: "",
      })
      .catch((error) => {
        console.warn("[lighting-layout] hue off:", error.message);
      });
  }, onMs);
}

function flashGoveeLight(broadcasterUserId, light, color, onMs) {
  if (lightingChatMute.isMuted(broadcasterUserId)) {
    return;
  }
  const flashEpoch = lightingChatMute.getFlashEpoch();
  const holdMs = Math.max(Number(onMs) || 160, 110);
  govee
    .flashOnOne(broadcasterUserId, light.ref, color, undefined, light)
    .then(() => {
      setTimeout(() => {
        if (!lightingChatMute.isFlashEpochCurrent(flashEpoch) || lightingChatMute.isMuted(broadcasterUserId)) {
          return;
        }
        govee.flashOffOne(broadcasterUserId, light.ref, light).catch((error) => {
          console.warn("[lighting-layout] govee off:", error.message);
        });
      }, holdMs);
    })
    .catch((error) => {
      console.warn("[lighting-layout] govee on:", error.message);
    });
}

function applyBeatFlash(broadcasterUserId, session, options = {}) {
  if (lightingChatMute.isMuted(broadcasterUserId)) {
    return { pattern: getLayout(broadcasterUserId).flashPattern, count: 0 };
  }
  const layout = getLayout(broadcasterUserId);
  const lights = pickLightsForBeat(layout, session);
  if (!lights.length) {
    return { pattern: layout.flashPattern, count: 0 };
  }

  session.layoutBeatIndex = (Number(session.layoutBeatIndex) || 0) + 1;

  const palette = options.palette || [];
  const accent = Boolean(options.accent);
  const onMs = Number(options.onMs) || 160;
  const pattern = layout.flashPattern || "unison";
  const useRainbowColors = pattern === "rainbow";
  const flashGen = nextHueFlashGen(broadcasterUserId);

  const hueLights = [];
  const goveeLights = [];

  lights.forEach((light, index) => {
    const color = useRainbowColors
      ? colorForLight(light, palette, index, accent)
      : {
          ...options.color,
          hue: options.color?.hue ?? 0,
          sat: options.color?.sat ?? 254,
          bri: options.color?.bri ?? 160,
          accent,
        };

    if (light.source === "govee") {
      const goveeFlashColor = useRainbowColors
        ? color
        : {
            ...(options.goveeColor || options.color),
            hue: (options.goveeColor || options.color)?.hue ?? 0,
            sat: (options.goveeColor || options.color)?.sat ?? 254,
            bri: (options.goveeColor || options.color)?.bri ?? 160,
            accent,
          };
      goveeLights.push({ light, color: goveeFlashColor });
    } else {
      hueLights.push({ light, color });
    }
  });

  if (pattern === "unison" && hueLights.length) {
    flashHueLightsBatch(
      broadcasterUserId,
      hueLights.map((entry) => entry.light),
      hueLights[0].color,
      onMs,
      flashGen
    );
  } else {
    hueLights.forEach(({ light, color }) => {
      flashHueLight(broadcasterUserId, light, color, onMs, flashGen);
    });
  }

  goveeLights.forEach(({ light, color }) => {
    flashGoveeLight(broadcasterUserId, light, color, onMs);
  });

  return { pattern, count: lights.length };
}

async function identifyLight(broadcasterUserId, lightId, holdMs = 4000) {
  const layout = getLayout(broadcasterUserId);
  const light = layout.lights.find((entry) => entry.id === lightId);
  if (!light) {
    throw new Error("Light not found in layout");
  }

  const hold = Math.max(1500, Math.min(10000, Number(holdMs) || 4000));
  const red = { hue: 0, sat: 254, bri: 254, accent: true };

  if (light.source === "govee") {
    const sku = goveeRgbic.inferSkuFromRef(light.ref);
    try {
      if (Number(light.stripCount) > 1) {
        const color =
          Number(light.stripPart) === 0 ? STRIP_MAP_COLORS.top : STRIP_MAP_COLORS.bottom;
        await govee.holdColorOne(
          broadcasterUserId,
          light.ref,
          { hue: color.hue, sat: 254, bri: 254, accent: true },
          100,
          light
        );
      } else if (goveeRgbic.skuSupportsStripSplit(sku)) {
        await govee.paintRgbicHalves(
          broadcasterUserId,
          light.ref,
          { hue: STRIP_MAP_COLORS.top.hue, sat: 254, bri: 254 },
          { hue: STRIP_MAP_COLORS.bottom.hue, sat: 254, bri: 254 }
        );
      } else {
        await govee.holdColorOne(broadcasterUserId, light.ref, red, 100, light);
      }
    } catch (error) {
      await govee.holdColorOne(broadcasterUserId, light.ref, red, 100, light).catch(() => {
        throw error;
      });
    }
  } else {
    await hue.applyState(
      broadcasterUserId,
      { on: true, hue: 0, sat: 254, bri: 254, transitiontime: 0 },
      { lightIds: [light.ref], groupId: "" }
    );
  }

  await new Promise((resolve) => setTimeout(resolve, hold));

  if (light.source === "govee") {
    const sku = goveeRgbic.inferSkuFromRef(light.ref);
    if (Number(light.stripCount) > 1) {
      await govee.flashOffOne(broadcasterUserId, light.ref, light);
    } else {
      await govee.flashOffOne(broadcasterUserId, light.ref, null);
    }
  } else {
    await hue.applyState(
      broadcasterUserId,
      { on: false, transitiontime: 0 },
      { lightIds: [light.ref], groupId: "" }
    );
  }

  return { lightId: light.id, name: light.name, holdMs: hold };
}

function splitGoveeStrip(broadcasterUserId, lightId, parts = 2) {
  const layout = getLayout(broadcasterUserId);
  const index = layout.lights.findIndex((entry) => entry.id === lightId);
  if (index === -1) {
    throw new Error("Light not found in layout");
  }

  const light = layout.lights[index];
  if (light.source !== "govee") {
    throw new Error("Only Govee lights can be split into strips");
  }
  if (Number(light.stripCount) > 1) {
    throw new Error("This light is already split");
  }

  const sku = goveeRgbic.inferSkuFromRef(light.ref);
  if (!goveeRgbic.skuSupportsStripSplit(sku)) {
    throw new Error(`${sku || "This device"} does not support per-strip chase via LAN`);
  }

  const count = Math.max(2, Math.min(2, Number(parts) || 2));
  const gap = 10;
  const centerY = light.y;
  const replacements = [];

  for (let part = 0; part < count; part += 1) {
    replacements.push(
      normalizeLight(
        {
          ...light,
          id: `${light.id}#strip${part}`,
          name: `${light.name} · strip ${part + 1}`,
          stripCount: count,
          stripPart: part,
          y: Math.max(8, Math.min(92, centerY - gap / 2 + part * gap)),
          order: light.order + part * 0.01,
        },
        index + part
      )
    );
  }

  const lights = [...layout.lights];
  lights.splice(index, 1, ...replacements);
  return saveLayout(broadcasterUserId, { lights });
}

async function lightsOff(broadcasterUserId) {
  await hue.applyState(broadcasterUserId, { on: false, transitiontime: 0 }).catch(() => {});
  await govee.allOff(broadcasterUserId).catch(() => {});
}

async function mapLayoutColors(broadcasterUserId, holdMs = 10000) {
  const layout = getLayout(broadcasterUserId);
  const lights = sortedLights(layout);
  if (!lights.length) {
    throw new Error("Add lights to the layout first (Sync from devices).");
  }

  const hold = Math.max(4000, Math.min(20000, Number(holdMs) || 10000));
  const assignments = [];
  const paintedGoveeRefs = new Set();
  let colorIndex = 0;

  const goveeGroups = new Map();
  for (const light of lights) {
    if (light.source !== "govee") continue;
    const group = goveeGroups.get(light.ref) || [];
    group.push(light);
    goveeGroups.set(light.ref, group);
  }

  for (const light of lights) {
    if (light.source !== "govee") {
      const color = MAP_COLORS[colorIndex % MAP_COLORS.length];
      colorIndex += 1;
      assignments.push({
        lightId: light.id,
        name: light.name,
        colorKey: color.key,
        colorName: color.name,
      });
      try {
        await hue.applyState(
          broadcasterUserId,
          { on: true, hue: color.hue, sat: 254, bri: 254, transitiontime: 0 },
          { lightIds: [light.ref], groupId: "" }
        );
      } catch (error) {
        assignments[assignments.length - 1].error = error.message;
      }
      continue;
    }

    const group = goveeGroups.get(light.ref) || [light];
    if (paintedGoveeRefs.has(light.ref)) {
      continue;
    }

    const splitParts = group.filter((entry) => Number(entry.stripCount) > 1);
    if (splitParts.length >= 2) {
      for (const part of splitParts.sort((a, b) => a.stripPart - b.stripPart)) {
        const color =
          Number(part.stripPart) === 0 ? STRIP_MAP_COLORS.top : STRIP_MAP_COLORS.bottom;
        const entry = {
          lightId: part.id,
          name: part.name,
          colorKey: color.key,
          colorName: color.name,
          note: Number(part.stripPart) === 0 ? "top roll" : "bottom roll",
        };
        assignments.push(entry);
        try {
          await govee.holdColorOne(
            broadcasterUserId,
            part.ref,
            { hue: color.hue, sat: 254, bri: 254, accent: true },
            100,
            part
          );
          await new Promise((resolve) => setTimeout(resolve, 60));
        } catch (error) {
          entry.error = error.message;
        }
      }
      paintedGoveeRefs.add(light.ref);
      continue;
    }

    const single = group[0];
    const sku = goveeRgbic.inferSkuFromRef(single.ref);
    if (goveeRgbic.skuSupportsStripSplit(sku) && group.length === 1) {
      const entry = {
        lightId: single.id,
        name: single.name,
        colorKey: "blue+red",
        colorName: "Blue top / Red bottom",
        note: "dual-strip preview",
      };
      assignments.push(entry);
      try {
        await govee.paintRgbicHalves(
          broadcasterUserId,
          single.ref,
          { hue: STRIP_MAP_COLORS.top.hue, sat: 254, bri: 254 },
          { hue: STRIP_MAP_COLORS.bottom.hue, sat: 254, bri: 254 }
        );
      } catch (error) {
        try {
          await govee.holdColorOne(
            broadcasterUserId,
            single.ref,
            { hue: STRIP_MAP_COLORS.top.hue, sat: 254, bri: 254, accent: true },
            100,
            single
          );
          entry.note = "full strip (segment map unavailable)";
        } catch (fallbackError) {
          entry.error = fallbackError.message;
        }
      }
      paintedGoveeRefs.add(light.ref);
      continue;
    }

    const color = MAP_COLORS[colorIndex % MAP_COLORS.length];
    colorIndex += 1;
    const entry = {
      lightId: single.id,
      name: single.name,
      colorKey: color.key,
      colorName: color.name,
    };
    assignments.push(entry);
    try {
      await govee.holdColorOne(
        broadcasterUserId,
        single.ref,
        { hue: color.hue, sat: 254, bri: 254, accent: true },
        100,
        single
      );
    } catch (error) {
      entry.error = error.message;
    }
    paintedGoveeRefs.add(light.ref);
  }

  const painted = assignments.filter((entry) => !entry.error).length;
  if (!painted) {
    throw new Error("Could not reach any lights. Check Hue bridge + Govee LAN, then restart this server.");
  }

  await new Promise((resolve) => setTimeout(resolve, hold));
  await lightsOff(broadcasterUserId);

  return { holdMs: hold, assignments, warnings: assignments.filter((entry) => entry.error) };
}

async function testPattern(broadcasterUserId, beats = 4) {
  const layout = getLayout(broadcasterUserId);
  if (!layout.lights.length) {
    throw new Error("Add lights to the layout first (Sync from devices).");
  }

  const session = { layoutBeatIndex: 0 };
  const palette = [
    { hue: 0, sat: 254, bri: 254 },
    { hue: 12750, sat: 254, bri: 254 },
    { hue: 25500, sat: 254, bri: 254 },
    { hue: 46920, sat: 254, bri: 254 },
    { hue: 56100, sat: 254, bri: 254 },
  ];

  for (let beat = 0; beat < beats; beat += 1) {
    applyBeatFlash(broadcasterUserId, session, {
      palette,
      color: palette[beat % palette.length],
      onMs: 220,
      accent: beat % 3 === 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  await hue.applyState(broadcasterUserId, { on: false, transitiontime: 0 }).catch(() => {});
  await govee.flashOffAll(broadcasterUserId).catch(() => {});

  return { pattern: layout.flashPattern, beats, lights: layout.lights.length };
}

module.exports = {
  FLASH_PATTERNS,
  MAP_COLORS,
  getLayout,
  saveLayout,
  syncLayoutFromDevices,
  applyBeatFlash,
  identifyLight,
  mapLayoutColors,
  splitGoveeStrip,
  testPattern,
};
