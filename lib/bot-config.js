const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "bot-config.json");

function defaultConfig() {
  return { commands: [], timers: [] };
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return defaultConfig();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      timers: Array.isArray(parsed.timers) ? parsed.timers : [],
    };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function getBotConfig(broadcasterUserId) {
  const config = readConfig();
  const id = String(broadcasterUserId);

  return {
    commands: config.commands.filter(
      (command) => command.broadcasterUserId === id
    ),
    timers: config.timers.filter((timer) => timer.broadcasterUserId === id),
  };
}

function addCommand(broadcasterUserId, { trigger, response, enabled = true }) {
  const config = readConfig();
  const normalizedTrigger = trigger.trim().toLowerCase();

  if (!normalizedTrigger.startsWith("!")) {
    throw new Error("Commands must start with !");
  }

  if (config.commands.some(
    (command) =>
      command.broadcasterUserId === String(broadcasterUserId) &&
      command.trigger === normalizedTrigger
  )) {
    throw new Error("That command already exists");
  }

  const command = {
    id: newId(),
    broadcasterUserId: String(broadcasterUserId),
    trigger: normalizedTrigger,
    response: response.trim(),
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
  };

  config.commands.push(command);
  writeConfig(config);
  return command;
}

function deleteCommand(broadcasterUserId, commandId) {
  const config = readConfig();
  const before = config.commands.length;
  config.commands = config.commands.filter(
    (command) =>
      !(
        command.id === commandId &&
        command.broadcasterUserId === String(broadcasterUserId)
      )
  );

  if (config.commands.length === before) {
    throw new Error("Command not found");
  }

  writeConfig(config);
}

function addTimer(
  broadcasterUserId,
  { message, intervalMinutes, enabled = true }
) {
  const config = readConfig();
  const minutes = Number(intervalMinutes);

  if (!message?.trim()) {
    throw new Error("Timer message is required");
  }

  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("Timer interval must be between 1 and 1440 minutes");
  }

  const timer = {
    id: newId(),
    broadcasterUserId: String(broadcasterUserId),
    message: message.trim(),
    intervalMinutes: minutes,
    enabled: Boolean(enabled),
    lastRunAt: null,
    createdAt: new Date().toISOString(),
  };

  config.timers.push(timer);
  writeConfig(config);
  return timer;
}

function deleteTimer(broadcasterUserId, timerId) {
  const config = readConfig();
  const before = config.timers.length;
  config.timers = config.timers.filter(
    (timer) =>
      !(
        timer.id === timerId &&
        timer.broadcasterUserId === String(broadcasterUserId)
      )
  );

  if (config.timers.length === before) {
    throw new Error("Timer not found");
  }

  writeConfig(config);
}

function toggleTimer(broadcasterUserId, timerId, enabled) {
  const config = readConfig();
  const timer = config.timers.find(
    (entry) =>
      entry.id === timerId &&
      entry.broadcasterUserId === String(broadcasterUserId)
  );

  if (!timer) {
    throw new Error("Timer not found");
  }

  timer.enabled = Boolean(enabled);
  writeConfig(config);
  return timer;
}

function markTimerRun(timerId) {
  const config = readConfig();
  const timer = config.timers.find((entry) => entry.id === timerId);
  if (!timer) return;

  timer.lastRunAt = new Date().toISOString();
  writeConfig(config);
}

function getAllEnabledTimers() {
  return readConfig().timers.filter((timer) => timer.enabled);
}

module.exports = {
  getBotConfig,
  addCommand,
  deleteCommand,
  addTimer,
  deleteTimer,
  toggleTimer,
  markTimerRun,
  getAllEnabledTimers,
};
