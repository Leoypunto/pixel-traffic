// Pixel Traffic — Service Worker v1
// Estrategia: cache-first para assets estáticos, network-first para API

const CACHE_NAME = 'pixel-traffic-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap',
];

// Instalar: cachear assets estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first para /api/*, cache-first para el resto
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API siempre desde la red (datos en tiempo real)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Sin conexión' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Avatares: network-first con fallback a cache
  if (url.pathname.startsWith('/avatars/')) {
    event.respondWith(
      fetch(request)
        .then(res => { caches.open(CACHE_NAME).then(c => c.put(request, res.clone())); return res; })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Assets estáticos: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        }
        return res;
      });
    })
  );
});
