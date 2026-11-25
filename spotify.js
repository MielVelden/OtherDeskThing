'use strict';

// Minimal Spotify Web API client: refresh-token flow + "currently playing".
// Runs on the server only. The iPod never talks to Spotify (it can't do modern TLS).

const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const TIMEOUT_MS = 10000;

function create(opts) {
  const clientId = opts.clientId;
  const clientSecret = opts.clientSecret;
  const tokenFile = opts.tokenFile;
  let accessToken = null;
  let expiresAt = 0;

  function configured() {
    return Boolean(clientId && clientSecret);
  }

  // The token file (written by spotify-auth.js or after a rotation) wins over the
  // env var, and it's re-read on every refresh, so running the auth helper works
  // without restarting the server.
  function refreshToken() {
    try {
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (saved && saved.refresh_token) return saved.refresh_token;
    } catch (e) { /* no file yet */ }
    return opts.refreshToken || null;
  }

  function hasRefreshToken() {
    return Boolean(refreshToken());
  }

  function saveRefreshToken(token) {
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: token }) + '\n', { mode: 0o600 });
    } catch (e) {
      console.warn('spotify: could not save rotated refresh token:', e.message);
    }
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < expiresAt - 60000) return accessToken;

    const current = refreshToken();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error('token refresh failed (HTTP ' + res.status + ')');

    const json = await res.json();
    accessToken = json.access_token;
    expiresAt = Date.now() + json.expires_in * 1000;
    if (json.refresh_token && json.refresh_token !== current) saveRefreshToken(json.refresh_token);
    return accessToken;
  }

  // Returns a normalized track object, or null when nothing is playing.
  async function currentlyPlaying() {
    const token = await getAccessToken();
    const res = await fetch(API_URL + '/me/player/currently-playing?additional_types=episode', {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (res.status === 204) return null;
    if (res.status === 401) {
      accessToken = null;
      throw new Error('access token rejected (HTTP 401)');
    }
    if (res.status === 429) {
      const err = new Error('rate limited by Spotify');
      err.retryAfter = parseInt(res.headers.get('retry-after'), 10) || 30;
      throw err;
    }
    if (!res.ok) throw new Error('currently-playing failed (HTTP ' + res.status + ')');

    const json = await res.json();
    return normalize(json);
  }

  return { configured, hasRefreshToken, currentlyPlaying };
}

function normalize(json) {
  const item = json && json.item;
  if (!item) return null; // ads, or a private session

  const isEpisode = item.type === 'episode';
  const images = isEpisode
    ? (item.images && item.images.length ? item.images : (item.show && item.show.images) || [])
    : (item.album && item.album.images) || [];

  return {
    id: item.id || item.uri || item.name,
    title: item.name || '',
    artist: isEpisode
      ? (item.show && item.show.name) || ''
      : (item.artists || []).map(function (a) { return a.name; }).join(', '),
    album: isEpisode
      ? (item.show && item.show.publisher) || ''
      : (item.album && item.album.name) || '',
    isPlaying: Boolean(json.is_playing),
    progressMs: json.progress_ms || 0,
    durationMs: item.duration_ms || 0,
    fetchedAt: Date.now(),
    coverUrl: pickImage(images)
  };
}

// Spotify gives 640/300/64 px. 300 px is plenty for a 160 px slot on a non-retina iPod.
function pickImage(images) {
  if (!images.length) return null;
  let best = images[0];
  images.forEach(function (img) {
    if (Math.abs((img.width || 0) - 300) < Math.abs((best.width || 0) - 300)) best = img;
  });
  return best.url;
}

module.exports = { create };
