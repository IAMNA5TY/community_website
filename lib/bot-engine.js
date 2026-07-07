const tokenStore = require("./token-store");
const botConfig = require("./bot-config");
const kickApi = require("./kick");
const workoutState = require("./workout-state");
const slotsState = require("./slots-state");
const slotsEvents = require("./slots-events");
const slotsProfiles = require("./slots-profiles");
const slotsTimerState = require("./slots-timer-state");
const slotsTimerEvents = require("./slots-timer-events");
const drinkingState = require("./drinking-state");
const drinkingEvents = require("./drinking-events");
const spotify = require("./spotify");
const spotifyState = require("./spotify-state");
const spotifyHueSync = require("./spotify-hue-sync");
const activeTimerHandles = new Map();

function isModerator(payload, broadcasterUserId) {
  const sender = payload.sender || {};
  const userId = sender.user_id || sender.userId || payload.user_id || payload.userId;
  const isBroadcaster = Boolean(
    sender.is_broadcaster ||
      sender.isBroadcaster ||
      payload.is_broadcaster ||
      payload.isBroadcaster ||
      (userId && broadcasterUserId && String(userId) === String(broadcasterUserId))
  );
  if (isBroadcaster) {
    return true;
  }
  return Boolean(
    sender.is_moderator ||
      sender.isModerator ||
      payload.is_moderator ||
      payload.isModerator ||
      sender.identity?.badges?.some?.((badge) =>
        ["moderator", "broadcaster"].includes(
          String(badge.type || badge.name || "").toLowerCase()
        )
      )
  );
}

function renderTemplate(template, context) {
  return template
    .replaceAll("{username}", context.username || "viewer")
    .replaceAll("{user}", context.username || "viewer")
    .replaceAll("{channel}", context.channel || "channel");
}

async function getValidToken(broadcasterUserId, kickConfig) {
  const stored = tokenStore.getBroadcasterToken(broadcasterUserId);
  if (!stored?.accessToken) {
    return null;
  }

  const expiresSoon =
    stored.expiresAt && stored.expiresAt - Date.now() < 2 * 60 * 1000;

  if (!expiresSoon || !stored.refreshToken) {
    return stored.accessToken;
  }

  const tokens = await kickApi.refreshTokens(kickConfig, stored.refreshToken);
  tokenStore.updateBroadcasterToken(broadcasterUserId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || stored.refreshToken,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : stored.expiresAt,
  });

  return tokens.access_token;
}

async function sendChatMessage(broadcasterUserId, content, kickConfig) {
  const accessToken = await getValidToken(broadcasterUserId, kickConfig);
  if (!accessToken) {
    throw new Error("No stored Kick token for this channel");
  }

  await kickApi.sendChatMessage(accessToken, {
    broadcasterUserId: Number(broadcasterUserId),
    content: content.slice(0, 500),
    type: "user",
  });
}

async function handleWalkCommand(broadcasterUserId, content, payload, kickConfig) {
  const parsed = workoutState.parseWalkCommand(content);
  if (!parsed) {
    return null;
  }

  if (parsed.action === "show") {
    const state = workoutState.load();
    const response = workoutState.formatWalkMessage(state);
    await sendChatMessage(broadcasterUserId, response, kickConfig);
    return { trigger: "!walk", response };
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Only mods can adjust the walk timer.",
      kickConfig
    );
    return { trigger: "!walk", denied: true };
  }

  let state;
  if (parsed.action === "set") {
    state = workoutState.setMinutes(parsed.minutes);
  } else {
    state = workoutState.adjustMinutes(parsed.delta);
  }

  const response = workoutState.formatWalkMessage(state);
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "!walk", response, minutes: state.minutesBank };
}

async function handleModCommand(broadcasterUserId, content, payload, kickConfig) {
  const parsed = workoutState.parseModCommand(content);
  if (!parsed) {
    return null;
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Only mods can control the treadmill.",
      kickConfig
    );
    return { trigger: content, denied: true };
  }

  if (parsed.action === "start") {
    const result = workoutState.startTreadmill();
    if (result.error) {
      await sendChatMessage(
        broadcasterUserId,
        "No minutes banked! Use !walk + or add a sub first.",
        kickConfig
      );
      return { trigger: "!start", error: result.error };
    }
    await sendChatMessage(broadcasterUserId, "Treadmill started!", kickConfig);
    return { trigger: "!start" };
  }

  if (parsed.action === "stop") {
    workoutState.stopTreadmill();
    await sendChatMessage(broadcasterUserId, "Treadmill paused.", kickConfig);
    return { trigger: "!stop" };
  }

  if (parsed.action === "reset") {
    workoutState.resetSession();
    await sendChatMessage(broadcasterUserId, "Workout session reset.", kickConfig);
    return { trigger: "!reset" };
  }

  return null;
}

