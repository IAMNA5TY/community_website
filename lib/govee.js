const goveeConfig = require("./govee-config");
const goveeLan = require("./govee-lan");
const goveeRgbic = require("./govee-rgbic");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getScanIps(broadcasterUserId) {
  const config = goveeConfig.getConfig(broadcasterUserId) || {};
  const fromConfig = config?.scanIps || [];
  const fromKnown = (config.knownDevices || []).map((entry) => entry.ip).filter(Boolean);
  const fromSelected = (config.selectedDevices || []).map((entry) => entry.ip).filter(Boolean);
  const fromEnv = String(process.env.GOVEE_LAN_SCAN || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([...fromConfig, ...fromEnv, ...fromKnown, ...fromSelected])];
}

function isConnected(broadcasterUserId) {
  const config = goveeConfig.getConfig(broadcasterUserId);
  return Boolean(
    (config?.knownDevices || []).length || (config?.selectedDevices || []).length
  );
}

function requireGoveeListener() {
  const status = goveeLan.getListenerStatus();
  if (!status.listening) {
    throw new Error(
      status.initError ||
        "Govee LAN is not listening on UDP port 4002. Close GoveeLAN, then restart the dashboard with start-everything.bat so one server owns that port."
    );
  }
}

function getPublicStatus(broadcasterUserId) {
  const config = goveeConfig.getConfig(broadcasterUserId);
  const selected = config?.selectedDevices || [];
  goveeLan.setKeepaliveTargets(selected.map((entry) => entry.ip));
  return {
    connected: isConnected(broadcasterUserId),
    mode: "lan",
    scanIps: getScanIps(broadcasterUserId),
    knownDevices: config?.knownDevices || [],
    selectedDevices: selected,
    lastScanAt: config?.lastScanAt || null,
    lastScanError: config?.lastScanError || null,
    listener: goveeLan.getListenerStatus(),
    portConflict: Boolean(goveeLan.getListenerStatus().initError),
  };
}

function deviceKey(entry) {
  return entry.key || `${entry.sku}:${entry.device}`;
}

function normalizeDevice(entry) {
  if (!entry?.ip || !entry?.sku || !entry?.device) return null;
  return {
    key: deviceKey(entry),
    ip: String(entry.ip),
    sku: String(entry.sku),
    device: String(entry.device),
    name: entry.name || entry.sku,
  };
}

function mergeDevices(existing = [], discovered = []) {
  const map = new Map();
  for (const entry of existing) {
    const normalized = normalizeDevice(entry);
    if (normalized) map.set(normalized.key, normalized);
  }
  for (const entry of discovered) {
    const normalized = normalizeDevice(entry);
    if (normalized) map.set(normalized.key, { ...map.get(normalized.key), ...normalized });
  }
  return [...map.values()];
}

function saveScanIps(broadcasterUserId, scanIps) {
  const cleaned = [...new Set((scanIps || []).map((ip) => String(ip).trim()).filter(Boolean))];
  return goveeConfig.saveConfig(broadcasterUserId, { scanIps: cleaned });
}

async function discover(broadcasterUserId) {
  const scanIps = getScanIps(broadcasterUserId);
  const config = goveeConfig.getConfig(broadcasterUserId) || {};

  try {
    await goveeLan.init();
    const discovered = await goveeLan.discoverDevices({ scanIps });
    const knownDevices = mergeDevices(config.knownDevices, discovered);
    goveeConfig.saveConfig(broadcasterUserId, {
      knownDevices,
      lastScanAt: new Date().toISOString(),
      lastScanError: null,
    });
    return { devices: knownDevices, discovered: discovered.length };
  } catch (error) {
    goveeConfig.saveConfig(broadcasterUserId, {
      lastScanAt: new Date().toISOString(),
      lastScanError: error.message,
    });
    throw error;
  }
}

