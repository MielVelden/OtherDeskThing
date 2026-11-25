/*
 * DeskThing client. ES5 only, written for Mobile Safari 5.1 (iOS 5.1.1).
 * No let/const, arrow functions, template literals, fetch, Promise, classes,
 * Function.prototype.bind (missing in Safari 5.1) or classList.
 *
 * Live updates: EventSource when available, XHR long-polling otherwise
 * (or when the stream keeps failing). Feature detection only, no UA sniffing.
 */
(function () {
  'use strict';

  var POLL_DELAY = 1000;          // pause between long-poll requests
  var POLL_ERROR_DELAY = 4000;    // retry delay after a failed poll
  var REQUEST_TIMEOUT = 35000;    // server holds long-polls for up to 25 s
  var SSE_MAX_ERRORS = 3;         // errors without any message before falling back
  var SSE_WATCHDOG = 40000;       // server sends a heartbeat every 15 s

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var EMPTY_TEXT = {
    starting: 'Loading…',
    off: 'Spotify isn’t set up on the server yet.',
    setup: 'Run “npm run spotify-auth” on the server to link Spotify.',
    error: 'Can’t reach Spotify right now.',
    ok: 'Nothing playing on Spotify.'
  };

  var lastVersion = 0;
  var clockOffset = 0;      // serverTime - local time, so a drifting iPod clock doesn't matter
  var track = null;
  var coverSrc = null;
  var mode = null;          // 'sse' | 'poll'
  var es = null;
  var watchdogTimer = null;
  var pollTimer = null;

  function byId(id) { return document.getElementById(id); }

  var el = {
    clock: byId('clock'),
    date: byId('date'),
    now: byId('now'),
    empty: byId('empty'),
    cover: byId('cover'),
    playState: byId('play-state'),
    title: byId('title'),
    artist: byId('artist'),
    album: byId('album'),
    bar: byId('bar'),
    elapsed: byId('elapsed'),
    duration: byId('duration'),
    conn: byId('conn'),
    connText: byId('conn-text')
  };

  // ---- helpers ----

  function setText(node, text) {
    node.textContent = text; // never innerHTML: song titles are untrusted
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function now() {
    return new Date().getTime();
  }

  function serverNow() {
    return now() + clockOffset;
  }

  function formatTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }

  function setConn(kind, text) {
    el.conn.className = 'conn-' + kind;
    setText(el.connText, text);
  }

  // ---- rendering ----

  function tick() {
    var d = new Date(serverNow());
    setText(el.clock, pad2(d.getHours()) + ':' + pad2(d.getMinutes()));
    setText(el.date, DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]);
    renderProgress();
  }

  function renderProgress() {
    if (!track || !track.durationMs) {
      el.bar.style.width = '0';
      setText(el.elapsed, '');
      setText(el.duration, '');
      return;
    }
    var pos = track.progressMs + (track.isPlaying ? serverNow() - track.fetchedAt : 0);
    if (pos < 0) pos = 0;
    if (pos > track.durationMs) pos = track.durationMs;
    el.bar.style.width = (pos / track.durationMs * 100).toFixed(1) + '%';
    setText(el.elapsed, formatTime(pos));
    setText(el.duration, formatTime(track.durationMs));
  }

  // The image is hidden with visibility (not display:none): old Mobile Safari
  // may never load an image that is display:none, so onload would never fire.
  var COVER_RETRIES = 3;
  var coverTries = 0;
  var coverRetryTimer = null;

  function setCover(src) {
    if (src === coverSrc) return;
    coverSrc = src;
    coverTries = 0;
    clearTimeout(coverRetryTimer);
    el.cover.style.visibility = 'hidden';
    if (src) el.cover.src = src;
  }

  el.cover.onload = function () {
    el.cover.style.visibility = 'visible';
  };

  el.cover.onerror = function () {
    var src = coverSrc;
    el.cover.style.visibility = 'hidden';
    if (!src || coverTries >= COVER_RETRIES) return;
    coverTries++;
    clearTimeout(coverRetryTimer);
    coverRetryTimer = setTimeout(function () {
      if (coverSrc === src) el.cover.src = src + '&r=' + now();
    }, 3000 * coverTries);
  };

  function render(s) {
    if (typeof s.serverTime === 'number') clockOffset = s.serverTime - now();
    if (typeof s.version !== 'number') return; // heartbeat
    lastVersion = s.version;
    track = s.track || null;

    if (track) {
      el.now.className = track.isPlaying ? 'is-playing' : 'is-paused';
      setText(el.playState, s.spotify === 'error' ? 'Last seen' : (track.isPlaying ? 'Now playing' : 'Paused'));
      setText(el.title, track.title);
      setText(el.artist, track.artist);
      setText(el.album, track.album);
      el.empty.style.display = 'none';
      el.now.style.display = 'block'; // show the card before setting src (see setCover)
      setCover(track.cover);
    } else {
      setCover(null);
      el.now.style.display = 'none';
      el.empty.style.display = 'block';
      setText(el.empty, EMPTY_TEXT[s.spotify] || EMPTY_TEXT.ok);
    }
    tick();
  }

  function handleData(text) {
    var s;
    try {
      s = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (s) render(s);
  }

  // ---- XHR long-polling ----

  function getJson(path, cb) {
    var req = new XMLHttpRequest();
    var done = false;
    var sep = path.indexOf('?') === -1 ? '?' : '&';

    // iOS caches XHR responses aggressively; the timestamp makes every URL unique.
    req.open('GET', path + sep + '_=' + now(), true);

    // XHR .timeout doesn't exist on iOS 5, so time out by hand.
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      req.abort();
      cb(new Error('timeout'));
    }, REQUEST_TIMEOUT);

    req.onreadystatechange = function () {
      if (req.readyState !== 4 || done) return;
      done = true;
      clearTimeout(timer);
      if (req.status >= 200 && req.status < 300) {
        cb(null, req.responseText);
      } else {
        cb(new Error('HTTP ' + req.status));
      }
    };
    req.send(null);
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function poll() {
    getJson('/api/state?since=' + lastVersion, function (err, text) {
      if (mode !== 'poll') return;
      if (err) {
        setConn('off', 'Offline, retrying');
        schedulePoll(POLL_ERROR_DELAY);
        return;
      }
      setConn('poll', 'Live (polling)');
      handleData(text);
      schedulePoll(POLL_DELAY);
    });
  }

  function startPolling() {
    if (mode === 'poll') return;
    stopSSE();
    mode = 'poll';
    setConn('wait', 'Connecting (polling)');
    poll();
  }

  // ---- Server-Sent Events ----

  function kickWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(function () {
      // Nothing arrived for too long: probably a buffering proxy. Use polling.
      startPolling();
    }, SSE_WATCHDOG);
  }

  function stopSSE() {
    clearTimeout(watchdogTimer);
    if (es) {
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
      es = null;
    }
  }

  function startSSE() {
    var errors = 0;
    try {
      es = new EventSource('/api/events');
    } catch (e) {
      startPolling();
      return;
    }
    mode = 'sse';
    setConn('wait', 'Connecting');

    es.onmessage = function (e) {
      errors = 0; // reset only on real data, so open-then-drop loops still fall back
      setConn('live', 'Live');
      kickWatchdog();
      handleData(e.data);
    };

    es.onerror = function () {
      errors++;
      setConn('wait', 'Reconnecting');
      // readyState 2 = CLOSED: the browser gave up reconnecting on its own.
      if (errors >= SSE_MAX_ERRORS || (es && es.readyState === 2)) startPolling();
    };

    kickWatchdog();
  }

  // ---- start ----

  // Coming back via the back/forward cache: timers and streams may be stale.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) window.location.reload();
  }, false);

  tick();
  setInterval(tick, 1000);

  function startLive() {
    // ?poll=1 forces the fallback, handy for testing it on a modern browser.
    if (typeof window.EventSource !== 'undefined' && window.location.search.indexOf('poll=1') === -1) {
      startSSE();
    } else {
      startPolling();
    }
  }

  // Open the never-ending connection only after the page has finished loading,
  // so old Mobile Safari doesn't show a loading spinner forever. (Images stuck
  // behind the stream are a separate issue, fixed server-side with
  // Connection: close; see server.js.)
  if (document.readyState === 'complete') {
    setTimeout(startLive, 100);
  } else {
    window.addEventListener('load', function () { setTimeout(startLive, 100); }, false);
  }
})();
