// © 2026 ikezos. All rights reserved. 無断の転用・複製を禁じます
// オフラインで画面を開けるようにする簡易キャッシュ(地図の下絵は対象外)。
// 通信できるときは常に最新を取りに行き(取れたら控えを更新)、通信できないときだけ控えを使う。
// 20261027-0731: ブラウザの控え(公開先の決まりで最大10分)を通さず、毎回サーバーに確かめる(cache: 'no-cache')。公開の直後に index.html と app.js の版が食い違って起動の途中で止まったため。
// 入れる時(install)の控えも、ブラウザの控えを通さずに取る(cache: 'reload')。版の揃った控えにする。
// 20261027-0734: 毎回確かめるのは自分のサイトの画面・プログラム・見た目・設定(html・js・css・json)だけ。画像・PDF・lib/ は重いので前のまま(ブラウザの控えを使ってよい)。
// 新しい版は、前の版が「新しい版があります」を出せる版(v23 から)なら、画面の「更新」が押されるまで待つ。前の版が v22 までなら、前と同じくすぐ入れ替わる(古い画面には知らせの置き場が無いため)。
// 20261027-0820: 版の混ざりを起こさない作り。index.html は js・css を「?v=版」付きで読み、sw は版ごとの組で控える(新しい組が全部揃ってから入れ替わる)。
// 「?v=」付きの物は、同じ名前の控えがあれば、ネットに聞かずにすぐ出す(古い index.html は古い組・新しい index.html は新しい組を、必ず組で読む)。前の版の組も1つ残す。
// 画面(index.html)はネットに確かめるが、電波が弱くて3秒で返らなければ控えを出す(前は上限が無く、電波の弱い所で起動が止まった)。
// 20261027-0851: 入れ替えの決まりは画面(app.js)の側で決める。起動の直後なら自動で1回・使っている途中は「更新」を押すまで待つ(sw は前と同じく skipWaiting の知らせを待つ)。
// 20261027-1051: 毛色の見本の写真(img/coat/・14色×小と大×WebP と JPEG)も入れる時に控える(電波なしでも出す)。
// 20261027-1640: 中身が変わる物(説明書の PDF・使い方の画像・毛色の写真)も「?v=版」付きで読む。同じ名前のまま中身が変わると、古い控えが出続けたため(版が上がれば名前が変わり、必ずネットから取る)。
const VER = 32, CACHE = 'cat-survey-v' + VER, NET_WAIT_MS = 3000;
const COAT = ['kijitora', 'kijishiro', 'kuroshiro', 'kuro', 'mike', 'chatora', 'chashiro', 'sabatora', 'sabashiro', 'sabi', 'shiro', 'hai', 'haishiro', 'siam'].flatMap(n => ['', '-l'].flatMap(s => ['webp', 'jpg'].map(x => `./img/coat/${n}${s}.${x}`)));
const PLAIN = ['./', './index.html', './help.html', './manifest.json', './icon-192-v30.png', './icon-512-v30.png', './icon-maskable-192-v30.png', './icon-maskable-512-v30.png', './apple-touch-icon-v30.png', './favicon-32-v30.png', './favicon-16-v30.png', './lib/images/layers.png', './lib/images/layers-2x.png'];
const PAIRED = ['./app.js', './config.js', './style.css', './scan.js', './lib/leaflet.css', './lib/leaflet.js', './lib/qr.js', './lib/jsQR.js', './lib/leaflet.markercluster.js', './lib/MarkerCluster.css'].concat(COAT).map(f => f + '?v=' + VER);
const FILES = PLAIN.concat(PAIRED);
const verNum = k => { const m = /^cat-survey-v(\d+)$/.exec(k); return m ? +m[1] : 0; };
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))   // 全部揃わなければ入れ替わらない
  .then(() => Promise.all([caches.keys(), self.clients.matchAll({ type: 'window', includeUncontrolled: true })]))
  .then(([ks, cs]) => {
    const aware = ks.some(k => k !== CACHE && verNum(k) >= 23);   // 前の版が「更新」を出せる版か
    if (!self.registration.active || !aware || !cs.length) return self.skipWaiting();   // 初めて・前が v22 まで・開いている画面が無い時は、すぐ入れ替わる
  })));
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'skipWaiting') self.skipWaiting();   // 画面の「更新」が押された
  else if (d.type === 'ver' && e.ports[0]) e.ports[0].postMessage(CACHE);
});
// 今の版と、すぐ前の版(公開の直後に古い index.html が来た時の組)だけ残す
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => {
  const prev = ks.filter(k => k !== CACHE && verNum(k) > 0 && verNum(k) < VER).sort((a, b) => verNum(b) - verNum(a))[0];
  return Promise.all(ks.filter(k => k !== CACHE && k !== prev).map(k => caches.delete(k)));
}).then(() => self.clients.claim())));
const FRESH = /(\/|\.html|\.js|\.css|\.json)$/;   // 毎回サーバーに確かめるもの(lib/ を除く)
const inTime = (p, ms) => new Promise((ok, ng) => { const t = setTimeout(() => ng(new Error('slow')), ms); p.then(r => { clearTimeout(t); ok(r); }, x => { clearTimeout(t); ng(x); }); });
const keep = (req, res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const v = u.searchParams.get('v');
  if (v) {   // 版の付いた組: 控え(どの版の控えでも、名前がそのまま合う物)を先に。無ければネットへ(自分の版の物だけ控える)
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request, { cache: 'no-cache' }).then(res => +v === VER ? keep(e.request, res) : res)));
    return;
  }
  const scope = new URL(self.registration.scope).pathname, rel = u.pathname.startsWith(scope) ? u.pathname.slice(scope.length) : u.pathname;
  const nav = e.request.mode === 'navigate', fresh = nav || (FRESH.test(u.pathname) && !rel.startsWith('lib/'));
  const net = nav ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fresh ? fetch(e.request, { cache: 'no-cache' }) : fetch(e.request);
  // 控えは今の版の組を先に見る(20261027-0851: 前は前の版の組が先に当たり、電波なしの起動が1つ前の版になった)
  const mine = req => caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true })).then(r => r || caches.match(req, { ignoreSearch: true }));
  const fromCache = () => mine(e.request).then(r => r || (nav || fresh ? mine('./index.html') : r));
  if (!fresh) { e.respondWith(net.then(res => keep(e.request, res)).catch(() => fromCache().then(r => r || Response.error()))); return; }
  // 画面と確かめる物: 3秒で返らなければ控えを出す(ネットの返事は後で控えに入れる)。控えが無ければネットを待つ
  const netKept = net.then(res => keep(e.request, res)); netKept.catch(() => {});
  e.respondWith(inTime(netKept, NET_WAIT_MS).catch(() => fromCache().then(r => r || netKept)));
});
