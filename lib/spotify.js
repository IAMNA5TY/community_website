const spotifyTokens = require("./spotify-tokens");

const SPOTIFY_API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

function resolveRedirectUri(override) {
  if (override) return override;
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  return `${process.env.BASE_URL || "http://localhost:3000"}/auth/spotify/callback`;
}

function getConfig(redirectUriOverride) {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: resolveRedirectUri(redirectUriOverride),
  };
}

function isConfigured() {
  const { clientId, clientSecret } = getConfig();
  return Boolean(clientId && clientSecret);
}

async function exchangeCode(code, redirectUriOverride) {
  const { clientId, clientSecret, redirectUri } = getConfig(redirectUriOverride);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Spotify token exchange failed");
  }
  return data;
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getConfig();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Spotify refresh failed");
  }
  return data;
}

async function getValidAccessToken(broadcasterUserId) {
  const stored = spotifyTokens.getToken(broadcasterUserId);
  if (!stored?.accessToken) {
    throw new Error("Spotify not connected");
  }

  const expiresSoon = stored.expiresAt && stored.expiresAt - Date.now() < 60 * 1000;
  if (!expiresSoon) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    throw new Error("Spotify session expired — reconnect in dashboard");
  }

  const tokens = await refreshAccessToken(stored.refreshToken);
  spotifyTokens.updateToken(broadcasterUserId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || stored.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope || stored.scope,
  });

  return tokens.access_token;
}

function spotifyApiError(data, status, statusText) {
  const message = data?.error?.message || data?.error?.reason || data?.error;
  if (typeof message === "string" && message) {
    return message;
  }
  if (status === 404) {
    return "No active Spotify device — open Spotify on your PC and press play once";
  }
  return statusText || `Spotify error (${status})`;
}

