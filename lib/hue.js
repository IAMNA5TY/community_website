const hueConfig = require("./hue-config");
const https = require("https");

const DISCOVERY_URL = "https://discovery.meethue.com/";
const DEVICE_TYPE = "kick-stream#dashboard";
const REQUEST_TIMEOUT_MS = 10000;

const hueQueues = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableHueError(error) {
  const message = String(error?.message || error || "");
  return /fetch failed|aborted|econnreset|etimedout|socket|network/i.test(message);
}

function runHueQueued(broadcasterUserId, fn) {
  const id = String(broadcasterUserId);
  const tail = hueQueues.get(id) || Promise.resolve();
  const run = tail.then(() => fn());
  hueQueues.set(
    id,
    run.catch(() => {})
  );
  return run;
}

function isConnected(broadcasterUserId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  return Boolean(config?.bridgeIp && config?.username);
}

function getPublicStatus(broadcasterUserId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  if (!config?.bridgeIp || !config?.username) {
    return {
      connected: false,
      bridgeIp: config?.bridgeIp || null,
      bridgeName: null,
      selectedLightIds: [],
      selectedGroupId: null,
    };
  }

  return {
    connected: true,
    bridgeIp: config.bridgeIp,
    bridgeName: config.bridgeName || null,
    selectedLightIds: config.selectedLightIds || [],
    selectedGroupId: config.selectedGroupId || null,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseHuePayload(data) {
  if (!Array.isArray(data) || !data.length) {
    throw new Error("Unexpected Hue bridge response");
  }

  const first = data[0];
  if (first.error) {
    const code = first.error.type;
    const description = first.error.description || "Hue bridge error";
    if (code === 101) {
      throw new Error("Press the link button on your Hue Bridge, then try again");
    }
    throw new Error(description);
  }

  return first.success || first;
}

async function bridgeRequest(bridgeIp, username, method, path, body, attempt = 0) {
  const base = `http://${bridgeIp}/api`;
  const url = username ? `${base}/${username}${path}` : `${base}${path}`;
  const options = { method };
  if (body != null) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetchWithTimeout(url, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Hue bridge returned an invalid response");
    }

    if (!username && method === "POST" && path === "") {
      return parseHuePayload(Array.isArray(data) ? data : [data]);
    }

    if (Array.isArray(data)) {
      const first = data[0];
      if (first?.error) {
        const code = first.error.type;
        const description = first.error.description || "Hue bridge error";
        if (code === 101) {
          throw new Error("Press the link button on your Hue Bridge, then try again");
        }
        throw new Error(description);
      }
      return first?.success ?? data;
    }

    if (!response.ok) {
      throw new Error(`Hue bridge error (${response.status})`);
    }

    return data;
  } catch (error) {
    if (isRetriableHueError(error) && attempt < 2) {
      await sleep(90 * (attempt + 1));
      return bridgeRequest(bridgeIp, username, method, path, body, attempt + 1);
    }
    throw error;
  }
}

function bridgeV2Request(bridgeIp, username, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: bridgeIp,
        port: 443,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          "hue-application-key": username,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
          } catch {
            reject(new Error("Hue bridge returned an invalid v2 response"));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listEntertainmentConfigurations(broadcasterUserId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  if (!config?.bridgeIp || !config?.username) {
    throw new Error("Hue not connected");
  }

  const { data } = await bridgeV2Request(
    config.bridgeIp,
    config.username,
    "GET",
    "/clip/v2/resource/entertainment_configuration"
  );

  return (data?.data || []).map((entry) => ({
    id: entry.id,
    name: entry.metadata?.name || entry.name || "Entertainment",
    status: entry.status,
    groupIdV1: entry.id_v1?.replace("/groups/", "") || null,
  }));
}

async function stopEntertainmentConfiguration(broadcasterUserId, entertainmentId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  const { status, data } = await bridgeV2Request(
    config.bridgeIp,
    config.username,
    "PUT",
    `/clip/v2/resource/entertainment_configuration/${entertainmentId}`,
    { action: "stop" }
  );

  if (status && status >= 400) {
    const message = data?.errors?.[0]?.description || "Could not stop entertainment stream";
    throw new Error(message);
  }

  return data;
}

async function stopAllEntertainmentStreams(broadcasterUserId) {
  const configs = await listEntertainmentConfigurations(broadcasterUserId);
  const active = configs.filter((entry) => entry.status === "active");
  const stopped = [];

  for (const entry of active) {
    await stopEntertainmentConfiguration(broadcasterUserId, entry.id);
    stopped.push(entry.name);
  }

  return stopped;
}

function findRoomGroupForLights(groups, lightIds) {
  const wanted = new Set(lightIds.map(String));
  return (
    groups.find(
      (group) =>
        group.type === "Room" &&
        group.lightIds.length === wanted.size &&
        group.lightIds.every((id) => wanted.has(String(id)))
    ) || groups.find((group) => group.type === "Room" && group.lightIds.some((id) => wanted.has(String(id))))
  );
}

async function resetLights(broadcasterUserId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  if (!config?.bridgeIp || !config?.username) {
    throw new Error("Hue not connected");
  }

  const stoppedStreams = await stopAllEntertainmentStreams(broadcasterUserId);
  const devices = await listDevices(broadcasterUserId);
  const lightIds = (config.selectedLightIds?.length
    ? config.selectedLightIds
    : devices.lights.map((light) => light.id)
  ).map(String);

  const roomGroup = findRoomGroupForLights(devices.groups, lightIds);
  if (roomGroup) {
    await bridgeRequest(config.bridgeIp, config.username, "PUT", `/groups/${roomGroup.id}/action`, {
      on: false,
      transitiontime: 4,
    });
  }

  await Promise.all(
    lightIds.map((lightId) =>
      bridgeRequest(config.bridgeIp, config.username, "PUT", `/lights/${lightId}/state`, {
        on: false,
        bri: 1,
        transitiontime: 4,
      })
    )
  );

  return {
    stoppedStreams,
    roomGroup: roomGroup?.name || null,
    lightIds,
  };
}

async function probeBridgeIp(bridgeIp) {
  if (!bridgeIp) return null;
  try {
    const response = await fetchWithTimeout(`http://${bridgeIp}/api/config`);
    if (!response.ok) return null;
    const config = await response.json();
    if (!config?.bridgeid) return null;
    return {
      id: config.bridgeid,
      ip: bridgeIp,
      name: config.name || "Hue Bridge",
      source: "local",
    };
  } catch {
    return null;
  }
}

function localBridgeCandidates(broadcasterUserId) {
  const savedIp = hueConfig.getConfig(broadcasterUserId)?.bridgeIp;
  const envIp = String(process.env.HUE_BRIDGE_IP || "").trim();
  return [...new Set([envIp, savedIp, "192.168.1.177"].filter(Boolean))];
}

async function discoverBridges(broadcasterUserId = null) {
  const bridges = [];
  const seen = new Set();

  function addBridge(bridge) {
    if (!bridge?.ip || seen.has(bridge.ip)) return;
    seen.add(bridge.ip);
    bridges.push(bridge);
  }

  try {
    const response = await fetchWithTimeout(DISCOVERY_URL);
    if (response.ok) {
      const remote = await response.json();
      if (Array.isArray(remote)) {
        for (const bridge of remote) {
          addBridge({
            id: bridge.id || null,
            ip: bridge.internalipaddress,
            name: "Hue Bridge",
            source: "cloud",
          });
        }
      }
    }
  } catch {
    /* cloud discovery is optional */
  }

  for (const ip of localBridgeCandidates(broadcasterUserId)) {
    const bridge = await probeBridgeIp(ip);
    if (bridge) addBridge(bridge);
  }

  return bridges;
}

async function connectBridge(broadcasterUserId, bridgeIp) {
  if (!bridgeIp) {
    throw new Error("Bridge IP is required");
  }

  const deadline = Date.now() + 30000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await bridgeRequest(bridgeIp, null, "POST", "", {
        devicetype: DEVICE_TYPE,
        generateclientkey: true,
      });
      return await finishBridgeConnect(broadcasterUserId, bridgeIp, result);
    } catch (error) {
      lastError = error;
      if (!/link button/i.test(error.message)) {
        throw error;
      }
      await sleep(1500);
    }
  }

  throw lastError || new Error("Press the link button on your Hue Bridge, then try again");
}

