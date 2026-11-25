# DeskThing

A small page that shows **what's playing on your Spotify right now**: cover, title, artist, a live progress bar and a clock. It's built for old iPods and iPhones running **iOS 5–6 (Mobile Safari 5.1/6, 320×480)**, such as an iPod Touch 3rd/4th gen, and served over **plain HTTP** from a Mac mini.

The iPod never talks to Spotify; it can't, because its TLS is too old. The Node server polls the Spotify Web API and pushes changes to the iPod with Server-Sent Events, or with XHR long-polling when SSE isn't available. Album art is fetched by the server and served over HTTP too.

```
iPod (HTTP) ──SSE / long-poll──▶ Node server on the Mac mini ──HTTPS──▶ Spotify Web API
```

## Project layout

```
server.js          HTTP server: static files, /api/state, /api/events, /api/cover (no dependencies)
spotify.js         Spotify client: token refresh + currently-playing
spotify-auth.js    One-time login helper that saves a refresh token
public/
  index.html       Single page
  style.css        CSS2 + -webkit- prefixed CSS3
  app.js           ES5 client: EventSource with an XHR long-poll fallback
Dockerfile
docker-compose.yml
.env.example       Spotify credentials template (copy to .env)
data/              Holds spotify-token.json (gitignored)
```

## 1. Connect Spotify (one time)

1. Go to <https://developer.spotify.com/dashboard>, **Create app**, choose **Web API**, and add this Redirect URI exactly:
   `http://127.0.0.1:8889/callback`
   (Spotify accepts plain HTTP redirects only for loopback IPs, so use `127.0.0.1`, not `localhost`.)
2. Copy the env file and fill in the app's Client ID and Client Secret:
   ```bash
   cp .env.example .env
   ```
3. Log in once. **On the Mac mini itself** (the redirect goes to 127.0.0.1), run one of these:
   - With Node installed:
     ```bash
     npm run spotify-auth
     ```
   - With Docker only:
     ```bash
     docker compose run --rm -p 127.0.0.1:8889:8889 -e AUTH_LISTEN_HOST=0.0.0.0 deskthing node spotify-auth.js
     ```
   Open the URL it prints, approve, and the refresh token lands in `data/spotify-token.json`. A running server picks it up without a restart.

The only scopes requested are `user-read-currently-playing` and `user-read-playback-state`. These are read-only, so the page can't control your playback. The Client Secret and the token stay on the server and are never sent to the iPod.

## 2. Run it

**Docker (recommended on the Mac mini):**

```bash
docker compose up -d --build
```

**Or directly with Node 22.9+:**

```bash
npm start
```

Configuration (environment or `.env`):

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | Listening port (in Docker: the host port) |
| `HOST` | `0.0.0.0` | Bind address |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | – | From your Spotify app |
| `SPOTIFY_REFRESH_TOKEN` | – | Optional; `data/spotify-token.json` wins |
| `DATA_DIR` | `./data` | Where the token file lives |
| `LOG_REQUESTS` | off | `1` logs every request (client IP, path, status, time) |

## 3. Open it on the iPod

