const dgram = require("dgram");
const os = require("os");

const MULTICAST_ADDR = "239.255.255.250";
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const CMD_PORT = 4003;
const COMMAND_GAP_MS = 80;
const IMMEDIATE_GAP_MS = 32;
const KEEPALIVE_MS = 40000;

let listenerSocket = null;
let initPromise = null;
let initError = null;
let keepaliveTimer = null;
const keepaliveIps = new Set();
const pendingByIp = new Map();
const tapHandlers = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessage(cmd, data) {
  return Buffer.from(JSON.stringify({ msg: { cmd, data } }));
}

function parseResponse(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    return parsed?.msg || null;
  } catch {
    return null;
  }
}

function pickLocalAddress(deviceIp) {
  const targetParts = String(deviceIp).split(".").map(Number);
  if (targetParts.length !== 4 || targetParts.some((part) => Number.isNaN(part))) return null;

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const localParts = entry.address.split(".").map(Number);
      if (localParts.length !== 4) continue;
      if (
        localParts[0] === targetParts[0] &&
        localParts[1] === targetParts[1] &&
        localParts[2] === targetParts[2]
      ) {
        return entry.address;
      }
    }
  }
  return null;
}

function getLocalInterfaces() {
  const interfaces = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const parts = entry.address.split(".").map(Number);
      if (parts.length !== 4) continue;
      interfaces.push({
        address: entry.address,
        broadcast: `${parts[0]}.${parts[1]}.${parts[2]}.255`,
      });
    }
  }
  return interfaces;
}

function buildScanTargets(scanIps = []) {
  const targets = [];
  const seen = new Set();

  const addTarget = (host, bindAddress = null) => {
    const key = `${bindAddress || "*"}:${host}`;
    if (!host || seen.has(key)) return;
    seen.add(key);
    targets.push({ host, bindAddress });
  };

  for (const ip of scanIps) {
    const trimmed = String(ip || "").trim();
    if (!trimmed) continue;
    addTarget(trimmed, pickLocalAddress(trimmed));
  }

  for (const iface of getLocalInterfaces()) {
    addTarget(iface.broadcast, iface.address);
    addTarget(MULTICAST_ADDR, iface.address);
  }

  if (!targets.length) {
    addTarget(MULTICAST_ADDR, null);
  }

  return targets;
}

function handleIncoming(buffer, rinfo) {
  const msg = parseResponse(buffer);
  if (!msg?.cmd) return;

  for (const tap of tapHandlers) {
    try {
      tap(msg, rinfo);
    } catch {
      /* ignore */
    }
  }

  const waiters = pendingByIp.get(rinfo.address);
  if (!waiters?.length) return;

  for (let i = 0; i < waiters.length; i += 1) {
    const waiter = waiters[i];
    if (waiter.cmd && waiter.cmd !== msg.cmd) continue;
    waiters.splice(i, 1);
    if (!waiters.length) pendingByIp.delete(rinfo.address);
    waiter.resolve(msg.data ?? null);
    return;
  }
}

function waitForResponse(deviceIp, cmd, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const waiter = { cmd, resolve };
    const existing = pendingByIp.get(deviceIp) || [];
    existing.push(waiter);
    pendingByIp.set(deviceIp, existing);

    setTimeout(() => {
      const waiters = pendingByIp.get(deviceIp);
      if (!waiters) return;
      const index = waiters.indexOf(waiter);
      if (index === -1) return;
      waiters.splice(index, 1);
      if (!waiters.length) pendingByIp.delete(deviceIp);
      resolve(null);
    }, timeoutMs);
  });
}

function bindExclusive(socket, port) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
}

function createSender(localAddress) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4" });
    socket.once("error", reject);
    const onBound = () => {
      socket.removeListener("error", reject);
      resolve(socket);
    };
    if (localAddress) {
      socket.bind(0, localAddress, onBound);
    } else {
      socket.bind(0, onBound);
    }
  });
}

