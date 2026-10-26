// オフラインで画面を開けるようにする簡易キャッシュ(地図の下絵は対象外)。
// 通信できるときは常に最新を取りに行き(取れたら控えを更新)、通信できないときだけ控えを使う。
// 20261027-0731: ブラウザの控え(公開先の決まりで最大10分)を通さず、毎回サーバーに確かめる(cache: 'no-cache')。公開の直後に index.html と app.js の版が食い違って起動の途中で止まったため。
// 入れる時(install)の控えも、ブラウザの控えを通さずに取る(cache: 'reload')。版の揃った控えにする。
const CACHE = 'cat-survey-v22';
const FILES = ['./', './index.html', './help.html', './app.js', './config.js', './style.css', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './lib/leaflet.css', './lib/leaflet.js', './lib/qr.js', './lib/jsQR.js', './lib/leaflet.markercluster.js', './lib/MarkerCluster.css', './scan.js', './lib/images/layers.png', './lib/images/layers-2x.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const fresh = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(fresh.then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
