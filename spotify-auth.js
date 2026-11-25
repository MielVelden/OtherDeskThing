'use strict';

// One-time helper: log in to Spotify on this Mac and save a refresh token for DeskThing.
//
//   npm run spotify-auth
//
// Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (in .env) and the redirect URI
// below registered in your Spotify app's settings.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8889/callback';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'spotify-token.json');
const SCOPES = 'user-read-currently-playing user-read-playback-state';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first (see .env.example).');
  process.exit(1);
}

const redirect = new URL(REDIRECT_URI);
const expectedState = crypto.randomBytes(16).toString('hex');

const authorizeUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state: expectedState
}).toString();

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, REDIRECT_URI);
  if (u.pathname !== redirect.pathname) {
    res.writeHead(404); res.end(); return;
  }

  function finish(status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text + '\n');
    server.close();
  }

  if (u.searchParams.get('state') !== expectedState) return finish(400, 'State mismatch. Run the helper again.');
  if (u.searchParams.get('error')) return finish(400, 'Spotify said: ' + u.searchParams.get('error'));

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: u.searchParams.get('code') || '',
        redirect_uri: REDIRECT_URI
      })
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok || !json.refresh_token) {
      return finish(500, 'Token exchange failed: ' + JSON.stringify(json));
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: json.refresh_token }) + '\n', { mode: 0o600 });
    console.log('Saved refresh token to ' + TOKEN_FILE);
    console.log('DeskThing picks it up automatically (no restart needed).');
    finish(200, 'Done! DeskThing is linked to your Spotify account. You can close this tab.');
  } catch (err) {
    finish(500, 'Token exchange failed: ' + err.message);
  }
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + redirect.port + ' is already in use by another program.');
    console.error('Pick a free port, e.g. put this in .env:');
    console.error('  SPOTIFY_REDIRECT_URI=http://127.0.0.1:8890/callback');
    console.error('and add that exact URI to your Spotify app\'s Redirect URIs.');
    process.exit(1);
  }
  throw err;
});

// Inside Docker the helper must listen on 0.0.0.0 so the published port reaches it.
const listenHost = process.env.AUTH_LISTEN_HOST || redirect.hostname;

server.listen(parseInt(redirect.port, 10) || 80, listenHost, function () {
  console.log('Open this URL in a browser on this Mac and log in to Spotify:\n');
  console.log(authorizeUrl + '\n');
  console.log('Waiting for Spotify to redirect back to ' + REDIRECT_URI + ' ...');
});