function sendOnSocket(socket, targetPort, targetHost, payload) {
  return new Promise((resolve, reject) => {
    socket.send(payload, targetPort, targetHost, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sendFromEphemeral(deviceIp, targetPort, targetHost, cmd, data) {
  const localAddress =
    deviceIp && deviceIp !== "0.0.0.0" ? pickLocalAddress(deviceIp) : pickLocalAddress(targetHost);
  const socket = await createSender(localAddress);
  try {
    if (targetHost.endsWith(".255") || targetHost === MULTICAST_ADDR) {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
    }
    await sendOnSocket(socket, targetPort, targetHost, buildMessage(cmd, data));
  } finally {
    socket.close();
  }
}

async function sendScanProbe(targetHost, bindAddress = null) {
  const socket = await createSender(bindAddress);
  try {
    if (targetHost.endsWith(".255") || targetHost === MULTICAST_ADDR) {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
    }
    await sendOnSocket(socket, SCAN_PORT, targetHost, buildMessage("scan", { account_topic: "reserve" }));
    return true;
  } catch (error) {
    if (
      error.code === "EACCES" ||
      error.code === "ENETUNREACH" ||
      error.code === "EHOSTUNREACH" ||
      error.code === "EINVAL"
    ) {
      return false;
    }
    throw error;
  } finally {
    socket.close();
  }
}

async function ensureListener() {
  if (listenerSocket) return listenerSocket;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const listener = dgram.createSocket({ type: "udp4" });

    listener.on("message", handleIncoming);
    listener.on("error", (error) => {
      if (error.code !== "EADDRINUSE") return;
      listenerSocket = null;
      initPromise = null;
      initError = new Error(
        "UDP port 4002 is already in use on this PC. Close GoveeLAN / govee2mqtt, restart this server, then try again."
      );
    });

    try {
      await bindExclusive(listener, LISTEN_PORT);
      try {
        listener.setBroadcast(true);
      } catch {
        /* ignore */
      }
      listenerSocket = listener;
      initError = null;
      return listener;
    } catch (error) {
      listener.close();
      listenerSocket = null;
      initPromise = null;
      if (error.code === "EADDRINUSE") {
        initError = new Error(
          "UDP port 4002 is already in use on this PC. Close GoveeLAN / govee2mqtt, restart this server, then try again."
        );
        throw initError;
      }
      throw error;
    }
  })().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
}

async function init() {
  await ensureListener();
  return getListenerStatus();
}

async function sendPacket(deviceIp, targetPort, targetHost, cmd, data) {
  try {
    await ensureListener();
  } catch (error) {
    if (error.code !== "EADDRINUSE" && !String(error.message || "").includes("4002")) {
      throw error;
    }
  }
  await sendFromEphemeral(deviceIp, targetPort, targetHost, cmd, data);
}

async function wakeDevice(deviceIp) {
  let listenerReady = false;
  try {
    await ensureListener();
    listenerReady = true;
  } catch {
    listenerReady = false;
  }

  if (listenerReady) {
    const responsePromise = waitForResponse(deviceIp, "scan", 1500);
    await sendFromEphemeral(deviceIp, SCAN_PORT, deviceIp, "scan", { account_topic: "reserve" });
    const response = await responsePromise;
    await delay(100);
    return Boolean(response);
  }

  await sendFromEphemeral(deviceIp, SCAN_PORT, deviceIp, "scan", { account_topic: "reserve" });
  await delay(120);
  return true;
}

async function sendCommand(deviceIp, cmd, data) {
  await sendPacket(deviceIp, CMD_PORT, deviceIp, cmd, data);
  await delay(COMMAND_GAP_MS);
}

async function sendCommandImmediate(deviceIp, cmd, data) {
  await sendPacket(deviceIp, CMD_PORT, deviceIp, cmd, data);
}

async function queryStatus(deviceIp, timeoutMs = 1000) {
  const responsePromise = waitForResponse(deviceIp, "devStatus", timeoutMs);
  await sendPacket(deviceIp, CMD_PORT, deviceIp, "devStatus", {});
  return responsePromise;
}

async function queryStatusWithRetry(deviceIp, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    await wakeDevice(deviceIp);
    const status = await queryStatus(deviceIp, 900);
    if (status) return status;
    await delay(180);
  }
  return null;
}

function discoverDevices(options = {}) {
  const scanIps = options.scanIps || [];
  const timeoutMs = Number(options.timeoutMs) || 3500;
  const devices = new Map();

  return new Promise(async (resolve, reject) => {
    try {
      await ensureListener();
    } catch (error) {
      reject(error);
      return;
    }

    const onTap = (msg, rinfo) => {
      if (msg.cmd !== "scan") return;
      const data = msg.data || {};
      const sku = data.sku;
      const device = data.device;
      if (!sku || !device) return;
      const key = `${sku}:${device}`;
      devices.set(key, {
        key,
        sku,
        device,
        ip: rinfo.address,
        name: data.deviceName || sku,
      });
    };

    tapHandlers.add(onTap);
    const timer = setTimeout(() => {
      tapHandlers.delete(onTap);
      resolve([...devices.values()]);
    }, timeoutMs);

    try {
      const targets = buildScanTargets(scanIps);
      let probesSent = 0;
      for (const target of targets) {
        const sent = await sendScanProbe(target.host, target.bindAddress);
        if (sent) probesSent += 1;
      }
      if (!probesSent && scanIps.length) {
        for (const ip of scanIps) {
          const trimmed = String(ip || "").trim();
          if (!trimmed) continue;
          await sendPacket(trimmed, SCAN_PORT, trimmed, "scan", { account_topic: "reserve" });
          probesSent += 1;
        }
      }
    } catch (error) {
      clearTimeout(timer);
      tapHandlers.delete(onTap);
      reject(error);
    }
  });
}

async function turn(deviceIp, on) {
  const value = on ? 1 : 0;
  let woke = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    woke = (await wakeDevice(deviceIp)) || woke;
    await sendCommand(deviceIp, "turn", { value });
    await delay(120);
  }
  return woke;
}

