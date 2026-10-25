'use strict';
// 地域猫 頭数調査 — 保存は端末の IndexedDB。送信は次の段(GAS)で作る。
const DB_NAME = 'catSurvey', STORE = 'records', OLD_KEY = 'catSurvey.records', CFG = 'catSurvey.config';
const AREAS = ['千種区A地区', '中区B地区', '昭和区C地区', '瑞穂区D地区']; // 試用版の区域(見本)
const AREA_CENTER = { '千種区A地区': [35.1700, 136.9470], '中区B地区': [35.1640, 136.9060], '昭和区C地区': [35.1500, 136.9330], '瑞穂区D地区': [35.1310, 136.9340] };
const FIELDS = [
  ['color', '毛色・模様', ['茶トラ', 'キジトラ', 'サバトラ', '黒', '白', '三毛', 'サビ', 'ハチワレ', '茶白', 'キジ白', 'サバ白', 'ポインテッド', 'その他'], 'ポインテッド=顔・耳・足・尻尾だけ色が濃い猫'],
  ['ear', 'さくら耳', ['右', '左', 'なし', '確認できず'], '耳の先が桜の花びらの形に切ってある印(不妊手術が済んだ猫)。どちらの耳か選んでください'],
  ['managed', '地域猫として世話されているか', ['されている', 'いない', '不明']],
  ['feeder', '餌をあげている人', ['いる', 'いない', '不明']],
  ['age', '年齢のめやす', ['子猫(半年未満)', '若い(1歳前後)', '成猫', '老猫', '不明']],
  ['sex', '性別', ['オス', 'メス', '不明']],
  ['body', '体の様子', ['良好', 'やせ', '太り気味', 'けが・病気の疑い']],
  ['tail', '尻尾', ['長い', '短い', 'かぎ型', 'なし'], 'かぎ型=先が曲がっている'],
  ['tame', '人への慣れ', ['近寄る', '距離を保つ', '逃げる']],
  ['collar', '首輪(任意)', ['あり', 'なし', '不明']],
];
const REQUIRED = FIELDS.slice(0, 9).map(f => f[0]);
const UNKNOWN_EAR = '確認できず';
const MAX_PHOTOS = 3, MAX_SIDE = 1600;

const $ = s => document.querySelector(s);
const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG) || '{}'); } catch { return {}; } };
const saveCfg = p => localStorage.setItem(CFG, JSON.stringify({ ...cfg(), ...p }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasEar = r => r.ear === '右' || r.ear === '左';
const fmt = t => new Date(t).toLocaleString('ja-JP');

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- IndexedDB ----
const dbp = new Promise((ok, ng) => {
  const q = indexedDB.open(DB_NAME, 1);
  q.onupgradeneeded = () => { const s = q.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('status', 'status'); };
  q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error);
});
const run = (mode, fn) => dbp.then(db => new Promise((ok, ng) => {
  const t = db.transaction(STORE, mode), r = fn(t.objectStore(STORE));
  t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => ng(t.error || new Error('保存に失敗しました'));
}));
const allRecords = () => run('readonly', s => s.getAll());
const putAll = rs => run('readwrite', s => { rs.forEach(r => s.put(r)); });
const clearAll = () => run('readwrite', s => s.clear());

// 試作版(localStorage)の古い記録を IndexedDB へ移す。入力者の名前は持ち越さない。
async function migrateOld() {
  let old; try { old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); } catch { old = null; }
  if (!Array.isArray(old)) return 0;
  const out = [];
  for (const r of old) {
    const photos = [];
    for (const p of (r.photos || []).slice(0, MAX_PHOTOS)) { try { photos.push(await (await fetch(p)).blob()); } catch { /* 読めない写真は飛ばす */ } }
    const { recorder, sent, photos: _p, ...rest } = r;
    if (rest.ear === '確認不可') rest.ear = UNKNOWN_EAR;
    out.push({ ...rest, recorderId: null, photos, status: sent ? 'sent' : 'pending' });
  }
  if (out.length) await putAll(out);
  localStorage.removeItem(OLD_KEY); // 移し終えてから消す
  return out.length;
}

