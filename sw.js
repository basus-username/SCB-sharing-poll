// YouVote service worker — network-first with a short timeout.
// Bump CACHE_NAME on any deploy that must force-evict old cached files.
// (Network-first, not cache-first: this app is actively iterated on, and a
// cache-first worker would keep serving a stale version forever once a
// device had loaded it once, even after a real bug fix ships.)
// YV-19 (offline): after NETWORK_TIMEOUT_MS without a response the cached copy
// is served instead (weak signal falls back fast; fresh when online). Page
// navigations match the cache with ignoreSearch, so a poll link
// (/?poll=xyz) that was never opened under that exact URL still opens offline.
// Firestore and /api/ traffic is never touched by this worker.
const CACHE_NAME = 'youvote-v40';
const PRECACHE = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'firestore.googleapis.com' || url.pathname.startsWith('/api/')) return;

  const isDocument = req.mode === 'navigate' || req.destination === 'document';
  // Exact URL first (newest copy of that page), then any search string.
  const fromCache = () =>
    caches.match(req).then((hit) => hit || (isDocument ? caches.match(req, { ignoreSearch: true }) : undefined));

  const network = fetch(req, isDocument ? { cache: 'no-store' } : {}).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      // Documents are all the same index.html, so also refresh '/', which the
      // ignoreSearch fallback matches first; keeps it from going stale.
      const copy2 = isDocument ? res.clone() : null;
      caches.open(CACHE_NAME).then((cache) => {
        cache.put(req, copy);
        if (copy2) cache.put('/', copy2);
      }).catch(() => {});
    }
    return res;
  });
  // keep the worker alive so the cache refresh finishes even if the cached copy won the race
  event.waitUntil(network.catch(() => {}));

  event.respondWith(new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => { fromCache().then((hit) => { if (hit) finish(hit); }); }, NETWORK_TIMEOUT_MS);
    network.then((res) => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); fromCache().then((hit) => finish(hit || Response.error())); });
  }));
});
