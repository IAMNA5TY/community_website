const hue = require("./hue");
const govee = require("./govee");
const spotify = require("./spotify");
const spotifyState = require("./spotify-state");
const lightingSyncConfig = require("./lighting-sync-config");
const lightingCalibration = require("./lighting-calibration");
const lightingLayout = require("./lighting-layout");
const lightingChatMute = require("./lighting-chat-mute");
const systemAudio = require("./system-audio-capture");
const tokenStore = require("./token-store");

const TICK_MS = 40;
const PROGRESS_RESYNC_MS = 20000;
const AUDIO_PROGRESS_RESYNC_MS = 45000;
const BEAT_WINDOW_MS = 110;
const PAUSE_GRACE_MS = 45000;

const spotifyPollMeta = new Map();

const JULY_BEAT_COLORS = [
  { hue: 0, sat: 254 },
  { r: 255, g: 255, b: 255, sat: 0 },
  { hue: 46920, sat: 254 },
];

function isJulyBeatTheme() {
  return new Date().getMonth() === 6;
}

const sessions = new Map();
const runtime = {
  status: "idle",
  trackName: null,
  trackId: null,
  lastSyncAt: null,
  beatsInSong: 0,
  hits: 0,
  bpm: null,
  mode: null,
  profileSource: null,
  audio: null,
  error: null,
  spotifyPlaying: null,
};

let tickTimer = null;
let manualPauseUntil = 0;
let lastMutedOffAt = 0;
let lastConfirmedPlayingAt = Date.now();
let lastAudioSignalAt = 0;
let lastAudioRestartAt = 0;

function getPollIntervalMs(settings) {
  if (settings?.beatEnabled && settings?.audioSyncEnabled) {
    return AUDIO_PROGRESS_RESYNC_MS;
  }
  return PROGRESS_RESYNC_MS;
}

function getSpotifyPollMeta(broadcasterId) {
  const id = String(broadcasterId);
  if (!spotifyPollMeta.has(id)) {
    spotifyPollMeta.set(id, { lastPollAt: 0, backoffUntil: 0, lastRateLimitLogAt: 0 });
  }
  return spotifyPollMeta.get(id);
}

function canPollSpotify(broadcasterId, settings) {
  const meta = getSpotifyPollMeta(broadcasterId);
  const now = Date.now();
  if (meta.backoffUntil && now < meta.backoffUntil) {
    return false;
  }
  return now - meta.lastPollAt >= getPollIntervalMs(settings);
}

function markSpotifyPolled(broadcasterId) {
  const meta = getSpotifyPollMeta(broadcasterId);
  meta.lastPollAt = Date.now();
}

function markSpotifyRateLimited(broadcasterId, retryAfterMs = 60000) {
  const meta = getSpotifyPollMeta(broadcasterId);
  const waitMs = Math.max(30000, Number(retryAfterMs) || 60000);
  meta.backoffUntil = Date.now() + waitMs;
  meta.lastPollAt = Date.now();
}

function publicStateToPlayback(publicState) {
  if (!publicState) return null;
  return {
    connected: Boolean(publicState.connected),
    isPlaying: Boolean(publicState.isPlaying),
    track: publicState.track || null,
    progressMs: publicState.progressMs || 0,
    volume: publicState.volume ?? null,
    device: publicState.device || null,
    error: publicState.error || null,
  };
}

function isBelievedPlaying(playback, session) {
  if (playback?.isPlaying) {
    return true;
  }
  if (!session?.trackId) {
    return false;
  }
  const now = Date.now();
  if (now - lastConfirmedPlayingAt < PAUSE_GRACE_MS) {
    return true;
  }
  if (session.lastFlashAt && now - session.lastFlashAt < 90000) {
    return true;
  }
  if (session.lastResyncAt && now - session.lastResyncAt < PAUSE_GRACE_MS) {
    return true;
  }
  return false;
}

function buildFallbackPlayback(session, broadcasterId) {
  if (session?.trackId) {
    return {
      connected: true,
      isPlaying: true,
      track: { id: session.trackId, name: session.trackName },
      progressMs: estimateProgressMs(session),
    };
  }

  const cached = spotifyState.getCachedPlayback(broadcasterId);
  if (cached?.track?.id) {
    return {
      connected: Boolean(cached.connected),
      isPlaying: Boolean(cached.isPlaying),
      track: cached.track,
      progressMs: cached.progressMs || 0,
    };
  }

  return null;
}

