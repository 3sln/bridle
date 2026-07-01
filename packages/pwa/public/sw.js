// Minimal service worker: makes the app installable and gives an offline shell.
// Scope is the origin root ('/') even though the app lives at /app/, because the
// app pulls hashed JS and the VAD/ORT wasm from '/assets' and '/', which a
// /app-scoped worker couldn't cache. App-shell precache + network-first for
// navigations (so new deploys win), cache-first for hashed static assets.
// Real-time traffic is P2P/WebSocket and never touches the SW.

const CACHE = 'bridle-v2';
const SHELL = ['/', '/app/', '/app/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch signaling/cross-origin

  if (req.mode === 'navigate') {
    // Offline fallback to the right shell: the app under /app/, else the landing.
    const shell = url.pathname.startsWith('/app') ? '/app/' : '/';
    e.respondWith(fetch(req).catch(() => caches.match(shell)));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })),
  );
});
