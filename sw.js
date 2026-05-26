const CACHE = 'naruto-quiz-v1';
const ASSETS = [
  './',
  './index.html',
  './src/app.js',
  './src/style.css',
  './src/ui/question-feedback.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

// Always fetch fresh from network (no cache) for these critical files
const NETWORK_FIRST = [
  '/index.html',
  '/src/app.js',
  '/src/style.css',
];

function isNetworkFirst(request) {
  try {
    const url = new URL(request.url);
    return NETWORK_FIRST.some(p => url.pathname.endsWith(p))
      || url.pathname.startsWith('/data/');
  } catch {
    return false;
  }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (isNetworkFirst(e.request)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