async function handleSlotRequest(broadcasterUserId, content, payload, kickConfig) {
  const parsed = slotsState.parseSlotRequest(content);
  if (!parsed) {
    return null;
  }

  const username = payload.sender?.username || payload.username || "viewer";
  const senderMeta = slotsProfiles.extractSenderMeta(payload.sender || {});
  slotsProfiles.rememberProfile({ ...senderMeta, username });
  const result = slotsState.addRequest(username, parsed.slotName, senderMeta);

  if (result.error) {
    await sendChatMessage(broadcasterUserId, result.error, kickConfig);
    return { trigger: "!sr", error: result.error };
  }

  const response = result.updated
    ? `${username} updated their slot to ${result.request.slotName} — ${result.state.requests.length} in queue`
    : `${username} requested ${result.request.slotName} — ${result.state.requests.length} in queue`;
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "!sr", response, request: result.request };
}

async function handleSlotsPick(broadcasterUserId, content, payload, kickConfig) {
  const parsed = slotsState.parseSlotsPick(content);
  if (!parsed) {
    return null;
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Only mods can run !slots.",
      kickConfig
    );
    return { trigger: "!slots", denied: true };
  }

  const result = slotsState.pickRandom();
  if (result.error) {
    await sendChatMessage(broadcasterUserId, result.error, kickConfig);
    return { trigger: "!slots", error: result.error };
  }

  await slotsProfiles.enrichSlotsPick(result.state, kickConfig, broadcasterUserId);

  slotsEvents.broadcastPick(result.state);

  const { pick } = result;
  const response = `Playing ${pick.slotName} — requested by ${pick.username}`;
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "!slots", response, pick };
}

async function handleSlotTimerStart(broadcasterUserId, content, payload, kickConfig) {
  const parsed = slotsTimerState.parseSlotStartCommand(content);
  if (!parsed) {
    return null;
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Only mods can start the slots timer.",
      kickConfig
    );
    return { trigger: "!slotstart", denied: true };
  }

  const result = slotsTimerState.startHourSession();
  if (result.error) {
    await sendChatMessage(broadcasterUserId, result.error, kickConfig);
    return { trigger: "!slotstart", error: result.error };
  }

  slotsTimerState.save(result.state);
  slotsTimerEvents.broadcastTimer(result.state);
  const remaining = slotsTimerState.formatTimerMessage(result.state);
  const response = `Slots timer started — ${remaining} remaining`;
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "!slotstart", response, slotsTimer: result.state };
}

async function handleCheersCommand(broadcasterUserId, content, payload, kickConfig) {
  const parsed = drinkingState.parseCheersCommand(content);
  if (!parsed) {
    return null;
  }

  const username = payload.sender?.username || payload.username || "viewer";
  const result = drinkingState.applyAction({ action: "cheer", by: username });
  if (result.error) {
    await sendChatMessage(broadcasterUserId, result.error, kickConfig);
    return { trigger: "!cheers", error: result.error };
  }

  drinkingEvents.broadcastCheers(result.state);
  const response = `🍻 ${username} is cheersing with you`;
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "cheers", response, drinking: result.state };
}