// ---- 写真: 位置情報を消し、縮めて、Blob にする ----
// canvas に描き直して JPEG にすると、撮影場所(EXIF の GPS)を含む付属情報はすべて落ちる。
async function cleanImage(file) {
  let src, w, h;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; }
  catch {
    src = await new Promise((ok, ng) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = ng; i.src = u; });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, MAX_SIDE / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise((ok, ng) => c.toBlob(b => b ? ok(b) : ng(new Error('写真を変換できません')), 'image/jpeg', 0.8));
}

let form = {}, photos = [], loc = null, saving = false;

function distM(a, b) {
  const R = 6371000, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildForm() {
  $('#area').innerHTML = AREAS.map(n => `<option>${n}</option>`).join('');
  const c = cfg(); if (c.area && AREAS.includes(c.area)) $('#area').value = c.area;
  $('#area').onchange = () => saveCfg({ area: $('#area').value });
  $('#fields').innerHTML = FIELDS.map(([k, label, opts, hint]) => `<div class="card"><h3>${label}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}<div class="opts" data-k="${k}">${opts.map(o => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`).join('');
  document.querySelectorAll('.opts').forEach(box => box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    box.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    form[box.dataset.k] = b.dataset.v; checkDup();
  });
}

function setLocInfo(text, bad) { const el = $('#locinfo'); el.textContent = text; el.classList.toggle('bad', !!bad); }
function getGps() {
  loc = null; setLocInfo('位置: 取得中…'); checkDup();
  if (!navigator.geolocation) return setLocInfo('位置: この端末では取得できません。「地図で場所を指定」を押してください', true);
  navigator.geolocation.getCurrentPosition(p => setLoc(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy), 'GPS'),
    () => setLocInfo('位置: 取得できませんでした。位置情報の許可を確かめるか、「地図で場所を指定」を押してください', true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function setLoc(lat, lng, acc, src) {
  loc = { lat, lng, acc, src };
  if (src === 'GPS') setLocInfo(`位置: GPSで取得(誤差 約${acc}m)${acc > 50 ? '。誤差が大きめです。取り直すと良くなることがあります' : ''}`, acc > 50);
  else setLocInfo('位置: 地図で指定しました');
  checkDup();
}

let dupToken = 0;
async function checkDup() {
  const box = $('#dup'), my = ++dupToken;
  if (!loc || !form.color || !form.ear) return box.classList.add('hidden');
  const near = (await allRecords()).filter(r => r.color === form.color && r.ear === form.ear && distM(loc, r) <= 50);
  if (my !== dupToken) return;
  if (!near.length) return box.classList.add('hidden');
  box.innerHTML = `⚠️ 前に記録した猫ではありませんか?<br>同じ毛色(${esc(form.color)})・さくら耳(${esc(form.ear)})の記録が、50m以内に${near.length}件あります。` +
    near.slice(0, 3).map(r => `<br>・${fmt(r.time)} 約${Math.round(distM(loc, r))}m ${esc(r.feature || '')}`).join('');
  box.classList.remove('hidden');
}

// ---- 写真の追加・削除 ----
let thumbUrls = [];
function renderThumbs() {
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = photos.map(p => URL.createObjectURL(p));
  $('#thumbs').innerHTML = photos.map((_, i) => `<div class="th"><img src="${thumbUrls[i]}" alt="写真${i + 1}"><button type="button" data-i="${i}" aria-label="この写真を外す">✕</button></div>`).join('');
}
async function onPhoto(e) {
  const files = [...e.target.files]; e.target.value = '';
  if (photos.length + files.length > MAX_PHOTOS) toast(`写真は${MAX_PHOTOS}枚までです`);
  for (const f of files) {
    if (photos.length >= MAX_PHOTOS) break;
    try { photos.push(await cleanImage(f)); } catch { toast('この写真は読み込めませんでした'); }
  }
  renderThumbs();
}

async function saveRecord() {
  if (saving) return;
  const miss = FIELDS.filter(f => REQUIRED.includes(f[0]) && !form[f[0]]).map(f => f[1]);
  if (miss.length) return toast('まだ選んでいない項目があります:\n' + miss.join('、'), 5000);
  if (!loc) return toast('位置がありません。「地図で場所を指定」を押してください', 5000);
  saving = true; $('#btn-save').disabled = true;
  try {
    await putAll([{ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(),
      recorderId: null, // 次の段で、Google ログインの ID を入れる(名前は持たない)
      area: $('#area').value, lat: loc.lat, lng: loc.lng, acc: loc.acc, locSrc: loc.src,
      ...form, feature: $('#feature').value.trim(), photos, status: 'pending' }]);
  } catch { saving = false; $('#btn-save').disabled = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
  form = {}; photos = []; renderThumbs(); $('#feature').value = '';
  document.querySelectorAll('.opts button.sel').forEach(b => b.classList.remove('sel'));
  $('#dup').classList.add('hidden'); saving = false; $('#btn-save').disabled = false;
  await updateBadge(); toast('保存しました(未送信)'); window.scrollTo(0, 0); getGps(); // 次の猫のために位置を取り直す
}

async function updateBadge() { const n = (await allRecords()).filter(r => r.status === 'pending').length; $('#pending').textContent = n ? `未送信 ${n}` : ''; }

// ---- 一覧 ----
let listFilter = 'pending', listUrls = [];
async function renderList() {
  listUrls.forEach(u => URL.revokeObjectURL(u)); listUrls = [];
  document.querySelectorAll('#listfilter button').forEach(b => b.classList.toggle('active', b.dataset.f === listFilter));
  const rs = (await allRecords()).filter(r => listFilter === 'all' || r.status === listFilter).sort((a, b) => b.time.localeCompare(a.time));
  $('#list').innerHTML = rs.length ? rs.map(r => {
    let img = ''; if (r.photos && r.photos[0]) { const u = URL.createObjectURL(r.photos[0]); listUrls.push(u); img = `<img src="${u}" alt="">`; }
    return `<div class="item">${img}<div><b>${esc(r.color)}</b> さくら耳:${esc(r.ear)} ${esc(r.sex)} ${esc(r.age)}<br>
    <span class="note">${fmt(r.time)} ${esc(r.area)}${r.photos && r.photos.length ? ` 写真${r.photos.length}枚` : ''}</span><br>
    <span class="st ${r.status === 'sent' ? 'sent' : ''}">${r.status === 'sent' ? '送信済み' : '未送信'}</span> ${esc(r.feature || '')}</div></div>`; }).join('')
    : `<p>${listFilter === 'pending' ? '未送信の記録はありません' : '記録はまだありません'}</p>`;
}

// ---- 送信(次の段で GAS へ) ----
// 次の段: status==='pending' の記録を、写真を dataURL にして text/plain の POST で送り、
// 返ってきた id の記録を status:'sent' にする(Content-Type を text/plain にするのは CORS のプリフライトを避けるため)。
async function sendPending() {
  const n = (await allRecords()).filter(r => r.status === 'pending').length;
  toast(n ? `送る機能は、次の版で入ります。未送信の${n}件は、この端末に残っています。` : '未送信の記録はありません', 5000);
}

// ---- 地図 ----
let map, layer, picking = false;
function setPicking(on) { picking = on; $('#pickmsg').classList.toggle('hidden', !on); }
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map').setView([35.155, 136.93], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', e => { if (!picking) return; setPicking(false); setLoc(e.latlng.lat, e.latlng.lng, null, '地図'); showTab('record'); });
}
async function renderMap() {
  initMap(); if (!map) return; layer.clearLayers();
  (await allRecords()).forEach(r => L.circleMarker([r.lat, r.lng], { radius: 10, weight: 2, color: '#fff', fillOpacity: .9,
    fillColor: hasEar(r) ? '#d6336c' : r.ear === 'なし' ? '#1971c2' : '#888' })
    .bindPopup(`<b>${esc(r.color)}</b><br>さくら耳: ${esc(r.ear)}<br>${esc(r.area)}<br>${fmt(r.time)}`).addTo(layer));
  setTimeout(() => map.invalidateSize(), 50);
}

// ---- 集計 ----
async function renderStats() {
  const rs = await allRecords(), by = {};
  rs.forEach(r => { const a = by[r.area] ||= { n: 0, ear: 0, unk: 0 }; a.n++; if (hasEar(r)) a.ear++; if (r.ear === UNKNOWN_EAR) a.unk++; });
  const row = (name, a) => { const judged = a.n - a.unk;
    return `<tr><td>${esc(name)}</td><td>${a.n}</td><td>${a.ear}</td><td>${judged ? Math.round(a.ear / judged * 100) + '%' : '—'}</td></tr>`; };
  const tot = Object.values(by).reduce((t, a) => ({ n: t.n + a.n, ear: t.ear + a.ear, unk: t.unk + a.unk }), { n: 0, ear: 0, unk: 0 });
  $('#stats').innerHTML = `<div class="card"><h3>区域ごとの頭数と、さくら耳の割合</h3>${rs.length ? `<table><tr><th>区域</th><th>記録数</th><th>さくら耳あり</th><th>割合</th></tr>
    ${Object.keys(by).sort().map(k => row(k, by[k])).join('')}${row('合計', tot)}</table>` : '<p>まだ記録がありません</p>'}
    <p class="note">割合は、さくら耳が「確認できず」の猫をのぞいた頭数のうち、さくら耳(不妊手術が済んだ印)がある猫の割合です。同じ猫を二度記録していることがあるため、記録数は猫の頭数と同じとは限りません。</p></div>`;
}

// ---- 見本データ(名古屋市内・個人情報なし) ----
async function demo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)], now = Date.now(), rs = [];
  for (let i = 0; i < 20; i++) {
    const area = AREAS[i % AREAS.length], [la, lo] = AREA_CENTER[area], o = {};
    FIELDS.forEach(([k, , opts]) => o[k] = pick(opts));
    if (rnd() < .4) o.ear = pick(['右', '左']);
    rs.push({ id: 'demo' + i + '_' + now.toString(36), time: new Date(now - rnd() * 14 * 864e5).toISOString(), recorderId: 'demo', area,
      lat: la + (rnd() - .5) * .008, lng: lo + (rnd() - .5) * .008, acc: 5 + Math.round(rnd() * 20), locSrc: 'GPS',
      ...o, feature: '(見本データ)', photos: [], status: 'pending' });
  }
  await putAll(rs); await updateBadge(); toast('見本のデータを20頭分入れました');
}