function listDevices(broadcasterUserId) {
  const config = goveeConfig.getConfig(broadcasterUserId) || {};
  return {
    devices: config.knownDevices || [],
    selectedDevices: config.selectedDevices || [],
    scanIps: getScanIps(broadcasterUserId),
    lastScanAt: config.lastScanAt || null,
    lastScanError: config.lastScanError || null,
  };
}

function saveSelection(broadcasterUserId, selectedKeys) {
  const config = goveeConfig.getConfig(broadcasterUserId) || {};
  const known = new Map((config.knownDevices || []).map((entry) => [deviceKey(entry), entry]));
  const selectedDevices = (selectedKeys || [])
    .map((key) => known.get(String(key)))
    .filter(Boolean)
    .map(normalizeDevice)
    .filter(Boolean);

  if (!selectedDevices.length && selectedKeys?.length) {
    throw new Error("Selected devices were not found. Run Scan first.");
  }

  const saved = goveeConfig.saveConfig(broadcasterUserId, { selectedDevices });
  goveeLan.setKeepaliveTargets(selectedDevices.map((entry) => entry.ip));
  return saved;
}

function getSelectedDevices(broadcasterUserId) {
  return goveeConfig.getConfig(broadcasterUserId)?.selectedDevices || [];
}

const flashOffTimers = new Map();
const GOVEE_MIN_HOLD_MS = 200;

function clearScheduledOff(timerKey) {
  const entry = flashOffTimers.get(timerKey);
  if (!entry) return;
  clearTimeout(entry.primary);
  if (entry.backup) clearTimeout(entry.backup);
  flashOffTimers.delete(timerKey);
}

function scheduleOff(timerKey, onMs, runOff) {
  clearScheduledOff(timerKey);
  const primary = setTimeout(runOff, onMs);
  flashOffTimers.set(timerKey, { primary, backup: null });
}

function hueToRgb(hue65535, sat254 = 254, bri254 = 228) {
  const h = ((hue65535 / 65535) * 360) % 360;
  const s = Math.max(0, Math.min(1, sat254 / 254));
  const l = Math.max(0.15, Math.min(0.9, (bri254 / 254) * 0.55 + 0.2));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

async function setDeviceColor(target, color = {}, brightness = 100) {
  const rgb =
    Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b)
      ? { r: color.r, g: color.g, b: color.b }
      : hueToRgb(color.hue || 0, color.sat || 254, color.bri || 228);

  await goveeLan.wakeDevice(target.ip);
  await goveeLan.sendCommand(target.ip, "turn", { value: 1 });
  await goveeLan.setBrightness(target.ip, brightness);
  await goveeLan.setColorRgb(target.ip, rgb.r, rgb.g, rgb.b);
  return rgb;
}

function colorToRgb(color = {}, brightness = 85) {
  return Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b)
    ? { r: color.r, g: color.g, b: color.b }
    : hueToRgb(color.hue || 0, color.sat || 254, color.bri || 228);
}

const FLASH_BRIGHTNESS_SCALE = 0.88;

function flashBrightnessPercent(color = {}, brightness) {
  const raw = brightness ?? (color.bri ? (color.bri / 254) * 100 : 85);
  return Math.max(10, Math.min(100, Math.round(raw * FLASH_BRIGHTNESS_SCALE)));
}

async function flashOnAll(broadcasterUserId, color = {}, brightness) {
  const targets = getSelectedDevices(broadcasterUserId);
  if (!targets.length) return { flashed: 0 };

  await goveeLan.init().catch(() => {});
  if (!goveeLan.getListenerStatus().listening) return { flashed: 0 };

  const rgb = colorToRgb(color, brightness);
  const bri = flashBrightnessPercent(color, brightness);

  await Promise.all(targets.map((target) => goveeLan.wakeDevice(target.ip)));
  await Promise.all(
    targets.map((target) => goveeLan.sendCommandImmediate(target.ip, "turn", { value: 1 }))
  );
  await Promise.all(
    targets.map((target) =>
      goveeLan.sendCommandImmediate(target.ip, "brightness", {
        value: Math.max(1, Math.min(100, Math.round(bri))),
      })
    )
  );
  await Promise.all(
    targets.map((target) =>
      goveeLan.sendCommandImmediate(target.ip, "colorwc", {
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        colorTemInKelvin: 0,
      })
    )
  );

  return { flashed: targets.length };
}

