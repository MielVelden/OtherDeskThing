'use strict';

// DeskThing: shows your current Spotify song on very old browsers (iOS 5 Safari).
// No dependencies. Plain HTTP only, on purpose: no HTTPS, no HSTS, no redirects.

const http = require('http');
const fs = require('fs');
const path = require('path');
const spotify = require('./spotify');
const labStats = require('./lab');
const weatherFeed = require('./weather');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_REQUESTS = process.env.LOG_REQUESTS === '1';

const POLL_PLAYING_MS = 5000;     // Spotify poll interval while music plays
const POLL_IDLE_MS = 15000;       // ...while paused / nothing playing
const POLL_ERROR_MS = 30000;      // ...after an error
const SEEK_TOLERANCE_MS = 3000;   // progress jumps bigger than this count as a change
const HEARTBEAT_MS = 15000;       // SSE keep-alive (also lets the client detect a dead stream)
const LONG_POLL_HOLD_MS = 25000;  // max time a long-poll request is held open

const sp = spotify.create({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
  tokenFile: path.join(DATA_DIR, 'spotify-token.json')
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  version: 1,
  spotify: 'starting', // starting | off | setup | ok | error
  track: null
};

const sseClients = new Set();   // open EventSource responses
const pollWaiters = new Set();  // held long-poll requests: { res, timer }

function publicTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    isPlaying: t.isPlaying,
    progressMs: t.progressMs,
    durationMs: t.durationMs,
    fetchedAt: t.fetchedAt,
    cover: t.coverUrl ? '/api/cover?id=' + encodeURIComponent(t.id) : null
  };
}

function snapshot() {
  return {
    version: state.version,
    serverTime: Date.now(),
    spotify: state.spotify,
    track: publicTrack(state.track),
    lab: lab,
    weather: wx.weather,
    weatherError: wx.error
  };
}

// Call after every visible change: bumps the version and pushes to everyone.
function changed() {
  state.version++;
  const json = JSON.stringify(snapshot());

  sseClients.forEach(function (res) {
    res.write('id: ' + state.version + '\ndata: ' + json + '\n\n');
  });

  pollWaiters.forEach(function (w) {
    clearTimeout(w.timer);
    sendJson(w.res, 200, json);
  });
  pollWaiters.clear();
}

// Homelab stats tick every 5 s (CPU changes constantly, so each tick is a push);
// weather pushes when it refreshes (every 10 min).
const lab = labStats.create(changed);
const wx = weatherFeed.create(changed);

// Heartbeats are normal "message" events without a version (simplest thing that
// definitely works in old WebKit). They also carry serverTime for the clock.
setInterval(function () {
  const ping = 'data: {"ping":1,"serverTime":' + Date.now() + '}\n\n';
  sseClients.forEach(function (res) { res.write(ping); });
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// Spotify polling
// ---------------------------------------------------------------------------

function trackKey(t) {
  return t ? t.id + '|' + t.isPlaying : '';
}

// The client animates progress itself, so only a seek (a jump in progress) needs a push.
function seeked(prev, next) {
  if (!prev || !next || prev.id !== next.id) return false;
  const expected = prev.progressMs + (prev.isPlaying ? next.fetchedAt - prev.fetchedAt : 0);
  return Math.abs(expected - next.progressMs) > SEEK_TOLERANCE_MS;
}

function setSpotify(status, track) {
  const prev = state.track;
  const isChange = status !== state.spotify || trackKey(prev) !== trackKey(track) || seeked(prev, track);
  state.spotify = status;
  state.track = track;
  if (track && track.coverUrl) loadCover(track.coverUrl).catch(function () {});
  if (isChange) changed();
}

let lastError = '';

async function pollSpotify() {
  let delay = POLL_IDLE_MS;

  if (!sp.configured()) {
    setSpotify('off', null);
    console.log('spotify: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set; Spotify disabled');
    return; // config comes from env, so nothing will change until a restart
  }

  try {
    if (!sp.hasRefreshToken()) {
      setSpotify('setup', null);
      delay = 10000;
    } else {
      const t = await sp.currentlyPlaying();
      setSpotify('ok', t);
      lastError = '';
      if (t && t.isPlaying) {
        delay = POLL_PLAYING_MS;
        // Check again right after the song should end so the next one shows promptly.
        const left = t.durationMs - t.progressMs;
        if (left > 0 && left < delay) delay = left + 800;
      }
    }
  } catch (err) {
    if (err.message !== lastError) console.warn('spotify:', err.message);
    lastError = err.message;
    setSpotify('error', state.track);
    delay = err.retryAfter ? err.retryAfter * 1000 : POLL_ERROR_MS;
  }

  setTimeout(pollSpotify, delay);
}

// Album art lives on HTTPS servers the iPod can't talk to, so the server fetches
// the current cover once and serves it over plain HTTP. Only the current track's
// cover is ever fetched: this is not an open proxy.
let cover = { url: null, promise: null };

function loadCover(url) {
  if (cover.url === url) return cover.promise;
  const entry = { url: url, promise: null };
  entry.promise = fetch(url, { signal: AbortSignal.timeout(10000) }).then(function (r) {
    if (!r.ok) throw new Error('cover HTTP ' + r.status);
    return r.arrayBuffer().then(function (buf) {
      return { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(buf) };
    });
  });
  entry.promise.catch(function () {
    if (cover === entry) cover = { url: null, promise: null }; // allow a retry
  });
  cover = entry;
  return entry.promise;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Old Mobile Safari caches aggressively (even XHR); make API responses uncacheable.
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0'
};

function sendJson(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  }, NO_CACHE));
  res.end(text);
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function handleEvents(req, res) {
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no' // tells nginx not to buffer the stream
  }, NO_CACHE));

  // 2 KB comment padding pushes the first bytes through buffering proxies.
  res.write(':' + ' '.repeat(2048) + '\n');
  res.write('retry: 3000\n\n');
  res.write('id: ' + state.version + '\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
  sseClients.add(res);

  req.on('close', function () { sseClients.delete(res); });
}

