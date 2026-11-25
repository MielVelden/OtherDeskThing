'use strict';

// Homelab stats: host uptime / CPU / load / temperature, and Docker container status.
// Run DeskThing natively on macOS for real host numbers; inside a container the
// `os` module reports the Linux VM instead (marked with inContainer: true).

const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile, exec } = require('child_process');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const TEMP_COMMAND = process.env.TEMP_COMMAND || '';
const DOCKER_IGNORE = (process.env.DOCKER_IGNORE || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const IN_CONTAINER = fs.existsSync('/.dockerenv');

// launchd starts processes with a minimal PATH, so look in the usual places too.
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function findBinary(name, override) {
  if (override) return override;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(EXTRA_PATHS);
  for (let i = 0; i < dirs.length; i++) {
    const p = path.join(dirs[i], name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* keep looking */ }
  }
  return null;
}

// ---- CPU ------------------------------------------------------------------

function cpuTimes() {
  let idle = 0;
  let total = 0;
  os.cpus().forEach(function (c) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  });
  return { idle: idle, total: total };
}

let prevCpu = cpuTimes();

function cpuPercent() {
  const now = cpuTimes();
  const dIdle = now.idle - prevCpu.idle;
  const dTotal = now.total - prevCpu.total;
  prevCpu = now;
  return dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;
}

// ---- Temperature ----------------------------------------------------------
// Apple Silicon has no unprivileged temperature API in Node. Options, in order:
//   1. TEMP_COMMAND: any shell command; the first number it prints is used (°C)
//   2. macmon (brew install macmon): sudoless, made for Apple Silicon
//   3. smctemp -c, osx-cpu-temp (Intel)
// Nothing found means the dashboard shows "n/a".

function firstNumber(text) {
  const m = /-?\d+(\.\d+)?/.exec(text || '');
  return m ? parseFloat(m[0]) : null;
}

// Finds the first numeric value whose key mentions cpu + temp, at any depth.
function findCpuTemp(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k in obj) {
    const v = obj[k];
    if (typeof v === 'number' && /cpu/i.test(k) && /temp/i.test(k)) return v;
  }
  for (const k in obj) {
    const found = findCpuTemp(obj[k]);
    if (found !== null) return found;
  }
  return null;
}

function readTemperature(cb) {
  if (TEMP_COMMAND) {
    exec(TEMP_COMMAND, { timeout: 8000 }, function (err, out) {
      cb(err ? null : firstNumber(out), 'command');
    });
    return;
  }
  const macmon = findBinary('macmon');
  if (macmon) {
    execFile(macmon, ['pipe', '-s', '1', '-i', '500'], { timeout: 8000 }, function (err, out) {
      let t = null;
      if (!err) {
        try { t = findCpuTemp(JSON.parse(String(out).trim().split('\n')[0])); } catch (e) { t = null; }
      }
      cb(t, 'macmon');
    });
    return;
  }
  const smctemp = findBinary('smctemp');
  if (smctemp) {
    execFile(smctemp, ['-c'], { timeout: 8000 }, function (err, out) { cb(err ? null : firstNumber(out), 'smctemp'); });
    return;
  }
  const osxTemp = findBinary('osx-cpu-temp');
  if (osxTemp) {
    execFile(osxTemp, [], { timeout: 8000 }, function (err, out) { cb(err ? null : firstNumber(out), 'osx-cpu-temp'); });
    return;
  }
  cb(null, null);
}

// ---- Docker ---------------------------------------------------------------
// Uses the Docker socket when this process can read it (e.g. mounted into a
// container), otherwise the `docker` CLI, which also works over a remote/ssh
// context such as OrbStack running under another macOS user.

function healthFrom(status) {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status || '');
  if (!m) return null;
  return m[1] === 'health: starting' ? 'starting' : m[1];
}

function normalizeContainers(list) {
  return list
    .filter(function (c) { return DOCKER_IGNORE.indexOf(c.name) === -1; })
    .map(function (c) {
      const health = healthFrom(c.status);
      return {
        name: c.name,
        state: c.state,
        status: c.status,
        health: health,
        ok: c.state === 'running' && health !== 'unhealthy'
      };
    })
    .sort(function (a, b) {
      if (a.ok !== b.ok) return a.ok ? 1 : -1; // problems first
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

function dockerViaSocket(cb) {
  const req = http.get({ socketPath: DOCKER_SOCKET, path: '/containers/json?all=1', timeout: 8000 }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      try {
        const list = JSON.parse(body).map(function (c) {
          return { name: (c.Names && c.Names[0] || '').replace(/^\//, ''), state: c.State, status: c.Status };
        });
        cb(null, list);
      } catch (e) {
        cb(e);
      }
    });
  });
  req.on('timeout', function () { req.destroy(new Error('docker socket timeout')); });
  req.on('error', cb);
}

function dockerViaCli(cb) {
  const docker = findBinary('docker', process.env.DOCKER_BIN);
  if (!docker) { cb(new Error('docker CLI not found')); return; }
  execFile(docker, ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], { timeout: 15000 }, function (err, out) {
    if (err) { cb(err); return; }
    const list = String(out).split('\n').filter(Boolean).map(function (line) {
      const p = line.split('\t');
      return { name: p[0], state: p[1], status: p[2] || '' };
    });
    cb(null, list);
  });
}

function canUseSocket() {
  try { fs.accessSync(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK); return true; } catch (e) { return false; }
}

function readContainers(cb) {
  const via = canUseSocket() ? dockerViaSocket : dockerViaCli;
  via(function (err, list) {
    if (err) { cb(err); return; }
    cb(null, normalizeContainers(list));
  });
}

// ---- Public API -----------------------------------------------------------

function create(onChange) {
  const lab = {
    host: process.env.HOST_LABEL || os.hostname().split('.')[0],
    inContainer: IN_CONTAINER,
    uptime: 0,
    cpu: 0,
    cores: os.cpus().length,
    load: [0, 0, 0],
    temp: null,
    tempSource: null,
    containers: [],
    dockerError: null
  };

  function tickStats() {
    lab.uptime = Math.round(os.uptime());
    lab.cpu = cpuPercent();
    lab.load = os.loadavg().map(function (n) { return Math.round(n * 100) / 100; });
    onChange();
  }

  let tempBusy = false;
  function tickTemp() {
    if (tempBusy) return;
    tempBusy = true;
    readTemperature(function (t, source) {
      tempBusy = false;
      lab.temp = t === null ? null : Math.round(t);
      lab.tempSource = source;
    });
  }

  let dockerBusy = false;
  let lastDockerError = '';
  function tickDocker() {
    if (dockerBusy) return;
    dockerBusy = true;
    readContainers(function (err, list) {
      dockerBusy = false;
      if (err) {
        const msg = String(err.message || err).split('\n')[0].slice(0, 120);
        if (msg !== lastDockerError) console.warn('docker:', msg);
        lastDockerError = msg;
        lab.dockerError = msg;
        return;
      }
      lastDockerError = '';
      lab.dockerError = null;
      lab.containers = list;
    });
  }

  tickTemp();
  tickDocker();
  setTimeout(tickStats, 1000); // first CPU sample needs a baseline
  setInterval(tickStats, 5000);
  setInterval(tickTemp, 15000);
  setInterval(tickDocker, 10000);

  return lab;
}

module.exports = { create };
