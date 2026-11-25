/*
 * DeskThing client. ES5 only, written for Mobile Safari 5.1/6 (iOS 5-6).
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
  var TABS = ['music', 'lab', 'weather'];

  var EMPTY_TEXT = {
    starting: 'Loading…',
    off: 'Spotify isn’t set up on the server yet.',
    setup: 'Run “npm run spotify-auth” on the server to link Spotify.',
    error: 'Can’t reach Spotify right now.',
    ok: 'Nothing is playing on Spotify.'
  };

  var lastVersion = 0;
  var clockOffset = 0;      // serverTime - local time, so a drifting iPod clock doesn't matter
  var track = null;
  var mode = null;          // 'sse' | 'poll'
  var es = null;
  var watchdogTimer = null;
  var pollTimer = null;
  var dockerSignature = '';
  var daysSignature = '';

  function byId(id) { return document.getElementById(id); }

  var el = {
    clock: byId('clock'),
    conn: byId('conn'),
    now: byId('now'),
    empty: byId('music-empty'),
    cover: byId('cover'),
    playState: byId('play-state'),
    title: byId('title'),
    artist: byId('artist'),
    album: byId('album'),
    bar: byId('bar'),
    elapsed: byId('elapsed'),
    duration: byId('duration')
  };

  // ---- helpers ----

  function setText(node, text) {
    node.textContent = text; // never innerHTML: titles and container names are untrusted
  }

  function show(node, visible) {
    node.style.display = visible ? 'block' : 'none';
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

  function formatUptime(sec) {
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function setMeter(node, pct) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    node.style.width = pct.toFixed(1) + '%';
  }

  function degrees(n) {
    return (n === null || n === undefined) ? '–' : n + '°';
  }

  function setConn(kind) {
    el.conn.className = 'conn-' + kind;
  }

  // ---- windows (the menus bring a group of windows to the front) ----

  var GROUPS = {
    music: ['win-music'],
    lab: ['win-mac', 'win-docker'],
    weather: ['win-wx', 'win-fc']
  };
  var zTop = 10;

  function currentTab() {
    var h = window.location.hash.replace('#', '');
    if (TABS.indexOf(h) !== -1) return h;
    try {
      var saved = window.localStorage.getItem('deskthing-tab');
      if (TABS.indexOf(saved) !== -1) return saved;
    } catch (e) { /* private mode etc. */ }
    return 'music';
  }

  // Brings one group forward. Other windows keep their relative stacking, so
  // the desktop stays a believable pile. In portrait, CSS hides .back windows.
  function front(name) {
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      var wins = GROUPS[t];
      for (var j = 0; j < wins.length; j++) {
        byId(wins[j]).className = t === name ? 'win' : 'win back';
      }
      byId('menu-' + t).className = t === name ? 'menu sel' : 'menu';
    }
    var group = GROUPS[name];
    for (var k = 0; k < group.length; k++) {
      byId(group[k]).style.zIndex = ++zTop;
    }
  }

  function showTab(name) {
    front(name);
    try { window.localStorage.setItem('deskthing-tab', name); } catch (e) { /* ignore */ }
  }

  // Tapping a window that's behind brings its group forward (via the hash, so
  // the menu bar, hashchange and the saved tab all stay in sync).
  function bindWindow(id, name) {
    var win = byId(id);
    win.addEventListener('click', function () {
      if (win.className.indexOf('back') !== -1) window.location.hash = name;
    }, false);
  }

  for (var g = 0; g < TABS.length; g++) {
    for (var w = 0; w < GROUPS[TABS[g]].length; w++) bindWindow(GROUPS[TABS[g]][w], TABS[g]);
  }

  window.addEventListener('hashchange', function () { showTab(currentTab()); }, false);

  // Initial pile: weather at the back, then lab, music on top; then the saved tab.
  front('weather');
  front('lab');
  front('music');
  showTab(currentTab());

  // ---- clock + progress (every second) ----

  function tick() {
    setText(el.clock, hhmm(serverNow()));
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
    setMeter(el.bar, pos / track.durationMs * 100);
    setText(el.elapsed, formatTime(pos));
    setText(el.duration, formatTime(track.durationMs));
  }

  // ---- Music ----

  // The image is hidden with visibility (not display:none): old Mobile Safari
  // may never load an image that is display:none, so onload would never fire.
  var COVER_RETRIES = 3;
  var coverSrc = null;
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

  function renderMusic(s) {
    track = s.track || null;
    if (track) {
      el.now.className = track.isPlaying ? 'is-playing' : 'is-paused';
      setText(el.playState, s.spotify === 'error' ? 'Last seen' : (track.isPlaying ? 'Playing' : 'Paused'));
      setText(el.title, track.title);
      setText(el.artist, track.artist);
      setText(el.album, track.album);
      show(el.empty, false);
      show(el.now, true); // show before setting src (see setCover)
      setCover(track.cover);
    } else {
      setCover(null);
      show(el.now, false);
      show(el.empty, true);
      setText(el.empty, EMPTY_TEXT[s.spotify] || EMPTY_TEXT.ok);
    }
  }

  // ---- Lab ----

  function renderLab(lab) {
    if (!lab) return;
    setText(byId('lab-host'), lab.host || 'Mac mini');
    setText(byId('lab-uptime'), formatUptime(lab.uptime || 0));
    setText(byId('lab-cpu'), lab.cpu + '%');
    setMeter(byId('lab-cpu-bar'), lab.cpu);
    setText(byId('lab-load'), lab.load.join('  '));

    // No temperature source (no macmon, or running in a container): hide the row.
    var hasTemp = lab.temp !== null && lab.temp !== undefined;
    // '' falls back to the default display (table-row); 'block' would break the table.
    byId('lab-temp-row').style.display = hasTemp ? '' : 'none';
    if (hasTemp) {
      setText(byId('lab-temp'), lab.temp + '°C');
      setMeter(byId('lab-temp-bar'), (lab.temp - 30) / 70 * 100); // 30-100 °C scale
    }

    renderDocker(lab);
  }

  // "Up 7 days (healthy)" -> "7d · healthy", "Exited (137) 3 months ago" -> "exit 137 · 3mo"
  function shortStatus(s) {
    return String(s || '')
      .replace(/^Up /, '')
      .replace(/^Exited \((\d+)\)/, 'exit $1 ·')
      .replace(/About an? (hour|minute)/, '1 $1')
      .replace(/Less than a second/, '<1 second')
      .replace(/ ago$/, '')
      .replace(/ seconds?\b/, 's')
      .replace(/ minutes?\b/, 'm')
      .replace(/ hours?\b/, 'h')
      .replace(/ days?\b/, 'd')
      .replace(/ weeks?\b/, 'w')
      .replace(/ months?\b/, 'mo')
      .replace(/ years?\b/, 'y')
      .replace(/ \((healthy|unhealthy)\)/, ' · $1')
      .replace(/ \(health: starting\)/, ' · starting');
  }

  function renderDocker(lab) {
    var list = lab.containers || [];
    var err = byId('docker-error');
    if (lab.dockerError) {
      setText(err, 'Docker: ' + lab.dockerError);
      show(err, true);
    } else {
      show(err, false);
    }

    var sig = '';
    var up = 0;
    for (var i = 0; i < list.length; i++) {
      sig += list[i].name + '|' + list[i].status + '\n';
      if (list[i].ok) up++;
    }
    var down = list.length - up;
    setText(byId('docker-summary'), up + ' up' + (down ? ' · ' + down + ' down' : '') + ' · ' + list.length + ' total');
    if (sig === dockerSignature) return;
    dockerSignature = sig;

    var box = byId('docker-list');
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      var row = document.createElement('div');
      row.className = c.ok ? 'ct' : 'ct down';

      var radio = document.createElement('span');
      radio.className = c.state === 'running' ? 'radio on' : 'radio';
      var status = document.createElement('span');
      status.className = 'ct-status';
      setText(status, shortStatus(c.status));
      var name = document.createElement('span');
      name.className = 'ct-name';
      setText(name, c.name);

      row.appendChild(radio);
      row.appendChild(status); // floated right, so it comes before the name
      row.appendChild(name);
      box.appendChild(row);
    }
    show(box, list.length > 0);
  }

  // ---- Weather ----

  function iconSrc(name) {
    return '/img/wx-' + name + '.png';
  }

  function renderWeather(w, error) {
    var errBox = byId('wx-error');
    if (error && !w) {
      setText(errBox, 'Can’t reach the weather service right now.');
      show(errBox, true);
    } else {
      show(errBox, false);
    }
    if (!w) return;

    setText(byId('wx-place'), w.place);
    var icon = byId('wx-icon');
    var src = iconSrc(w.icon);
    if (icon.getAttribute('src') !== src) {
      icon.onload = function () { icon.style.visibility = 'visible'; };
      icon.src = src;
    }
    setText(byId('wx-temp'), degrees(w.temp));
    setText(byId('wx-label'), w.label);
    setText(byId('wx-feels'), degrees(w.feels));
    setText(byId('wx-wind'), w.wind + ' km/h ' + w.windDir);
    setText(byId('wx-humidity'), w.humidity + '%');
    setText(byId('wx-updated'), 'Updated ' + hhmm(w.updatedAt));

    var sig = '';
    for (var i = 0; i < w.days.length; i++) {
      var d = w.days[i];
      sig += d.dow + d.icon + d.max + d.min + d.rain + '|';
    }
    if (sig === daysSignature) return;
    daysSignature = sig;

    var box = byId('wx-days');
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var j = 0; j < w.days.length && j < 4; j++) {
      var day = w.days[j];
      var col = document.createElement('div');
      col.className = 'day';

      var dow = document.createElement('div');
      dow.className = 'day-dow';
      setText(dow, day.dow);
      var img = document.createElement('img');
      img.src = iconSrc(day.icon);
      img.alt = day.label;
      img.width = 32;
      img.height = 32;
      var temps = document.createElement('div');
      setText(temps, degrees(day.max) + ' / ' + degrees(day.min));
      var rain = document.createElement('div');
      rain.className = 'day-rain';
      setText(rain, day.rain === null ? '' : day.rain + '% rain');

      col.appendChild(dow);
      col.appendChild(img);
      col.appendChild(temps);
      col.appendChild(rain);
      box.appendChild(col);
    }
  }

  // ---- state ----

  function render(s) {
    if (typeof s.serverTime === 'number') clockOffset = s.serverTime - now();
    if (typeof s.version !== 'number') return; // heartbeat
    lastVersion = s.version;
    renderMusic(s);
    renderLab(s.lab);
    renderWeather(s.weather, s.weatherError);
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
        setConn('off');
        schedulePoll(POLL_ERROR_DELAY);
        return;
      }
      setConn('poll');
      handleData(text);
      schedulePoll(POLL_DELAY);
    });
  }

  function startPolling() {
    if (mode === 'poll') return;
    stopSSE();
    mode = 'poll';
    setConn('wait');
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
    setConn('wait');

    es.onmessage = function (e) {
      errors = 0; // reset only on real data, so open-then-drop loops still fall back
      setConn('live');
      kickWatchdog();
      handleData(e.data);
    };

    es.onerror = function () {
      errors++;
      setConn('wait');
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
