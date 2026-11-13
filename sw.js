/* Haze Tracker service worker: offline app shell + background haze checks + notification clicks. */
importScripts('shared.js');

const CACHE = 'haze-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'shared.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Same-origin shell: network first (so updates arrive), fall back to cache offline.
// Cross-origin requests (the NEA API) are never intercepted.
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
      })
  );
});

async function checkAndNotify() {
  const settings = await Haze.loadSettings();
  if (!settings.enabled) return;
  const data = await Haze.fetchHazeData();
  const result = Haze.evaluateAlert(settings, data);
  if (result.newState !== settings.lastState) {
    settings.lastState = result.newState;
    await Haze.saveSettings(settings);
  }
  if (result.notify) {
    const msg = Haze.describeAlert(settings, result);
    await self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/favicon-32.png',
      tag: 'haze-alert',
      renotify: true,
      data: { url: './' }
    });
  }
}

// Chrome on Android (installed PWA) fires this periodically, even when the app is closed.
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'haze-check') event.waitUntil(checkAndNotify().catch(function () {}));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
