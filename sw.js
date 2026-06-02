/* Gas Tracker — service worker (app-shell, cache-first for static assets + Web Push) */
const CACHE = 'gastracker-v0.6.0';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/data/prices.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't cache cross-origin (fonts CDN, etc.)

  // Cache-first for static assets; fall back to network and populate cache.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline fallback for navigations -> app shell
          if (req.mode === 'navigate') return caches.match('/index.html');
          return new Response('', { status: 504, statusText: 'Offline' });
        });
    })
  );
});

/* ===== Web Push: price-alert notifications =====
 * The server sends an encrypted push payload shaped as
 *   { title, body, data: { url, ... } }
 * We never receive raw coordinates here; geofence matching happens server-side
 * against the coarse `region` the client supplied (see index.html — Law 25 note).
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Non-JSON or empty payload — degrade to a generic notification, never throw.
    payload = { title: 'Gas Tracker', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Gas Tracker';
  const data = payload.data || {};
  const options = {
    body: payload.body || '',
    data: data,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Group alerts for the same station/alert so repeats replace rather than stack.
    tag: data.tag || payload.tag || 'gastracker-alert',
    renotify: false
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open app window if we have one.
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ('focus' in client) {
          if ('navigate' in client && targetUrl !== '/') {
            return client.focus().then(() => client.navigate(targetUrl)).catch(() => client.focus());
          }
          return client.focus();
        }
      }
      // Otherwise open a new window.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