async function flashOffAll(broadcasterUserId, options = {}) {
  const targets = getSelectedDevices(broadcasterUserId);
  if (!targets.length) return { off: 0 };

  await goveeLan.init().catch(() => {});
  if (!goveeLan.getListenerStatus().listening) return { off: 0 };

  if (options.reliable) {
    for (const target of targets) {
      await goveeLan.wakeDevice(target.ip);
      await goveeLan.turnOffReliable(target.ip);
    }
  } else {
    await Promise.all(targets.map((target) => goveeLan.turnFast(target.ip, false)));
  }
  return { off: targets.length };
}

function usesStripParts(light = {}) {
  return Number(light.stripCount) > 1;
}

async function flashRgbicPart(target, light, color = {}, brightness) {
  const rgb = colorToRgb(color, brightness);
  const { leftMask, rightMask } = goveeRgbic.segmentMasksForPart(
    Number(light.stripPart) || 0,
    Number(light.stripCount) || 2
  );
  const packet = goveeRgbic.buildSegmentColorPacket(rgb, leftMask, rightMask);

  await goveeLan.init().catch(() => {});
  await goveeLan.wakeDevice(target.ip);
  await goveeLan.sendCommandImmediate(target.ip, "turn", { value: 1 });
  await goveeLan.sendCommandImmediate(target.ip, "brightness", {
    value: Math.max(1, Math.min(100, Math.round(brightness ?? (color.accent ? 100 : 85)))),
  });
  await goveeLan.sendPtReal(target.ip, [packet]);
  return { flashed: 1, segmented: true };
}

async function flashOffRgbicPart(target, light) {
  const { leftMask, rightMask } = goveeRgbic.segmentMasksForPart(
    Number(light.stripPart) || 0,
    Number(light.stripCount) || 2
  );
  const packet = goveeRgbic.buildSegmentColorPacket({ r: 0, g: 0, b: 0 }, leftMask, rightMask);
  await goveeLan.sendPtReal(target.ip, [packet]);
  await delay(45);
  await goveeLan.sendPtReal(target.ip, [packet]);
  return { off: 1, segmented: true };
}

async function prepareGoveeTarget(target, brightness = 100) {
  await goveeLan.init().catch(() => {});
  await goveeLan.wakeDevice(target.ip);
  await goveeLan.sendCommandImmediate(target.ip, "turn", { value: 1 });
  await goveeLan.sendCommandImmediate(target.ip, "brightness", {
    value: Math.max(1, Math.min(100, Math.round(brightness))),
  });
}

async function holdRgbicPart(target, light, color = {}, brightness = 100) {
  const rgb = colorToRgb(color, brightness);
  const { leftMask, rightMask } = goveeRgbic.segmentMasksForPart(
    Number(light.stripPart) || 0,
    Number(light.stripCount) || 2
  );
  const packet = goveeRgbic.buildSegmentColorPacket(rgb, leftMask, rightMask);
  await prepareGoveeTarget(target, brightness);
  await goveeLan.sendPtReal(target.ip, [packet]);
  return { held: 1, segmented: true };
}

async function paintRgbicHalves(broadcasterUserId, key, topColor = {}, bottomColor = {}) {
  const targets = getSelectedDevices(broadcasterUserId);
  const target = targets.find((entry) => entry.key === key);
  if (!target) return { painted: 0 };

  const topRgb = colorToRgb(topColor, 100);
  const bottomRgb = colorToRgb(bottomColor, 100);
  const topPacket = goveeRgbic.buildSegmentColorPacket(topRgb, 0xff, 0x00);
  const bottomPacket = goveeRgbic.buildSegmentColorPacket(bottomRgb, 0x00, 0x7f);

  await prepareGoveeTarget(target, 100);
  await goveeLan.sendPtReal(target.ip, [topPacket]);
  await delay(50);
  await goveeLan.sendPtReal(target.ip, [bottomPacket]);
  return { painted: 1, halves: true };
}