async function finishBridgeConnect(broadcasterUserId, bridgeIp, result) {

  const username = result.username;
  if (!username) {
    throw new Error("Hue bridge did not return a username");
  }

  let bridgeName = null;
  try {
    const config = await bridgeRequest(bridgeIp, username, "GET", "/config");
    bridgeName = config?.name || null;
  } catch {
    /* optional */
  }

  return hueConfig.saveConfig(broadcasterUserId, {
    bridgeIp,
    username,
    bridgeName,
    selectedLightIds: hueConfig.getConfig(broadcasterUserId)?.selectedLightIds || [],
    selectedGroupId: hueConfig.getConfig(broadcasterUserId)?.selectedGroupId || null,
  });
}

function disconnectBridge(broadcasterUserId) {
  hueConfig.deleteConfig(broadcasterUserId);
}

function saveSelection(broadcasterUserId, { lightIds, groupId }) {
  const config = hueConfig.getConfig(broadcasterUserId);
  if (!config?.username) {
    throw new Error("Hue not connected");
  }

  const patch = {
    selectedLightIds: Array.isArray(lightIds) ? lightIds.map(String) : [],
  };

  if (groupId !== undefined) {
    patch.selectedGroupId = groupId ? String(groupId) : null;
  }

  return hueConfig.saveConfig(broadcasterUserId, patch);
}

