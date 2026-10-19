// Service worker: saves the whole guide on first visit so it works offline.
// The build fills in the version and file list; a new version replaces the old cache.
const CACHE = 'garage-games-__CACHE_VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('garage-games-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Pages: try the network first so edits show up, fall back to the saved copy offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./')))
    );
    return;
  }
  // Everything else: saved copy first, network if missing.
  event.respondWith(caches.match(req).then(r => r || fetch(req)));
});