async function handleShotgunCommand(broadcasterUserId, content, payload, kickConfig) {
  const parsed = drinkingState.parseShotgunCommand(content);
  if (!parsed) {
    return null;
  }

  const username = payload.sender?.username || payload.username || "mod";

  if (parsed.action === "show") {
    const state = drinkingState.load();
    const response = drinkingState.formatBeerMessage(state);
    await sendChatMessage(broadcasterUserId, response, kickConfig);
    return { trigger: "!beers", response };
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Use cheers or !cheers to hype it up!",
      kickConfig
    );
    return { trigger: content.split(/\s+/)[0], denied: true };
  }

  if (parsed.action === "reset") {
    const state = drinkingState.save(drinkingState.resetSession());
    const response = "Shotgun session reset — counter back to zero.";
    await sendChatMessage(broadcasterUserId, response, kickConfig);
    return { trigger: "!beer reset", response, drinking: state };
  }

  if (parsed.action === "remove") {
    const result = drinkingState.applyAction({
      action: "remove",
      count: parsed.count || 1,
    });
    if (result.error) {
      await sendChatMessage(broadcasterUserId, result.error, kickConfig);
      return { trigger: "!shotgun -1", error: result.error };
    }
    drinkingEvents.broadcastShotgun(result.state);
    const response = `Removed ${parsed.count || 1} — ${drinkingState.formatBeerMessage(result.state)}`;
    await sendChatMessage(broadcasterUserId, response, kickConfig);
    return { trigger: "!shotgun -1", response, drinking: result.state };
  }

  const result = drinkingState.applyAction({
    action: "add",
    count: parsed.count || 1,
    by: username,
  });
  if (result.error) {
    await sendChatMessage(broadcasterUserId, result.error, kickConfig);
    return { trigger: "!shotgun", error: result.error };
  }

  drinkingEvents.broadcastShotgun(result.state);
  const response = `SHOTGUN! ${drinkingState.formatBeerMessage(result.state)}`;
  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger: "!shotgun", response, drinking: result.state };
}

function spotifyChatError(error) {
  const message = String(error?.message || error || "");
  if (
    /unexpected response/i.test(message) ||
    /JSON/i.test(message)
  ) {
    return null;
  }
  return message;
}

function spotifySkipMessage(state) {
  const track = state?.track;
  if (!track?.name) {
    return "Skipped.";
  }
  const artists = track.artists ? ` — ${track.artists}` : "";
  return `Skipped — now playing: ${track.name}${artists}`;
}

function trackKey(track) {
  if (!track) return null;
  return track.id || `${track.name}|${track.artists || ""}`;
}

async function spotifyPlaybackAfterSkip(broadcasterUserId, previousTrack) {
  const previousKey = trackKey(previousTrack);
  const delays = [900, 700, 700, 800, 900];
  let state = null;

  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    state = await spotifyState
      .refreshPlayback(broadcasterUserId, { force: true })
      .catch(() => null);

    const nextKey = trackKey(state?.track);
    if (!previousKey) {
      if (nextKey) return state;
      continue;
    }
    if (nextKey !== previousKey) {
      return state;
    }
  }

  return state;
}

