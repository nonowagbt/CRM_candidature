// Service worker : rend l'interface disponible hors ligne.
// - Pages, scripts, styles, icônes : réseau d'abord (toujours la dernière version), cache en secours.
// - API (/api/…) : jamais mise en cache (données personnelles, sessions).
const CACHE = 'crm-shell-v2';
const SHELL = ['/', '/index.html', '/login.html', '/offline.html', '/style.css', '/app.js', '/login.js', '/pwa.js', '/import.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('/offline.html');
      return Response.error();
    }
  })());
});
