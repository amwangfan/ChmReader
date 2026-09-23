const CACHE = 'ruledesk-shell-v1.3.6';
const SHELL = [
  './', './index.html', './style.css', './app.js', './chm-worker.js',
  './engine/chm.js', './engine/lzx.js', './engine/codec.js',
  './ruledesk/', './ruledesk/index.html', './ruledesk/ruledesk.css', './ruledesk/ruledesk.js',
  './ruledesk/library.js', './ruledesk/index-worker.js', './manifest.webmanifest',
  './icons/ruledesk-192.png', './icons/ruledesk-512.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('ruledesk-shell-')).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(caches.match(request).then((cached) => {
    const network = fetch(request).then((response) => {
      if (response.ok && (request.destination === 'document' || request.destination === 'script' || request.destination === 'style' || request.destination === 'manifest' || request.destination === 'image')) {
        const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    });
    return cached || network.catch(() => request.mode === 'navigate' ? caches.match('./ruledesk/index.html') : Response.error());
  }));
});
