// Service worker : garde une copie de l'appli pour démarrer vite et jouer en local sans réseau
const CACHE = 'brumes-__BUILD__';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './fonts/fredoka.woff2', './fonts/nunito.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Réseau d'abord (pour recevoir les mises à jour), copie locale si pas de réseau
  e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
    .catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
});
