// YouVote service worker — network-first.
// Bump CACHE_NAME on any deploy that must force-evict old cached files.
// (Network-first, not cache-first: this app is actively iterated on, and a
// cache-first worker would keep serving a stale version forever once a
// device had loaded it once, even after a real bug fix ships.)
const CACHE_NAME = 'youvote-v23';
const PRECACHE = ['/', '/index.html', '/manifest.json'];

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
  if (event.request.method !== 'GET') return;
  const isDocument = event.request.mode === 'navigate' || event.request.destination === 'document';
  event.respondWith(
    fetch(event.request, isDocument ? { cache: 'no-store' } : {})
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
