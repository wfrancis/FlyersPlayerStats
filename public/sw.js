'use strict';
// Keeps the app itself available with bad or no signal at the rink: try the network first (so updates
// show up right away), fall back to the saved copy. Stats (/api) are never cached here — the page
// keeps its own copy and queues taps.
const CACHE = 'team-stats-shell-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Weak rink signal can leave a request hanging; after a few seconds use the saved copy instead.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? '/' : url.pathname;
  e.respondWith((async () => {
    const network = fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    });
    try {
      return await withTimeout(network, 4000);
    } catch {
      const saved = await caches.match(key);
      return saved || network; // nothing saved yet: keep waiting for the network
    }
  })());
});