async function handleSpotifyCommand(broadcasterUserId, content, payload, kickConfig) {
  if (!spotify.isConfigured() || !spotify.getToken(broadcasterUserId)) {
    return null;
  }

  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const username = payload.sender?.username || payload.username || "viewer";

  const requestMatch = trimmed.match(/^!request\s+(.+)$/i);
  if (requestMatch) {
    const query = requestMatch[1].trim();
    if (!query) {
      await sendChatMessage(
        broadcasterUserId,
        "Usage: !request song name",
        kickConfig
      );
      return { trigger: "!request" };
    }

    if (!spotifyState.canRequest(broadcasterUserId, username)) {
      const wait = spotifyState.cooldownSecondsLeft(broadcasterUserId, username);
      await sendChatMessage(
        broadcasterUserId,
        `Song request cooldown — wait ${wait}s`,
        kickConfig
      );
      return { trigger: "!request", denied: true };
    }

    try {
      const track = await spotify.searchTrack(broadcasterUserId, query);
      if (!track) {
        await sendChatMessage(
          broadcasterUserId,
          `No match for "${query.slice(0, 80)}"`,
          kickConfig
        );
        return { trigger: "!request", error: "not_found" };
      }

      await spotify.addToQueue(broadcasterUserId, track.uri);
      spotifyState.markRequest(broadcasterUserId, username);
      const artists = (track.artists || []).map((artist) => artist.name).join(", ");
      spotifyState.noteQueuedRequest(broadcasterUserId, {
        username,
        trackName: track.name,
        artists,
      });
      await spotifyState.refreshPlayback(broadcasterUserId, { force: true }).catch(() => null);
      await sendChatMessage(
        broadcasterUserId,
        `Queued: ${track.name} — ${artists} (by ${username})`,
        kickConfig
      );
      return { trigger: "!request", track: track.name };
    } catch (error) {
      const message = spotifyChatError(error);
      if (message) {
        await sendChatMessage(broadcasterUserId, `Spotify: ${message}`, kickConfig);
      }
      return { trigger: "!request", error: error.message };
    }
  }

  if (lower === "!skip" || lower === "!next") {
    if (!isModerator(payload, broadcasterUserId)) {
      await sendChatMessage(broadcasterUserId, "Only mods can skip.", kickConfig);
      return { trigger: "!skip", denied: true };
    }

    try {
      const before = await spotifyState
        .loadForBroadcaster(broadcasterUserId)
        .catch(() => null);
      await spotify.skipTrack(broadcasterUserId);
      const state = await spotifyPlaybackAfterSkip(
        broadcasterUserId,
        before?.track || null
      );
      await sendChatMessage(
        broadcasterUserId,
        spotifySkipMessage(state),
        kickConfig
      );
      return { trigger: "!skip", track: state?.track?.name || null };
    } catch (error) {
      const message = spotifyChatError(error);
      if (message) {
        await sendChatMessage(broadcasterUserId, `Spotify: ${message}`, kickConfig);
      }
      return { trigger: "!skip", error: error.message };
    }
  }

  if (lower === "!pause") {
    if (!isModerator(payload, broadcasterUserId)) {
      await sendChatMessage(broadcasterUserId, "Only mods can pause.", kickConfig);
      return { trigger: "!pause", denied: true };
    }

    try {
      const state = await spotifyState.loadForBroadcaster(broadcasterUserId);
      if (state.isPlaying) {
        await spotify.pausePlayback(broadcasterUserId);
        await sendChatMessage(broadcasterUserId, "Paused.", kickConfig);
      } else {
        await spotify.resumePlayback(broadcasterUserId);
        await sendChatMessage(broadcasterUserId, "Playing.", kickConfig);
      }
      await spotifyState.refreshPlayback(broadcasterUserId, { force: true }).catch(() => null);
      return { trigger: "!pause" };
    } catch (error) {
      const message = spotifyChatError(error);
      if (message) {
        await sendChatMessage(broadcasterUserId, `Spotify: ${message}`, kickConfig);
      }
      return { trigger: "!pause", error: error.message };
    }
  }

  if (lower === "!replaysong" || lower === "/replaysong") {
    if (!isModerator(payload, broadcasterUserId)) {
      await sendChatMessage(broadcasterUserId, "Only mods can replay the song.", kickConfig);
      return { trigger: "!replaysong", denied: true };
    }

    try {
      const before = await spotifyState.loadForBroadcaster(broadcasterUserId);
      if (!before?.track) {
        await sendChatMessage(broadcasterUserId, "Nothing playing to replay.", kickConfig);
        return { trigger: "!replaysong", error: "no_track" };
      }

      await spotify.replayTrack(broadcasterUserId);
      spotifyHueSync.resetSession(broadcasterUserId);
      const state = await spotifyState.refreshPlayback(broadcasterUserId, { force: true });
      const trackName = state?.track?.name || before.track.name;
      await sendChatMessage(
        broadcasterUserId,
        `Replaying from the start: ${trackName}`,
        kickConfig
      );
      return { trigger: "!replaysong", track: trackName };
    } catch (error) {
      const message = spotifyChatError(error);
      if (message) {
        await sendChatMessage(broadcasterUserId, `Spotify: ${message}`, kickConfig);
      }
      return { trigger: "!replaysong", error: error.message };
    }
  }

  const volMatch = trimmed.match(/^!vol\s+(\d{1,3})$/i);
  if (volMatch) {
    if (!isModerator(payload, broadcasterUserId)) {
      await sendChatMessage(broadcasterUserId, "Only mods can change volume.", kickConfig);
      return { trigger: "!vol", denied: true };
    }

    const volume = Number(volMatch[1]);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      await sendChatMessage(
        broadcasterUserId,
        "Usage: !vol 0-100",
        kickConfig
      );
      return { trigger: "!vol" };
    }

    try {
      const applied = await spotify.setVolume(broadcasterUserId, volume);
      await spotifyState.refreshPlayback(broadcasterUserId, { force: true }).catch(() => null);
      await sendChatMessage(
        broadcasterUserId,
        `Volume set to ${applied}%.`,
        kickConfig
      );
      return { trigger: "!vol", volume: applied };
    } catch (error) {
      const message = spotifyChatError(error);
      if (message) {
        await sendChatMessage(broadcasterUserId, `Spotify: ${message}`, kickConfig);
      }
      return { trigger: "!vol", error: error.message };
    }
  }

  return null;
}

