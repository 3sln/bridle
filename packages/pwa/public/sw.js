// Minimal service worker: makes the app installable and gives an offline shell.
// Scope is the origin root ('/') even though the app lives at /app/, because the
// app pulls hashed JS and the VAD/ORT wasm from '/assets' and '/', which a
// /app-scoped worker couldn't cache. App-shell precache + network-first for
// navigations (so new deploys win), cache-first for hashed static assets.
// Real-time traffic is P2P/WebSocket and never touches the SW.

const CACHE = 'bridle-v2';
const SHELL = ['/', '/app/', '/app/manifest.webmanifest', '/icon.svg'];

// The Whisper model (tens of MB) is fetched cross-origin from the HF hub. Its
// weight files 302-redirect to a signed CDN URL, and Cache.put rejects a
// redirected response — which is exactly why transformers.js's own cache stores
// only the small configs and the weights re-download every launch. We cache them
// here instead, keyed by the STABLE .../resolve/... URL the SW intercepts (the
// redirect is followed inside our fetch), in a separate, deploy-surviving cache.
const MODEL_CACHE = 'bridle-models-v1';
const isModelRequest = (url) =>
  /(^|\.)(huggingface\.co|hf\.co)$/.test(url.hostname) && url.pathname.includes('/resolve/');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = new Set([CACHE, MODEL_CACHE]);
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isModelRequest(url)) {
    e.respondWith(cacheModel(e, req));
    return;
  }
  if (url.origin !== self.location.origin) return; // other cross-origin: passthrough

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

// Cache-first for model artifacts. On a miss the original response streams to the
// caller immediately; a clone is drained and stored in the background (kept alive
// by waitUntil). We re-wrap it into a fresh response so Cache.put accepts it — the
// redirected flag on the HF CDN response is otherwise rejected — preserving
// headers so the worker's CORS fetch still validates.
async function cacheModel(event, req) {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(req);
  if (hit) {
    return hit;
  }
  const res = await fetch(req);
  if (res.ok) {
    const clone = res.clone();
    event.waitUntil(
      clone.blob().then((body) => cache.put(req, new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }))).catch(() => {}),
    );
  }
  return res;
}
