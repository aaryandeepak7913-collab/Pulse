// Pulse remote — service worker
// Caches the app shell so it opens instantly and works offline once visited.
// Bump CACHE_NAME whenever you change any of the cached files, so old
// visitors pick up the update instead of getting stuck on a stale cache.
const CACHE_NAME = 'pulse-remote-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, falling back to the network (and caching
// what comes back) for anything not already cached. Requests to the Pulse
// relay (OnePlus/Android TV control — a different origin, e.g.
// http://localhost:8787) are passed straight through untouched: they're
// live pairing/status/command calls, not app-shell assets, and caching
// them would risk serving stale pairing state.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