function showTab(t) {
  if (t !== 'map' && picking) setPicking(false); // 地図指定の途中で離れたら取り消す
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + t));
  if (t === 'list') renderList(); if (t === 'map') renderMap(); if (t === 'stats') renderStats();
}

document.addEventListener('DOMContentLoaded', async () => {
  buildForm(); getGps();
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#btn-gps').onclick = getGps;
  $('#btn-pick').onclick = () => { showTab('map'); setPicking(true); };
  $('#btn-pickcancel').onclick = () => { setPicking(false); showTab('record'); };
  $('#photo-cam').onchange = $('#photo-pick').onchange = onPhoto;
  $('#thumbs').onclick = e => { const b = e.target.closest('button'); if (!b) return; photos.splice(+b.dataset.i, 1); renderThumbs(); };
  $('#btn-save').onclick = saveRecord;
  document.querySelectorAll('#listfilter button').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  $('#btn-send').onclick = sendPending;
  $('#gasurl').value = cfg().gasUrl || '';
  $('#btn-savecfg').onclick = () => { saveCfg({ gasUrl: $('#gasurl').value.trim() }); toast('保存しました'); };
  $('#btn-demo').onclick = demo;
  $('#btn-clear').onclick = async () => { if (confirm('この端末の記録を、すべて消します。よろしいですか?')) { await clearAll(); await updateBadge(); renderList(); toast('消しました'); } };
  try { const n = await migrateOld(); if (n) toast(`以前の版の記録${n}件を引き継ぎました`); } catch { toast('以前の記録を引き継げませんでした(元の記録は残してあります)', 6000); }
  updateBadge();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
});