1. Find the Mac mini's LAN IP:
   ```bash
   ipconfig getifaddr en0
   ```
   (Use `en1` if it's on Wi-Fi and `en0` returns nothing.)
2. On the iPod, open Safari and go to `http://<LAN-IP>:8080`. Type the `http://` yourself.
3. Optional: **Share → Add to Home Screen**. It then opens full screen without Safari's bars.
4. For a desk display, set **Settings → General → Auto-Lock → Never** and keep it plugged in.

If it doesn't load, check that macOS Firewall allows incoming connections for Docker or `node`. The dot at the bottom of the page shows the connection: green means live (SSE), yellow means polling fallback, red means offline. To try the fallback on a modern browser, add `?poll=1` to the URL.

## 4. Optional: a separate HTTP-only subdomain

Put a reverse proxy in front on port 80 and give it a hostname such as `deskthing.home.lan`. Rules that matter for the iPod:

- **Plain HTTP only.** No redirect to HTTPS and no `Strict-Transport-Security` header.
- **Don't use a domain that forces HTTPS.** TLDs like `.dev`, `.app` and `.page` are on the browser HSTS preload list. Also, if your parent domain sends HSTS with `includeSubDomains`, browsers that have visited it force HTTPS for every subdomain. A local-only name (`.lan`, `.home.arpa`, or a Pi-hole / router DNS record) avoids both.
- **Don't buffer the SSE stream.** If the proxy buffers anyway, the client notices and falls back to polling after about 40 s, but disabling buffering keeps it live.
- **No keep-alive towards the iPod.** iOS 5/6 Safari pipelines requests: it queues new ones on an open connection. If the proxy keeps the iPod's connection alive, the album art gets queued behind the never-ending SSE stream and never loads. DeskThing itself sends `Connection: close` for this reason, but a proxy manages its own client connections, so it must do the same.

**Caddy:** the `http://` prefix turns off automatic HTTPS and its redirect for this site. The `header` line asks Go's HTTP server to close each connection after the response. That's untested here, so check on the iPod that the album art loads. If it doesn't, use nginx.

```
http://deskthing.home.lan {
    header Connection close
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}
```

**nginx:**

```nginx
server {
    listen 80;
    server_name deskthing.home.lan;
    # no "return 301 https://...", no add_header Strict-Transport-Security
    keepalive_timeout 0;              # no pipelining from iOS 5/6 (see above)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_buffering off;          # SSE
        proxy_read_timeout 1h;        # long-lived SSE / long-poll connections
    }
}
```

Then point `deskthing.home.lan` at the Mac mini's LAN IP in your router or Pi-hole DNS. If you use Cloudflare or a similar CDN for a public name, turn off "Always Use HTTPS" and HSTS for that hostname. Better still, keep it LAN-only.

The site is unencrypted and has no login. It only shows what you're listening to, and anyone who can reach it can see that.

## How live updates work

- `GET /api/events` is the SSE stream. It sends the full state on every change and a heartbeat every 15 s.
- `GET /api/state?since=<version>` is the long-poll endpoint. It answers immediately if the version changed, and otherwise holds the request for up to 25 s.
- The client uses `EventSource` if `window.EventSource` exists. It switches to long-polling after 3 errors without data, when the browser closes the stream for good, or when nothing has arrived for 40 s. Failed polls retry every 4 s.
- The server polls Spotify every 5 s while music plays (15 s while idle) and pushes only real changes: a new song, play/pause, or a seek. The iPod animates the progress bar itself, using the server's clock.
- Every response sends `Connection: close`. Old Mobile Safari pipelines requests onto keep-alive connections, so without this the album art would be queued behind the SSE stream forever. On a LAN, a new connection per request costs practically nothing.
- The live connection opens only after the page's `load` event, so old Safari doesn't show a loading spinner forever.
- All API responses send `Cache-Control: no-store, no-cache`, `Pragma: no-cache`, `Expires: 0`, and the client adds a `_=<timestamp>` cache-buster to every XHR.

## Features deliberately avoided

**JavaScript (ES5 for Safari 5.1)**
- `let`/`const`, arrow functions, template literals, classes, modules, destructuring, spread, default parameters
- `fetch`, `Promise`, `async`/`await`
- `Function.prototype.bind`, which Safari 5.1 doesn't have
- `element.classList`, replaced with `className`
- `XMLHttpRequest.timeout` and `onload`/`onerror` on XHR. The client uses `onreadystatechange` with a manual `setTimeout` + `abort()`
- `innerHTML` for track data. `textContent` only, since song titles are untrusted input
- Named SSE events (`addEventListener('ping')`). Heartbeats are plain `message` events
- `localStorage`, Page Visibility API, `requestAnimationFrame`, `Date.now()` (uses `new Date().getTime()`), `toLocaleTimeString` (output differs between devices)
- WebSockets, because iOS 5 only speaks the obsolete Hixie-76 protocol
- User-agent sniffing. The client feature-detects `EventSource`
- Polyfills, frameworks, bundlers, npm frontend packages

**CSS**
- Flexbox (including old `-webkit-box`, which wasn't needed), CSS grid, custom properties, `calc()`, `vh`/`vw`, `rem`
- Unprefixed-only CSS3. `border-radius` and `box-shadow` come with `-webkit-` versions, the gradient uses the old `-webkit-gradient()` syntax with a solid fallback colour, and the transition is `-webkit-transition`
- `position: fixed`, which is buggy on iOS 5, and hover-only interactions
- Web fonts. Helvetica is built in

**Network**
- HTTPS, HSTS and redirects of any kind
- Loading anything from third-party HTTPS hosts on the page. Album art is proxied through the server
