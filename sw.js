// オフラインで画面を開けるようにする簡易キャッシュ(地図の下絵は対象外)。
// 通信できるときは常に最新を取りに行き(取れたら控えを更新)、通信できないときだけ控えを使う。
const CACHE = 'cat-survey-v8';
const FILES = ['./', './index.html', './help.html', './app.js', './config.js', './style.css', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './lib/leaflet.css', './lib/leaflet.js', './lib/qr.js', './lib/images/layers.png', './lib/images/layers-2x.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