function isChatLightsMuted(broadcasterUserId) {
  return lightingChatMute.isMuted(broadcasterUserId);
}

function isManuallyPaused() {
  return Date.now() < manualPauseUntil;
}

function pauseManualControl(durationMs = 120000) {
  manualPauseUntil = Date.now() + durationMs;
}

function getRuntimeStatus() {
  const broadcasterId = tokenStore.getPrimaryBroadcasterId();
  return {
    ...runtime,
    audio: systemAudio.getStatus(),
    lightsChatMuted: broadcasterId ? isChatLightsMuted(broadcasterId) : false,
  };
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildSongPalette(track, features = null) {
  const seed = hashString(`${track.id}:${track.album || track.name || ""}`);
  const energy = Number(features?.energy ?? 0.55 + (seed % 35) / 100);
  const valence = Number(features?.valence ?? 0.45 + (seed % 30) / 100);
  const baseHue = Math.round((valence * 0.55 + energy * 0.45) * 46920 + (seed % 14000)) % 65535;
  const baseSat = clamp(Math.round(175 + energy * 65), 140, 254);

  const offsets = [0, 3900, 7800, 11700, -3900, -7800];
  return offsets.map((offset, index) => ({
    hue: (baseHue + offset + 65535) % 65535,
    sat: clamp(baseSat - index * 5, 130, 254),
  }));
}

function estimateTempo(track, features, profile) {
  if (profile?.bpm) {
    return clamp(Number(profile.bpm) + Number(profile.bpmOffset || 0), 60, 200);
  }
  const tempo = Number(features?.tempo);
  let bpm;
  if (Number.isFinite(tempo) && tempo >= 60 && tempo <= 200) {
    bpm = Math.round(tempo);
  } else {
    const seed = hashString(track.id);
    bpm = 88 + (seed % 45);
  }
  return clamp(bpm + Number(profile?.bpmOffset || 0), 60, 200);
}

function beatIntervalMs(bpm) {
  return 60000 / clamp(Number(bpm) || 120, 60, 200);
}

function beatPhaseMs(progressMs, session, bpm) {
  const interval = beatIntervalMs(bpm);
  const offset = Number(session.beatStartMs) || 0;
  const phase = ((progressMs - offset) % interval + interval) % interval;
  return Math.min(phase, interval - phase);
}

function alignBeatIndex(session, progressMs, bpm) {
  const interval = beatIntervalMs(bpm);
  const offset = Number(session.beatStartMs) || 0;
  const elapsed = Math.max(0, progressMs - offset);
  session.beatIndex = Math.floor(elapsed / interval);
}

function snapPhaseToAudio(session, progressMs, bpm) {
  const interval = beatIntervalMs(bpm);
  const offset = Number(session.beatStartMs) || 0;
  const k = Math.round((progressMs - offset) / interval);
  session.beatStartMs = progressMs - k * interval;
  session.phaseLocked = true;
  alignBeatIndex(session, progressMs, bpm);
}

function updatePlaybackAnchor(session, progressMs) {
  session.playbackAnchor = {
    wallAt: Date.now(),
    progressMs: Number(progressMs || 0),
  };
}

function estimateProgressMs(session) {
  const anchor = session?.playbackAnchor;
  if (!anchor) return 0;
  return anchor.progressMs + Math.max(0, Date.now() - anchor.wallAt);
}

async function tryLoadAudioFeatures(broadcasterUserId, trackId) {
  try {
    return await spotify.getAudioFeatures(broadcasterUserId, trackId);
  } catch {
    return null;
  }
}

async function forceAllLightsOff(broadcasterUserId) {
  const id = String(broadcasterUserId);
  try {
    await hue.stopAllEntertainmentStreams(id);
  } catch {
    /* ignore */
  }
  try {
    await hue.applyState(id, { on: false, transitiontime: 0 });
  } catch (error) {
    console.warn("[spotify-hue] hue off:", error.message);
  }
  try {
    await govee.allOff(id);
  } catch (error) {
    console.warn("[spotify-hue] govee off:", error.message);
  }
}

async function lightsOff(broadcasterUserId) {
  await forceAllLightsOff(broadcasterUserId);
}

async function setChatLightsOff(broadcasterUserId) {
  const id = String(broadcasterUserId);
  lightingChatMute.mute(id);
  runtime.lightsChatMuted = true;
  systemAudio.stop();
  runtime.audio = systemAudio.getStatus();
  await forceAllLightsOff(id);
  setTimeout(() => forceAllLightsOff(id).catch(() => {}), 150);
  setTimeout(() => forceAllLightsOff(id).catch(() => {}), 400);
  console.log("[lighting] !lightsoff — lights muted for broadcaster", id);
  return { muted: true };
}

async function setChatLightsOn(broadcasterUserId) {
  const id = String(broadcasterUserId);
  lightingChatMute.unmute(id);
  runtime.lightsChatMuted = false;
  const settings = lightingSyncConfig.getSettings(id);
  if (settings.beatEnabled && settings.audioSyncEnabled) {
    await syncAudioCapture(id).catch(() => {});
    runtime.audio = systemAudio.getStatus();
  }
  console.log("[lighting] !lightson — lights unmuted for broadcaster", id);
  return { muted: false };
}

function flashTarget(broadcasterUserId) {
  const config = hue.getPublicStatus(broadcasterUserId);
  if (config.selectedLightIds?.length) {
    return { groupId: "", lightIds: config.selectedLightIds };
  }
  return {};
}

function isAudioDriving(settings) {
  const audio = systemAudio.getStatus();
  return (
    settings.beatEnabled &&
    settings.audioSyncEnabled &&
    audio.running &&
    audio.hasSignal
  );
}

function hasLightsForSync(broadcasterUserId) {
  const hueStatus = hue.getPublicStatus(broadcasterUserId);
  const hasHue =
    hue.isConnected(broadcasterUserId) &&
    (hueStatus.selectedGroupId || hueStatus.selectedLightIds?.length);
  const hasGovee = govee.getSelectedDevices(broadcasterUserId).length > 0;
  const hasLayout = lightingLayout.getLayout(broadcasterUserId).lights.length > 0;
  return hasHue || hasGovee || hasLayout;
}

function quickFlash(broadcasterUserId, session, options = {}) {
  if (isChatLightsMuted(broadcasterUserId)) {
    return false;
  }
  if (isManuallyPaused()) {
    return false;
  }
  if (runtime.spotifyPlaying === false && !session?.trackId) {
    return false;
  }
  const palette = session.palette || [];
  if (!palette.length) return false;

  const now = Date.now();
  const bpm = runtime.bpm || 136;
  const beatGap = beatIntervalMs(bpm);
  const audioDriven = Boolean(options.audioDriven);
  const minGap = audioDriven
    ? 72
    : session.mode === "wild"
      ? Math.max(280, beatGap * 0.62)
      : Math.max(320, beatGap * 0.85);
  if (now - (session.lastFlashAt || 0) < minGap) {
    return false;
  }
  session.lastFlashAt = now;

  let color;
  if (isJulyBeatTheme()) {
    color = JULY_BEAT_COLORS[session.colorIndex % JULY_BEAT_COLORS.length];
  } else {
    color = palette[session.colorIndex % palette.length];
  }
  session.colorIndex += 1;
  const accent = audioDriven ? session.colorIndex % 6 === 0 : session.colorIndex % 4 === 0;
  const isWhite = Number(color.sat) === 0;
  const target = flashTarget(broadcasterUserId);

  const onMs = audioDriven
    ? session.mode === "wild"
      ? 125
      : 105
    : session.mode === "wild"
      ? 160
      : 130;
  const flashColor = isWhite
    ? { sat: 0, bri: accent ? 254 : 228, r: 255, g: 255, b: 255, accent }
    : { hue: color.hue, sat: color.sat ?? 254, bri: accent ? 254 : 228, accent };
  const isJulyRed = isJulyBeatTheme() && color.hue === 0 && !isWhite;
  const goveeColor = isWhite
    ? { r: 255, g: 255, b: 255, sat: 0, bri: accent ? 254 : 228, accent }
    : isJulyRed
      ? { r: 110, g: 0, b: 0, bri: accent ? 200 : 165, accent }
      : { hue: color.hue, sat: 254, bri: accent ? 254 : 228, accent };
  const layout = lightingLayout.getLayout(broadcasterUserId);
  const flashEpoch = lightingChatMute.getFlashEpoch();

  if (layout.lights.length) {
    lightingLayout.applyBeatFlash(broadcasterUserId, session, {
      palette: session.palette,
      color: flashColor,
      goveeColor,
      accent,
      onMs,
    });

    if (accent && session.mode === "wild" && !audioDriven) {
      setTimeout(() => {
        if (!lightingChatMute.isFlashEpochCurrent(flashEpoch) || lightingChatMute.isMuted(broadcasterUserId)) {
          return;
        }
        lightingLayout.applyBeatFlash(broadcasterUserId, session, {
          palette: session.palette,
          color: { ...flashColor, bri: 254 },
          goveeColor: isJulyRed
            ? { r: 110, g: 0, b: 0, bri: 200, accent: true }
            : { ...goveeColor, bri: 254, accent: true },
          accent: true,
          onMs: 90,
        });
      }, onMs + 50);
    }

    return true;
  }

  hue
    .applyState(
      broadcasterUserId,
      {
        on: true,
        ...(isWhite
          ? { sat: 0, bri: accent ? 254 : 228 }
          : { hue: flashColor.hue, sat: 254, bri: accent ? 254 : 228 }),
        transitiontime: 0,
      },
      target
    )
    .catch((error) => {
      console.warn("[spotify-hue] flash on:", error.message);
    });

  govee.flashOnAll(broadcasterUserId, goveeColor).catch((error) => {
    console.warn("[govee-lan] flash on:", error.message);
  });

  setTimeout(() => {
    if (!lightingChatMute.isFlashEpochCurrent(flashEpoch) || lightingChatMute.isMuted(broadcasterUserId)) {
      return;
    }
    hue
      .applyState(broadcasterUserId, { on: false, transitiontime: 0 }, target)
      .catch((error) => {
        console.warn("[spotify-hue] flash off:", error.message);
      });
    govee.flashOffAll(broadcasterUserId).catch((error) => {
      console.warn("[govee-lan] flash off:", error.message);
    });
  }, onMs);

  if (accent && session.mode === "wild" && !audioDriven) {
    setTimeout(() => {
      if (!lightingChatMute.isFlashEpochCurrent(flashEpoch) || lightingChatMute.isMuted(broadcasterUserId)) {
        return;
      }
      hue
        .applyState(
          broadcasterUserId,
          {
            on: true,
            ...(isWhite ? { sat: 0, bri: 254 } : { hue: flashColor.hue, sat: 254, bri: 254 }),
            transitiontime: 0,
          },
          target
        )
        .catch(() => {});
      govee.flashOnAll(broadcasterUserId, { ...goveeColor, accent: true }).catch(() => {});
      setTimeout(() => {
        if (!lightingChatMute.isFlashEpochCurrent(flashEpoch) || lightingChatMute.isMuted(broadcasterUserId)) {
          return;
        }
        hue.applyState(broadcasterUserId, { on: false, transitiontime: 0 }, target).catch(() => {});
        govee.flashOffAll(broadcasterUserId).catch(() => {});
      }, 90);
    }, onMs + 50);
  }

  return true;
}

function triggerFlash(broadcasterUserId, session, options = {}) {
  if (quickFlash(broadcasterUserId, session, options)) {
    runtime.hits += 1;
  }
}

async function onTrackChange(broadcasterUserId, state, settings) {
  const track = state.track;
  const profile = lightingCalibration.resolveTrackProfileForUser(
    broadcasterUserId,
    track,
    settings
  );

  runtime.trackId = track.id;
  runtime.trackName = track.name;
  runtime.lastSyncAt = new Date().toISOString();
  runtime.error = null;
  runtime.status = "syncing";
  runtime.hits = 0;
  runtime.mode = profile.mode;
  runtime.profileSource = profile.source;

  const features = await tryLoadAudioFeatures(broadcasterUserId, track.id);
  const palette = buildSongPalette(track, features);
  const bpm = estimateTempo(track, features, profile);
  const beatStartMs =
    Number(profile.beatStartSec || 0) * 1000 + Number(settings.beatPhaseMs || 0);

  const session = {
    trackId: track.id,
    trackName: track.name,
    beatIndex: 0,
    audioBeatIndex: 0,
    beatStartMs,
    phaseLocked: beatStartMs !== 0,
    palette,
    colorIndex: 0,
    layoutBeatIndex: 0,
    lastFlashAt: 0,
    lastResyncAt: Date.now(),
    beatsPerFlash: Math.max(1, Number(profile.beatsPerFlash) || 1),
    mode: profile.mode || "drop",
    profileName: profile.name,
  };

  session.lastBpmWallAt = 0;
  session.bpmWallIndex = 0;
  updatePlaybackAnchor(session, state.progressMs || 0);
  alignBeatIndex(session, estimateProgressMs(session), bpm);

  runtime.beatsInSong = Math.ceil(
    Math.max(30, Number(track.durationMs || 0) / 1000 || 240) / (60 / bpm)
  );
  runtime.bpm = bpm;

  await lightsOff(broadcasterUserId);

  lastConfirmedPlayingAt = Date.now();
  sessions.set(String(broadcasterUserId), session);
  runtime.status = "playing";
}

function resyncSessionProgress(session, progressMs, bpm) {
  if (!session) return;
  const actual = Number(progressMs) || 0;
  const estimated = estimateProgressMs(session);
  updatePlaybackAnchor(session, actual);
  if (Math.abs(estimated - actual) > 300) {
    alignBeatIndex(session, actual, bpm || runtime.bpm || 120);
  }
}

function processBpmWallClock(broadcasterUserId, session, settings) {
  if (!settings.beatEnabled || !runtime.bpm) {
    return;
  }

  const interval = beatIntervalMs(runtime.bpm);
  const step = Math.max(1, Number(session.beatsPerFlash) || 1);
  const now = Date.now();
  const last = Number(session.lastBpmWallAt) || 0;
  if (now - last < interval * 0.82) {
    return;
  }

  session.lastBpmWallAt = now;
  session.bpmWallIndex = (Number(session.bpmWallIndex) || 0) + 1;
  if (session.bpmWallIndex % step !== 0) {
    return;
  }

  triggerFlash(broadcasterUserId, session, {});
}

function ensureBeatAlive(broadcasterUserId, session, settings) {
  if (!settings.beatEnabled || !runtime.bpm || !session?.trackId) {
    return;
  }
  const interval = beatIntervalMs(runtime.bpm);
  const since = Date.now() - (session.lastFlashAt || 0);
  if (since > interval * 2.2) {
    triggerFlash(broadcasterUserId, session, {});
  }
}

function shouldUseBpmWallClock(settings, audio) {
  return (
    settings.beatEnabled &&
    settings.audioSyncEnabled &&
    (!audio.running || !audio.hasSignal)
  );
}

function processBeats(broadcasterUserId, session, progressMs, settings) {
  if (!settings.beatEnabled) {
    return;
  }

  const bpm = runtime.bpm;
  if (!bpm) {
    return;
  }

  const interval = beatIntervalMs(bpm);
  const audio = systemAudio.getStatus();
  const audioPrimary =
    settings.audioSyncEnabled && audio.running && audio.hasSignal;

  // When audio is driving, only use BPM ticks to fill gaps audio missed.
  if (audioPrimary) {
    const sinceFlash = Date.now() - (session.lastFlashAt || 0);
    if (sinceFlash < interval * 0.4) {
      return;
    }
  }

  const offset = Number(session.beatStartMs) || 0;
  const step = Math.max(1, Number(session.beatsPerFlash) || 1);
  let flashed = 0;

  while (flashed < 2) {
    const nextBeatMs = offset + (session.beatIndex + 1) * interval;
    if (progressMs + 25 < nextBeatMs) {
      break;
    }

    session.beatIndex += 1;
    if (session.beatIndex % step !== 0) {
      continue;
    }

    triggerFlash(broadcasterUserId, session, audioPrimary ? { audioDriven: true } : {});
    flashed += 1;
  }
}

function onAudioBeat(broadcasterUserId) {
  if (isChatLightsMuted(broadcasterUserId)) {
    return;
  }
  const settings = lightingSyncConfig.getSettings(broadcasterUserId);
  if (!settings.beatEnabled || !settings.audioSyncEnabled) {
    return;
  }

  const session = sessions.get(String(broadcasterUserId));
  if (runtime.spotifyPlaying === false && !session?.trackId) {
    return;
  }

  if (!hasLightsForSync(broadcasterUserId)) {
    return;
  }

  if (!session?.palette?.length) {
    return;
  }

  const step = Math.max(1, Number(session.beatsPerFlash) || 1);
  session.audioBeatIndex = (Number(session.audioBeatIndex) || 0) + 1;
  if (session.audioBeatIndex % step !== 0) {
    return;
  }

  const audio = systemAudio.getStatus();
  runtime.audio = audio;
  if (!audio.running || !audio.hasSignal) {
    return;
  }

  if (triggerFlash(broadcasterUserId, session, { audioDriven: true })) {
    runtime.lastSyncAt = new Date().toISOString();
  }
}

async function syncAudioCapture(broadcasterUserId) {
  const settings = lightingSyncConfig.getSettings(broadcasterUserId);

  if (settings.beatEnabled && settings.audioSyncEnabled) {
    const bpm = runtime.bpm || 120;
    const beatGap = 60000 / Math.max(60, Math.min(200, bpm));
    runtime.audio = await systemAudio.start({
      sensitivity: settings.audioSensitivity,
      minBeatGapMs: Math.max(70, Math.min(130, Math.round(beatGap * 0.32))),
    });
  } else {
    systemAudio.stop();
    runtime.audio = systemAudio.getStatus();
  }
}

function ensureAudioCapture(broadcasterUserId) {
  const settings = lightingSyncConfig.getSettings(broadcasterUserId);
  if (!settings.beatEnabled || !settings.audioSyncEnabled) {
    return;
  }
  const audio = systemAudio.getStatus();
  if (audio.hasSignal) {
    lastAudioSignalAt = Date.now();
  }
  if (!audio.running && !audio.error) {
    syncAudioCapture(broadcasterUserId).catch(() => {});
    return;
  }
  const now = Date.now();
  if (
    audio.running &&
    !audio.hasSignal &&
    lastAudioSignalAt &&
    now - lastAudioSignalAt > 20000 &&
    now - lastAudioRestartAt > 20000
  ) {
    lastAudioRestartAt = now;
    systemAudio.stop();
    syncAudioCapture(broadcasterUserId).catch(() => {});
  }
}

async function tick() {
  const broadcasterId = tokenStore.getPrimaryBroadcasterId();
  if (!broadcasterId) {
    runtime.status = "idle";
    runtime.trackName = null;
    runtime.trackId = null;
    return;
  }

  const settings = lightingSyncConfig.getSettings(broadcasterId);
  if (!settings.moodEnabled && !settings.beatEnabled) {
    runtime.status = "idle";
    return;
  }

  if (lightingChatMute.isMuted(broadcasterId)) {
    runtime.status = "lights-muted";
    runtime.lightsChatMuted = true;
    if (Date.now() - lastMutedOffAt > 1500) {
      lastMutedOffAt = Date.now();
      forceAllLightsOff(broadcasterId).catch(() => {});
    }
    return;
  }
  runtime.lightsChatMuted = false;

  if (!hue.isConnected(broadcasterId) || !spotify.getToken(broadcasterId)) {
    runtime.status = "waiting";
    runtime.error = !hue.isConnected(broadcasterId)
      ? "Connect Hue and save your light selection"
      : "Connect Spotify in Widgets";
    return;
  }

  if (!hasLightsForSync(broadcasterId)) {
    runtime.status = "waiting";
    runtime.error = "Sync layout from devices or save Hue/Govee selection";
    return;
  }

  runtime.error = null;
  ensureAudioCapture(broadcasterId);

  try {
    const id = String(broadcasterId);
    let session = sessions.get(id);
    const shouldPoll = canPollSpotify(broadcasterId, settings);

    let playback;
    if (shouldPoll) {
      try {
        const publicState = await spotifyState.refreshPlayback(broadcasterId, { force: true });
        markSpotifyPolled(broadcasterId);
        if (/rate limit/i.test(publicState.error || "")) {
          markSpotifyRateLimited(broadcasterId, 45000);
          const meta = getSpotifyPollMeta(broadcasterId);
          if (Date.now() - meta.lastRateLimitLogAt > 60000) {
            meta.lastRateLimitLogAt = Date.now();
            console.warn("[spotify-hue] Spotify rate limited — backing off, lights still sync from audio");
          }
          playback = buildFallbackPlayback(session, broadcasterId);
          runtime.error = null;
        } else {
          playback = publicStateToPlayback(publicState);
          runtime.error = null;
          if (session && playback) {
            resyncSessionProgress(session, playback.progressMs || 0, runtime.bpm);
            session.lastResyncAt = Date.now();
          }
        }
      } catch (error) {
        if (/rate limit/i.test(error.message)) {
          markSpotifyRateLimited(broadcasterId, error.retryAfterMs);
          const meta = getSpotifyPollMeta(broadcasterId);
          if (Date.now() - meta.lastRateLimitLogAt > 60000) {
            meta.lastRateLimitLogAt = Date.now();
            console.warn("[spotify-hue] Spotify rate limited — backing off, lights still sync from audio");
          }
          playback = buildFallbackPlayback(session, broadcasterId);
          runtime.error = null;
        } else {
          throw error;
        }
      }
    } else if (session) {
      playback = {
        connected: true,
        isPlaying: true,
        track: { id: session.trackId, name: session.trackName },
        progressMs: estimateProgressMs(session),
      };
    } else {
      playback = buildFallbackPlayback(session, broadcasterId);
      if (!playback) {
        return;
      }
    }

    if (!playback?.track?.id && session?.trackId) {
      playback = buildFallbackPlayback(session, broadcasterId);
    }

    if (!playback.connected || !playback.track?.id) {
      runtime.status = "waiting";
      runtime.trackName = null;
      runtime.trackId = null;
      return;
    }

    if (playback.isPlaying) {
      lastConfirmedPlayingAt = Date.now();
    }

    if (!isBelievedPlaying(playback, session)) {
      runtime.status = "paused";
      runtime.trackName = playback.track.name;
      runtime.trackId = playback.track.id;
      if (runtime.spotifyPlaying !== false) {
        runtime.spotifyPlaying = false;
        lightsOff(broadcasterId).catch(() => {});
      }
      return;
    }

    runtime.spotifyPlaying = true;

    const state = {
      track: playback.track,
      isPlaying: true,
      progressMs: shouldPoll ? playback.progressMs : estimateProgressMs(session),
    };

    if (!session || session.trackId !== state.track.id) {
      await onTrackChange(broadcasterId, state, settings);
      session = sessions.get(id);
    }

    if (session) {
      const audio = systemAudio.getStatus();
      runtime.audio = audio;
      if (shouldUseBpmWallClock(settings, audio)) {
        processBpmWallClock(broadcasterId, session, settings);
      } else {
        processBeats(broadcasterId, session, estimateProgressMs(session), settings);
      }
      ensureBeatAlive(broadcasterId, session, settings);
    }

    runtime.trackName = state.track.name;
    runtime.trackId = state.track.id;
    runtime.status = "playing";
    if (!runtime.audio) {
      runtime.audio = systemAudio.getStatus();
    }
    runtime.lastSyncAt = new Date().toISOString();
  } catch (error) {
    runtime.status = "error";
    runtime.error = error.message;
    console.warn("[spotify-hue] tick:", error.message);
  }
}

function start() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
}

function stop() {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function resetSession(broadcasterUserId) {
  sessions.delete(String(broadcasterUserId));
}

function saveCalibrationForCurrentTrack(broadcasterUserId) {
  const session = sessions.get(String(broadcasterUserId));
  if (!session?.trackId) {
    throw new Error("No track is playing");
  }

  const settings = lightingSyncConfig.getSettings(broadcasterUserId);
  return lightingCalibration.saveTrackCalibration(
    broadcasterUserId,
    { id: session.trackId, name: session.trackName },
    {
      bpm: runtime.bpm,
      bpmOffset: settings.bpmOffset,
      beatsPerFlash: session.beatsPerFlash,
      mode: session.mode,
    }
  );
}

module.exports = {
  start,
  stop,
  tick,
  resetSession,
  getRuntimeStatus,
  saveCalibrationForCurrentTrack,
  onAudioBeat,
  syncAudioCapture,
  pauseManualControl,
  setChatLightsOff,
  setChatLightsOn,
  isChatLightsMuted,
  buildSongPalette,
};