async function turnFast(deviceIp, on) {
  await sendCommandImmediate(deviceIp, "turn", { value: on ? 1 : 0 });
}

async function turnOffBurst(deviceIp, repeats = 3) {
  await sendCommand(deviceIp, "colorwc", {
    color: { r: 0, g: 0, b: 0 },
    colorTemInKelvin: 0,
  });
  for (let i = 0; i < repeats; i += 1) {
    await sendCommand(deviceIp, "turn", { value: 0 });
  }
}

async function turnOffReliable(deviceIp) {
  await wakeDevice(deviceIp);
  await delay(80);
  await turnOffBurst(deviceIp, 3);
}

async function setBrightness(deviceIp, value) {
  await sendCommand(deviceIp, "brightness", {
    value: Math.max(1, Math.min(100, Math.round(value))),
  });
}

async function setColorRgb(deviceIp, r, g, b) {
  await sendCommand(deviceIp, "colorwc", {
    color: {
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
    },
    colorTemInKelvin: 0,
  });
}

async function sendPtReal(deviceIp, commandPackets = []) {
  const commands = (commandPackets || []).filter(Boolean);
  if (!commands.length) return;
  await sendPacket(deviceIp, CMD_PORT, deviceIp, "ptReal", { command: commands });
  await delay(COMMAND_GAP_MS);
}

function setKeepaliveTargets(ips = []) {
  keepaliveIps.clear();
  for (const ip of ips) {
    if (ip) keepaliveIps.add(ip);
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (!keepaliveIps.size) return;

  keepaliveTimer = setInterval(() => {
    for (const ip of keepaliveIps) {
      wakeDevice(ip).catch(() => {});
    }
  }, KEEPALIVE_MS);
}

function getListenerStatus() {
  return {
    listening: Boolean(listenerSocket),
    port: LISTEN_PORT,
    keepaliveTargets: [...keepaliveIps],
    initError: initError?.message || null,
  };
}

function closeSharedSocket() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  keepaliveIps.clear();
  pendingByIp.clear();
  tapHandlers.clear();

  if (listenerSocket) {
    try {
      listenerSocket.close();
    } catch {
      /* ignore */
    }
  }
  listenerSocket = null;
  initPromise = null;
  initError = null;
}

module.exports = {
  init,
  discoverDevices,
  sendCommand,
  sendCommandImmediate,
  wakeDevice,
  queryStatus,
  queryStatusWithRetry,
  turn,
  turnFast,
  turnOffBurst,
  turnOffReliable,
  setBrightness,
  setColorRgb,
  sendPtReal,
  setKeepaliveTargets,
  getListenerStatus,
  closeSharedSocket,
  MULTICAST_ADDR,
  SCAN_PORT,
  LISTEN_PORT,
  CMD_PORT,
};