async function spotifyFetch(broadcasterUserId, path, options = {}) {
  const accessToken = await getValidAccessToken(broadcasterUserId);
  const method = (options.method || "GET").toUpperCase();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };

  const fetchOptions = {
    ...options,
    method,
    headers,
  };

  if (method === "GET" || method === "DELETE") {
    delete fetchOptions.body;
  } else if (fetchOptions.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${SPOTIFY_API}${path}`, fetchOptions);

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const trimmed = text.trim();

  if (!trimmed) {
    if (!response.ok) {
      throw new Error(spotifyApiError({}, response.status, response.statusText));
    }
    return null;
  }

  let data = null;
  try {
    data = JSON.parse(trimmed);
  } catch (error) {
    if (response.ok) {
      console.warn(
        `[spotify] Ignoring non-JSON success body for ${path} (${response.status}): ${trimmed.slice(0, 120)}`
      );
      return null;
    }
    console.warn(
      `[spotify] Non-JSON error body for ${path} (${response.status}): ${trimmed.slice(0, 120)}`
    );
    throw new Error(spotifyApiError({}, response.status, response.statusText));
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterSec = Number(response.headers.get("retry-after")) || 60;
      const error = new Error(`API rate limit exceeded. Retry in ${retryAfterSec}s`);
      error.retryAfterMs = retryAfterSec * 1000;
      throw error;
    }
    throw new Error(spotifyApiError(data, response.status, response.statusText));
  }

  return data;
}

function mapTrack(item) {
  if (!item) return null;
  const track = item.item || item;
  if (!track?.name) return null;

  return {
    id: track.id,
    name: track.name,
    artists: (track.artists || []).map((artist) => artist.name).join(", "),
    album: track.album?.name || "",
    albumArt: track.album?.images?.[0]?.url || null,
    uri: track.uri,
    durationMs: track.duration_ms || item.duration_ms || 0,
    progressMs: item.progress_ms ?? 0,
    isPlaying: Boolean(item.is_playing),
  };
}

async function getPlaybackState(broadcasterUserId) {
  try {
    const player = await spotifyFetch(broadcasterUserId, "/me/player", {
      method: "GET",
    });
    if (!player) {
      return { connected: true, isPlaying: false, track: null, device: null };
    }

    return {
      connected: true,
      isPlaying: Boolean(player.is_playing),
      track: mapTrack(player),
      volume: player.device?.volume_percent ?? null,
      device: player.device?.name || null,
      progressMs: player.progress_ms || 0,
    };
  } catch (error) {
    if (String(error.message).includes("No active device")) {
      return {
        connected: true,
        isPlaying: false,
        track: null,
        device: null,
        error: "No active Spotify device — open Spotify on your PC and press play once",
      };
    }
    throw error;
  }
}

async function searchTrack(broadcasterUserId, query) {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: "1",
  });
  const data = await spotifyFetch(
    broadcasterUserId,
    `/search?${params.toString()}`,
    { method: "GET" }
  );
  return data.tracks?.items?.[0] || null;
}

async function addToQueue(broadcasterUserId, trackUri) {
  const params = new URLSearchParams({ uri: trackUri });
  await spotifyFetch(broadcasterUserId, `/me/player/queue?${params.toString()}`, {
    method: "POST",
  });
}

async function skipTrack(broadcasterUserId) {
  await spotifyFetch(broadcasterUserId, "/me/player/next", { method: "POST" });
}

function isBenignPlaybackError(error) {
  return /restriction violated/i.test(String(error?.message || ""));
}

async function seekPlayback(broadcasterUserId, positionMs = 0) {
  const position = Math.max(0, Math.floor(positionMs));
  const params = new URLSearchParams({ position_ms: String(position) });
  await spotifyFetch(broadcasterUserId, `/me/player/seek?${params.toString()}`, {
    method: "PUT",
  });
}

async function replayTrack(broadcasterUserId) {
  let isPlaying = false;
  try {
    const state = await getPlaybackState(broadcasterUserId);
    isPlaying = Boolean(state.isPlaying);
  } catch {
    /* seek still worth trying */
  }

  await seekPlayback(broadcasterUserId, 0);
  if (!isPlaying) {
    await resumePlayback(broadcasterUserId);
  }
}

async function pausePlayback(broadcasterUserId) {
  await spotifyFetch(broadcasterUserId, "/me/player/pause", { method: "PUT" });
}

async function resumePlayback(broadcasterUserId) {
  try {
    await spotifyFetch(broadcasterUserId, "/me/player/play", { method: "PUT" });
  } catch (error) {
    if (isBenignPlaybackError(error)) return;
    throw error;
  }
}

async function setVolume(broadcasterUserId, volumePercent) {
  const volume = Math.max(0, Math.min(100, volumePercent));
  const params = new URLSearchParams({ volume_percent: String(volume) });
  await spotifyFetch(
    broadcasterUserId,
    `/me/player/volume?${params.toString()}`,
    { method: "PUT" }
  );
  return volume;
}

async function getProfile(broadcasterUserId) {
  return spotifyFetch(broadcasterUserId, "/me", { method: "GET" });
}

async function getAudioFeatures(broadcasterUserId, trackId) {
  return spotifyFetch(broadcasterUserId, `/audio-features/${trackId}`, { method: "GET" });
}

async function getAudioAnalysis(broadcasterUserId, trackId) {
  return spotifyFetch(broadcasterUserId, `/audio-analysis/${trackId}`, { method: "GET" });
}

function getAuthorizeUrl(state, redirectUriOverride) {
  const { clientId, redirectUri } = getConfig(redirectUriOverride);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: "true",
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

module.exports = {
  SCOPES,
  isConfigured,
  resolveRedirectUri,
  getAuthorizeUrl,
  exchangeCode,
  getPlaybackState,
  searchTrack,
  addToQueue,
  skipTrack,
  seekPlayback,
  replayTrack,
  pausePlayback,
  resumePlayback,
  setVolume,
  getProfile,
  getAudioFeatures,
  getAudioAnalysis,
  getToken: spotifyTokens.getToken,
  deleteToken: spotifyTokens.deleteToken,
};
