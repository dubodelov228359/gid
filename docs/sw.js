// Офлайн для веб-версии (iPhone): само приложение кэшируется при первом открытии.
// Тайлы карты кэширует map.js, здесь — только файлы приложения.
const VERSION = 'tg-app-2026.10.23-1752';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'js/app.js', 'js/store.js', 'js/geo.js', 'js/planner.js', 'js/places.js',
  'js/ai.js', 'js/suggest.js', 'js/flights.js', 'js/map.js', 'js/platform.js', 'js/data-budapest.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'version.json',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо HTTP-кэша браузера, иначе можно сохранить старую версию файла.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tg-app-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сначала сеть (чтобы получать обновления), без сети — из кэша.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: браузер всегда сверяется с сайтом, так обновления видны сразу после выкладки.
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