async function holdColorOne(broadcasterUserId, key, color = {}, brightness = 100, lightOptions = null) {
  const targets = getSelectedDevices(broadcasterUserId);
  const target = targets.find((entry) => entry.key === key);
  if (!target) return { held: 0 };

  if (lightOptions && usesStripParts(lightOptions)) {
    return holdRgbicPart(target, lightOptions, color, brightness);
  }

  const rgb = colorToRgb(color, brightness);
  await prepareGoveeTarget(target, brightness);
  await goveeLan.sendCommandImmediate(target.ip, "colorwc", {
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    colorTemInKelvin: 0,
  });
  return { held: 1 };
}

async function flashOnOne(broadcasterUserId, key, color = {}, brightness, lightOptions = null) {
  const targets = getSelectedDevices(broadcasterUserId);
  const target = targets.find((entry) => entry.key === key);
  if (!target) {
    console.warn("[govee] flash on: device not in selection:", key);
    return { flashed: 0 };
  }

  if (lightOptions && usesStripParts(lightOptions)) {
    return flashRgbicPart(target, lightOptions, color, brightness);
  }

  await goveeLan.init().catch(() => {});
  if (!goveeLan.getListenerStatus().listening) return { flashed: 0 };
  const rgb = colorToRgb(color, brightness);
  const bri = flashBrightnessPercent(color, brightness);
  await goveeLan.wakeDevice(target.ip);
  await goveeLan.sendCommandImmediate(target.ip, "turn", { value: 1 });
  await goveeLan.sendCommandImmediate(target.ip, "brightness", { value: bri });
  await goveeLan.sendCommandImmediate(target.ip, "colorwc", {
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    colorTemInKelvin: 0,
  });
  return { flashed: 1 };
}

async function flashOffOne(broadcasterUserId, key, lightOptions = null) {
  const targets = getSelectedDevices(broadcasterUserId);
  const target = targets.find((entry) => entry.key === key);
  if (!target) return { off: 0 };

  if (lightOptions && usesStripParts(lightOptions)) {
    return flashOffRgbicPart(target, lightOptions);
  }

  await goveeLan.init().catch(() => {});
  if (!goveeLan.getListenerStatus().listening) return { off: 0 };
  await goveeLan.wakeDevice(target.ip);
  await goveeLan.turnFast(target.ip, false);
  return { off: 1 };
}

function scheduleFlashOffOne(broadcasterUserId, key, lightOptions, onMs, shouldOff) {
  const timerKey = `${broadcasterUserId}:${key}`;
  const holdMs = Math.max(Number(onMs) || 160, GOVEE_MIN_HOLD_MS);
  const runOff = () => {
    if (typeof shouldOff === "function" && !shouldOff()) return;
    flashOffOne(broadcasterUserId, key, lightOptions).catch((error) => {
      console.warn("[govee-lan] flash off:", error.message);
    });
  };
  scheduleOff(timerKey, holdMs, runOff);
}

async function flashBeatOne(
  broadcasterUserId,
  key,
  color,
  lightOptions,
  holdMs,
  shouldOff
) {
  try {
    const result = await flashOnOne(broadcasterUserId, key, color, undefined, lightOptions);
    if (!result?.flashed) {
      return result;
    }
    scheduleFlashOffOne(broadcasterUserId, key, lightOptions, holdMs, shouldOff);
    return result;
  } catch (error) {
    console.warn("[govee-lan] flash beat:", error.message);
    return { flashed: 0, error: error.message };
  }
}

function scheduleFlashOffAll(broadcasterUserId, onMs, shouldOff) {
  const timerKey = `${broadcasterUserId}:all`;
  const holdMs = Math.max(Number(onMs) || 160, GOVEE_MIN_HOLD_MS);
  const runOff = () => {
    if (typeof shouldOff === "function" && !shouldOff()) return;
    flashOffAll(broadcasterUserId).catch((error) => {
      console.warn("[govee-lan] flash off:", error.message);
    });
  };
  scheduleOff(timerKey, holdMs, runOff);
}

