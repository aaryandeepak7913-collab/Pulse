# Pulse — TV Remote (LG UR7500PSC + OnePlus, both for real)

A slick dark-UI web remote with a D-pad, volume/channel rockers, on-screen
keypad and keyboard, PWA support (installs, works offline), and **real**
device control for both TVs — no simulated/demo pairing anywhere.

## What actually works

| TV                          | Status                                                                 |
|------------------------------|-------------------------------------------------------------------------|
| **LG UR7500PSC (65″)**        | Real control, straight from this page over your **Wi-Fi** (not Bluetooth), using LG's webOS "SSAP" protocol — the same one LG's own Magic Remote / ThinQ app use. |
| **OnePlus Y-Series (32″)**     | Real control too, but not directly from the browser — it goes through the small local **[Pulse relay](relay/)**, which speaks Google's Android TV Remote v2 protocol for real and exposes it over plain HTTP. See [`relay/README.md`](relay/README.md) to set it up. |

If a connection fails, the status pill just shows "Not paired" and a toast
explains why. Nothing is simulated.

### Connecting to the LG TV

1. Tap the status pill → **Add a new TV** → **LG UR7500PSC**.
2. Find the TV's IP: **Settings → All Settings → Network → Wi-Fi Connection → Advanced**.
3. Type the IP and tap **Connect**.
4. Watch the TV screen — it'll show an on-screen prompt asking you to allow
   the connection. Accept it there. That's LG's own security gate, not
   something this app can skip.
5. Once accepted, the TV hands back a `client-key` which gets saved locally
   so future connections reconnect silently, without a prompt on the TV.

**One browser quirk to know:** if this app is hosted over `https://` (e.g.
GitHub Pages), browsers block plain `ws://` connections to your TV's local
IP (mixed-content rules). LG TVs also serve a secure `wss://` port (3001)
with a self-signed certificate, so the first time, visit
`https://<TV-IP>:3001` directly in the same browser and accept the
certificate warning — after that, the app's `wss://` connection to the TV
will go through.

### Connecting to the OnePlus TV (Android/Google TV, via the relay)

Google's Android TV Remote protocol is a raw TCP connection with TLS and
protobuf framing — there's no browser API that opens a socket like that
from a web page, and there's no Bluetooth path either (the TV doesn't
accept remote commands over classic Bluetooth from a phone/browser). This
app doesn't pretend around that: instead, a small local service —
**[the Pulse relay](relay/)** — actually speaks that protocol, and this
page talks to *it* over plain HTTP.

1. Set up and start the relay once (full details in
   [`relay/README.md`](relay/README.md)):
   ```
   cd relay
   npm install
   npm start
   ```
2. In Pulse, tap the status pill → **Add a new TV** → **OnePlus Y-Series**.
3. Enter the TV's IP (from its network settings) and the relay's address
   (`http://localhost:8787` if the relay is running on the same machine
   you're browsing from).
4. Tap **Connect**. The TV will show a pairing code on screen — type it
   into Pulse when asked. That's Google's own pairing security gate, same
   as the official Google TV app; the relay can't skip it.
5. Once paired, the relay remembers the TV's certificate on disk, so future
   connections reconnect without asking for the code again — the same idea
   as the LG side's `client-key`, just held by the relay instead of the
   browser.

**Same mixed-content quirk as LG, one extra option:** if Pulse is hosted
over `https://` and the relay runs on a *different* device than the one
you're browsing from, the browser blocks the plain `http://` relay calls.
Either run the relay on the same device you're browsing from (`localhost`
is exempt from that rule), or start the relay with `--https` and accept
its self-signed certificate once, the same way you would for the LG TV's
`wss://` port. Full explanation in [`relay/README.md`](relay/README.md).

Power-on, D-pad, volume/mute, the keyboard, and the Netflix/YouTube
shortcuts are all real for the OnePlus TV through this path. Channel
+/- and input-switch depend on what the TV's own firmware does with those
keys — see the relay README's support table for the honest breakdown.

## Files

| File            | What it is                                              |
|-----------------|----------------------------------------------------------|
| `index.html`    | Markup only — links the CSS, JS, and manifest below       |
| `style.css`     | All styling and animations                                |
| `app.js`        | All behavior: LG webOS control, OnePlus-via-relay control, modal flows, drawers, storage, SW registration |
| `manifest.json` | PWA metadata — name, colors, icons — so it's installable   |
| `sw.js`         | Service worker — caches the app shell for offline use, and passes relay calls straight through uncached |
| `icon-192.png`, `icon-512.png` | App icons referenced by the manifest         |
| `relay/`        | Separate small Node.js backend that gives the OnePlus TV real control — see [`relay/README.md`](relay/README.md) |

## Host it on GitHub Pages (2 minutes)

1. Create a new GitHub repo (public).
2. Add all the files above to the repo root, keeping their names as-is.
3. Go to **Settings → Pages**, set "Deploy from a branch," pick `main` / root, save.
4. GitHub gives you a URL like `https://yourname.github.io/repo-name/`.

Opening it on Android Chrome will then offer "Add to Home Screen" / "Install
app" thanks to the manifest and service worker.

GitHub Pages only hosts static files — it won't run `relay/`. That piece
is a real Node.js server and needs to run somewhere on your own network
(see the OnePlus section above); it's included in the repo for convenience,
not deployed by Pages.

## How "remembered TVs" works

- A TV is only saved to `localStorage` **after a real, successful connection**
  — for LG that's the name, IP, and webOS `client-key`; for OnePlus it's the
  name, IP, and the relay address (the TV's own pairing certificate stays
  on the relay, not in the browser). Nothing is stored on a failed or fake
  attempt, for either TV.
- On page load, if any TVs are remembered, a modal asks which one to
  reconnect to (or lets you add a new one).
- `localStorage` is per-browser, per-device — it won't sync between your
  phone and laptop. For OnePlus, the relay's pairing certificate is also
  tied to whichever machine runs the relay — reconnecting from a different
  browser still needs that same relay reachable.

## Known real-world limits

There's no single Wi-Fi or Bluetooth protocol every TV brand speaks. LG
webOS is controlled directly from the browser; OnePlus/Android TV needs the
small local relay because its protocol isn't something a browser can open
on its own. A Samsung Tizen set, or any other brand, would need its own
control path added the same way — this app is honest about which ones it
currently has.