async function handleLightingCommand(broadcasterUserId, content, payload, kickConfig) {
  const trigger = content.trim().toLowerCase().split(/\s+/)[0].replace(/^\//, "!");
  if (trigger !== "!lightsoff" && trigger !== "!lightson") {
    return null;
  }

  if (!isModerator(payload, broadcasterUserId)) {
    await sendChatMessage(
      broadcasterUserId,
      "Only mods can control stream lights.",
      kickConfig
    );
    return { trigger, denied: true };
  }

  try {
    if (trigger === "!lightsoff") {
      console.log("[bot] !lightsoff from", payload.sender?.username || payload.username || "?");
      await spotifyHueSync.setChatLightsOff(broadcasterUserId);
      await sendChatMessage(
        broadcasterUserId,
        "Lights off — beat sync paused. Use !lightson when ready.",
        kickConfig
      );
      return { trigger: "!lightsoff", lightsMuted: true };
    }

    await spotifyHueSync.setChatLightsOn(broadcasterUserId);
    await sendChatMessage(
      broadcasterUserId,
      "Lights on — beat sync resumed.",
      kickConfig
    );
    return { trigger: "!lightson", lightsMuted: false };
  } catch (error) {
    await sendChatMessage(
      broadcasterUserId,
      `Lights: ${error.message}`,
      kickConfig
    );
    return { trigger, error: error.message };
  }
}

async function handleChatMessage(broadcasterUserId, payload, kickConfig) {
  const content = (payload.content || "").trim();

  const cheersResult = await handleCheersCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (cheersResult) {
    return cheersResult;
  }

  if (!content.startsWith("!") && !content.startsWith("/")) {
    return null;
  }

  const slotRequest = await handleSlotRequest(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (slotRequest) {
    return slotRequest;
  }

  const slotsPick = await handleSlotsPick(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (slotsPick) {
    return slotsPick;
  }

  const slotTimerStart = await handleSlotTimerStart(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (slotTimerStart) {
    return slotTimerStart;
  }

  const shotgunResult = await handleShotgunCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (shotgunResult) {
    return shotgunResult;
  }

  const spotifyResult = await handleSpotifyCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (spotifyResult) {
    return spotifyResult;
  }

  const lightingResult = await handleLightingCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (lightingResult) {
    return lightingResult;
  }

  if (!content.startsWith("!")) {
    return null;
  }

  const walkResult = await handleWalkCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (walkResult) {
    return walkResult;
  }

  const modResult = await handleModCommand(
    broadcasterUserId,
    content,
    payload,
    kickConfig
  );
  if (modResult) {
    return modResult;
  }

  const trigger = content.split(/\s+/)[0].toLowerCase();
  const { commands } = botConfig.getBotConfig(broadcasterUserId);
  const command = commands.find(
    (entry) => entry.enabled && entry.trigger === trigger
  );

  if (!command) {
    return null;
  }

  const stored = tokenStore.getBroadcasterToken(broadcasterUserId);
  const response = renderTemplate(command.response, {
    username: payload.sender?.username || payload.username || "viewer",
    channel: stored?.username || "channel",
  });

  await sendChatMessage(broadcasterUserId, response, kickConfig);
  return { trigger, response };
}

function handleSubscriptionEvent(quantity = 1) {
  workoutState.addSub(quantity);
}

function stopTimer(timerId) {
  const handle = activeTimerHandles.get(timerId);
  if (handle) {
    clearInterval(handle);
    activeTimerHandles.delete(timerId);
  }
}

function startTimer(timer, kickConfig) {
  stopTimer(timer.id);

  if (!timer.enabled) {
    return;
  }

  const intervalMs = timer.intervalMinutes * 60 * 1000;
  const handle = setInterval(async () => {
    try {
      await sendChatMessage(timer.broadcasterUserId, timer.message, kickConfig);
      botConfig.markTimerRun(timer.id);
    } catch (error) {
      console.error(`Timer ${timer.id} failed:`, error.message);
    }
  }, intervalMs);

  activeTimerHandles.set(timer.id, handle);
}

function reloadTimers(kickConfig) {
  for (const timerId of activeTimerHandles.keys()) {
    stopTimer(timerId);
  }

  for (const timer of botConfig.getAllEnabledTimers()) {
    startTimer(timer, kickConfig);
  }
}

function refreshTimersForBroadcaster(broadcasterUserId, kickConfig) {
  const { timers } = botConfig.getBotConfig(broadcasterUserId);

  for (const timer of timers) {
    stopTimer(timer.id);
    if (timer.enabled) {
      startTimer(timer, kickConfig);
    }
  }
}

module.exports = {
  handleChatMessage,
  handleSubscriptionEvent,
  sendChatMessage,
  reloadTimers,
  refreshTimersForBroadcaster,
  stopTimer,
};