function handleState(req, res, query) {
  const since = parseInt(query.get('since'), 10);

  // Answer right away on first load, when something changed, or after a server
  // restart (the client's version doesn't match ours).
  if (!since || since !== state.version) {
    sendJson(res, 200, snapshot());
    return;
  }

  // Otherwise hold the request until the next change (long-poll).
  const waiter = { res: res, timer: null };
  waiter.timer = setTimeout(function () {
    pollWaiters.delete(waiter);
    sendJson(res, 200, snapshot());
  }, LONG_POLL_HOLD_MS);
  pollWaiters.add(waiter);

  req.on('close', function () {
    if (pollWaiters.delete(waiter)) clearTimeout(waiter.timer);
  });
}

function handleCover(req, res, query) {
  const t = state.track;
  if (!t || !t.coverUrl || query.get('id') !== t.id) {
    res.writeHead(404, NO_CACHE); res.end(); return;
  }
  loadCover(t.coverUrl).then(function (img) {
    res.writeHead(200, {
      'Content-Type': img.type,
      'Content-Length': img.body.length,
      'Cache-Control': 'public, max-age=86400' // URL is per track, so caching is safe
    });
    res.end(req.method === 'HEAD' ? undefined : img.body);
  }, function () {
    res.writeHead(502, NO_CACHE); res.end();
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    res.writeHead(400); res.end(); return;
  }
  if (rel === '/') rel = '/index.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (file.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    res.writeHead(403); res.end(); return;
  }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const lastModified = st.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Last-Modified': lastModified,
      'Cache-Control': 'no-cache' // revalidate each load so edits show up on the iPod
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const m = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // iOS 5/6 Safari pipelines requests onto keep-alive connections. A request
  // queued behind the never-ending SSE (or a held long-poll) response would wait
  // forever; that's why album art never loaded. Closing every connection after
  // its response means nothing can ever queue behind the stream.
  res.setHeader('Connection', 'close');

  if (LOG_REQUESTS) {
    const started = Date.now();
    res.on('close', function () {
      console.log([
        new Date().toISOString(),
        req.socket.remoteAddress,
        m, req.url,
        res.writableFinished ? res.statusCode : 'aborted',
        (Date.now() - started) + 'ms',
        (req.headers['user-agent'] || '').slice(0, 90)
      ].join(' '));
    });
  }

  if (m !== 'GET' && m !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end();
    return;
  }

  if (p === '/api/events') return handleEvents(req, res);
  if (p === '/api/state') return handleState(req, res, u.searchParams);
  if (p === '/api/cover') return handleCover(req, res, u.searchParams);
  if (p === '/healthz') return sendJson(res, 200, { ok: true });
  if (p.indexOf('/api/') === 0) return sendJson(res, 404, { error: 'not found' });

  serveStatic(req, res, p);
});

server.listen(PORT, HOST, function () {
  console.log('DeskThing listening on http://' + HOST + ':' + PORT);
  pollSpotify();
});

function shutdown() {
  sseClients.forEach(function (res) { res.end(); });
  pollWaiters.forEach(function (w) { clearTimeout(w.timer); w.res.end(); });
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