async function flashBeatAll(broadcasterUserId, color, brightness, holdMs, shouldOff) {
  try {
    const result = await flashOnAll(broadcasterUserId, color, brightness);
    if (!result?.flashed) {
      return result;
    }
    scheduleFlashOffAll(broadcasterUserId, holdMs, shouldOff);
    return result;
  } catch (error) {
    console.warn("[govee-lan] flash beat all:", error.message);
    return { flashed: 0, error: error.message };
  }
}

async function setDeviceOff(target) {
  await goveeLan.turnOffReliable(target.ip);
}

async function applyFlash(broadcasterUserId, color = {}, holdMs = 160) {
  const targets = getSelectedDevices(broadcasterUserId);
  if (!targets.length) return { flashed: 0 };

  const brightness = color.accent ? 100 : 85;
  await flashOnAll(broadcasterUserId, color, brightness);

  scheduleFlashOffAll(broadcasterUserId, holdMs);

  return { flashed: targets.length };
}

async function allOff(broadcasterUserId) {
  await goveeLan.init().catch(() => {});
  const targets = getSelectedDevices(broadcasterUserId);
  await Promise.all(targets.map((target) => setDeviceOff(target).catch(() => {})));
  return { off: targets.length };
}

async function testDevices(broadcasterUserId, action = "pulse") {
  const targets = getSelectedDevices(broadcasterUserId);
  if (!targets.length) {
    throw new Error("Select at least one Govee device first");
  }

  await goveeLan.init();
  requireGoveeListener();

  if (action === "off") {
    await flashOffAll(broadcasterUserId, { reliable: true });
    const statuses = await Promise.all(
      targets.map(async (target) => {
        const status = await goveeLan.queryStatusWithRetry(target.ip, 3);
        return {
          ip: target.ip,
          status,
          confirmed: status ? !status.onOff : false,
        };
      })
    );
    const stillOn = statuses.filter((entry) => entry.status?.onOff).length;
    return { action: "off", count: targets.length, statuses, stillOn };
  }

  const rgb = hueToRgb(Math.floor(Math.random() * 65535), 254, 254);
  if (action === "on") {
    await flashOnAll(broadcasterUserId, rgb, 100);
    const statuses = await Promise.all(
      targets.map(async (target) => ({
        ip: target.ip,
        status: await goveeLan.queryStatusWithRetry(target.ip, 2),
        confirmed: true,
      }))
    );
    return { action: "on", count: targets.length, statuses };
  }

  await flashOnAll(broadcasterUserId, rgb, 100);
  await delay(500);
  await flashOffAll(broadcasterUserId, { reliable: true });
  const statuses = await Promise.all(
    targets.map(async (target) => ({
      ip: target.ip,
      status: await goveeLan.queryStatusWithRetry(target.ip, 2),
      confirmed: true,
    }))
  );
  return { action: "pulse", count: targets.length, statuses };
}

function clearDevices(broadcasterUserId) {
  goveeConfig.saveConfig(broadcasterUserId, {
    knownDevices: [],
    selectedDevices: [],
    lastScanError: null,
  });
}

module.exports = {
  isConnected,
  getPublicStatus,
  saveScanIps,
  discover,
  listDevices,
  saveSelection,
  getSelectedDevices,
  applyFlash,
  flashOnAll,
  flashOffAll,
  flashOnOne,
  flashOffOne,
  flashBeatOne,
  flashBeatAll,
  scheduleFlashOffAll,
  scheduleFlashOffOne,
  holdColorOne,
  paintRgbicHalves,
  usesStripParts,
  skuSupportsStripSplit: goveeRgbic.skuSupportsStripSplit,
  allOff,
  testDevices,
  clearDevices,
  hueToRgb,
};