async function listDevices(broadcasterUserId) {
  const config = hueConfig.getConfig(broadcasterUserId);
  if (!config?.bridgeIp || !config?.username) {
    throw new Error("Hue not connected");
  }

  const [lightsRaw, groupsRaw] = await Promise.all([
    bridgeRequest(config.bridgeIp, config.username, "GET", "/lights"),
    bridgeRequest(config.bridgeIp, config.username, "GET", "/groups"),
  ]);

  const lights = Object.entries(lightsRaw || {}).map(([id, light]) => ({
    id: String(id),
    name: light.name,
    on: Boolean(light.state?.on),
    reachable: Boolean(light.state?.reachable),
    brightness: light.state?.bri ?? null,
    type: light.type,
  }));

  const groups = Object.entries(groupsRaw || {})
    .filter(([id]) => id !== "0")
    .map(([id, group]) => ({
      id: String(id),
      name: group.name,
      type: group.type,
      lightIds: (group.lights || []).map(String),
    }));

  return {
    lights,
    groups,
    selectedLightIds: config.selectedLightIds || [],
    selectedGroupId: config.selectedGroupId || null,
  };
}

function resolveTargets(config, override = {}) {
  const groupId = override.groupId ?? config.selectedGroupId;
  const lightIds = override.lightIds ?? config.selectedLightIds ?? [];

  if (groupId) {
    return { type: "group", id: String(groupId) };
  }
  if (lightIds.length) {
    return { type: "lights", ids: lightIds.map(String) };
  }
  return null;
}

async function applyState(broadcasterUserId, state, override = {}) {
  return runHueQueued(broadcasterUserId, async () => {
    const config = hueConfig.getConfig(broadcasterUserId);
    if (!config?.bridgeIp || !config?.username) {
      throw new Error("Hue not connected");
    }

    const targets = resolveTargets(config, override);
    if (!targets) {
      throw new Error("Select at least one Hue light or group first");
    }

    if (targets.type === "group") {
      await bridgeRequest(
        config.bridgeIp,
        config.username,
        "PUT",
        `/groups/${targets.id}/action`,
        state
      );
      return { target: "group", id: targets.id };
    }

    for (const lightId of targets.ids) {
      await bridgeRequest(
        config.bridgeIp,
        config.username,
        "PUT",
        `/lights/${lightId}/state`,
        state
      );
    }
    return { target: "lights", ids: targets.ids };
  });
}

async function testLights(broadcasterUserId, action = "pulse") {
  if (action === "off") {
    await applyState(broadcasterUserId, { on: false });
    return { action: "off" };
  }

  if (action === "on") {
    await applyState(broadcasterUserId, { on: true, bri: 254 });
    return { action: "on" };
  }

  await applyState(broadcasterUserId, {
    on: true,
    bri: 254,
    hue: Math.floor(Math.random() * 65535),
    sat: 254,
    transitiontime: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  await applyState(broadcasterUserId, { bri: 120, transitiontime: 4 });
  return { action: "pulse" };
}

module.exports = {
  isConnected,
  getPublicStatus,
  discoverBridges,
  connectBridge,
  disconnectBridge,
  saveSelection,
  listDevices,
  testLights,
  applyState,
  resetLights,
  stopAllEntertainmentStreams,
};
