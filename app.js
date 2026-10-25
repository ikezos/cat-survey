'use strict';
// 地域猫 頭数調査 — 保存は端末の IndexedDB。Google でログインした人だけが、受け付け(Apps Script)へ送れる。
const DB_NAME = 'catSurvey', STORE = 'records', OLD_KEY = 'catSurvey.records', CFG = 'catSurvey.config', AUTH_KEY = 'catSurvey.auth';
const CONF = Object.assign({ GAS_URL: '', GOOGLE_CLIENT_ID: '', SHOW_DEMO: false }, window.CAT_SURVEY_CONFIG || {});
const AREAS = ['千種区A地区', '中区B地区', '昭和区C地区', '瑞穂区D地区']; // 試用版の区域(見本)
const AREA_CENTER = { '千種区A地区': [35.1700, 136.9470], '中区B地区': [35.1640, 136.9060], '昭和区C地区': [35.1500, 136.9330], '瑞穂区D地区': [35.1310, 136.9340] };
const FIELDS = [
  ['color', '毛色・模様', ['茶トラ', 'キジトラ', 'サバトラ', '黒', '白', '三毛', 'サビ', 'ハチワレ', '茶白', 'キジ白', 'サバ白', 'ポインテッド', 'その他'], 'ポインテッド=顔・耳・足・尻尾だけ色が濃い猫'],
  ['ear', 'さくら耳', ['右', '左', 'なし', '確認できず'], '耳の先が桜の花びらの形に切ってある印(不妊手術が済んだ猫)。どちらの耳か選んでください'],
  ['managed', '地域猫として世話されているか', ['されている', 'いない', '不明']],
  ['feeder', '餌をあげている人', ['いる', 'いない', '不明']],
  ['pet', '飼い猫の可能性(任意)', ['あり', 'なし', 'わからない'], '飼い主がいそうな猫かどうか。もう一度押すと選びなおせます'],
  ['age', '年齢のめやす', ['子猫(半年未満)', '若い(1歳前後)', '成猫', '老猫', '不明']],
  ['sex', '性別', ['オス', 'メス', '不明']],
  ['body', '体の様子', ['良好', 'やせ', '太り気味', 'けが・病気の疑い']],
  ['tail', '尻尾', ['長い', '短い', 'かぎ型', 'なし'], 'かぎ型=先が曲がっている'],
  ['tame', '人への慣れ', ['近寄る', '距離を保つ', '逃げる']],
  ['collar', '首輪(任意)', ['あり', 'なし', '不明']],
];
const REQUIRED = ['color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame'];
const PET_REASONS = ['首輪がある', '人にとても慣れている', '毛並みがきれい', '家に出入りしている', 'その他'], PET_OTHER_MAX = 30;
const UNKNOWN_EAR = '確認できず';
const MAX_PHOTOS = 3, MAX_SIDE = 1600;
// 受け付けへ送る項目(入力者IDは送らない。受け付けがログインから決める)
const SEND_KEYS = ['id', 'time', 'area', 'lat', 'lng', 'acc', 'locSrc', 'color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame', 'collar', 'feature', 'pet', 'petReasons', 'petOther'];

const $ = s => document.querySelector(s);
const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG) || '{}'); } catch { return {}; } };
const saveCfg = p => localStorage.setItem(CFG, JSON.stringify({ ...cfg(), ...p }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const petReasonText = r => (Array.isArray(r.petReasons) ? r.petReasons : []).map(x => x === 'その他' && r.petOther ? `その他(${r.petOther})` : x).join('、');
const petText = r => r.pet ? `飼い猫の可能性: ${r.pet}${r.pet === 'あり' && petReasonText(r) ? '(' + petReasonText(r) + ')' : ''}` : '';
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

// ---- ログイン(Google Identity Services)----
// 端末に持つのは ID トークン(約1時間で切れる)・期限・自分のメール(表示用)・入力者ID(受け付けが返す)。名前は持たない。
let auth = null; try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { auth = null; }
const saveAuth = () => auth ? localStorage.setItem(AUTH_KEY, JSON.stringify(auth)) : localStorage.removeItem(AUTH_KEY);
const tokenValid = () => !!(auth && auth.idToken && auth.exp * 1000 > Date.now() + 30000);
const loggedIn = () => tokenValid();
const configured = () => !!(CONF.GAS_URL && CONF.GOOGLE_CLIENT_ID);
function decodeJwt(tok) {
  try { const p = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch { return null; }
}
// GIS がログインの結果をここへ渡す(window に置くのは GIS の決まり)
window.onGoogleCredential = async resp => {
  const p = resp && decodeJwt(resp.credential);
  if (!p || !p.exp) return toast('ログインの結果を読めませんでした', 5000);
  auth = { idToken: resp.credential, exp: Number(p.exp), email: p.email || '', recorderId: auth && auth.recorderId || null };
  saveAuth(); renderAuth();
  const r = await api('whoami');
  if (r.ok) { auth.recorderId = r.recorderId; saveAuth(); renderAuth(); toast('ログインしました'); await syncQuiet(); }
};
function logout() {
  auth = null; saveAuth(); renderAuth();
  try { google.accounts.id.disableAutoSelect(); } catch { /* 部品が無い時 */ }
  toast('ログアウトしました。この端末の記録は残っています');
}
let gsiState = 'loading';
function loadGsi() {
  if (!CONF.GOOGLE_CLIENT_ID) { gsiState = 'noconfig'; return renderAuth(); }
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
  s.onload = () => { gsiState = 'ready'; initGsi(); renderAuth(); };
  s.onerror = () => { gsiState = 'failed'; renderAuth(); };
  document.head.appendChild(s);
}
function initGsi() {
  try {
    google.accounts.id.initialize({ client_id: CONF.GOOGLE_CLIENT_ID, callback: window.onGoogleCredential, auto_select: true, itp_support: true, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton($('#gsi-btn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja', width: 300 });
    if (auth && !tokenValid()) google.accounts.id.prompt(); // 前にログインした人は、期限が切れていれば取り直しを促す
  } catch { gsiState = 'failed'; }
}
function renderAuth() {
  const on = loggedIn(), idTail = auth && auth.recorderId ? `(ID ${auth.recorderId.slice(0, 6)})` : '';
  $('#recorder').textContent = on ? `${auth.email || 'ログイン済み'} ${idTail}` : (auth && auth.idToken ? 'ログインの期限が切れました。もう一度ログインしてください' : 'ログインしていません');
  $('#logincard').classList.toggle('hidden', on);
  const m = $('#loginmsg');
  m.textContent = !configured() ? '送り先の設定がまだです(公開の時に入ります)。保存はできますが、送信はまだできません。'
    : gsiState === 'failed' ? 'ログインの部品を読み込めませんでした。電波がある所で開き直してください。'
    : gsiState === 'loading' ? 'ログインの部品を読み込んでいます…' : (auth && auth.idToken ? 'ログインの期限が切れています。もう一度ログインしてください。' : '');
  $('#authinfo').textContent = on ? `ログイン中: ${auth.email || '(メール不明)'} ${idTail}。記録には ID だけが残り、メールアドレスや名前は送りません。` : 'ログインしていません。';
  $('#btn-logout').classList.toggle('hidden', !auth);
  $('#cfginfo').textContent = configured() ? `受け付け: 設定済み(${CONF.GAS_URL.replace(/^https?:\/\//, '').slice(0, 40)}…)` : '受け付け: 未設定(公開の時に設定ファイルに入ります)';
}

// ---- 受け付け(Apps Script)との通信 ----
// Content-Type を text/plain にして、CORS のプリフライトを避ける。受け付けは 302 で別の URL へ飛ばすので redirect は follow。
async function api(action, extra = {}) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  if (!tokenValid()) return { ok: false, error: 'not_logged_in' };
  let r;
  try {
    const res = await fetch(CONF.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify({ action, idToken: auth.idToken, ...extra }) });
    r = await res.json();
  } catch { return { ok: false, error: 'network' }; }
  if (r && ['token_expired', 'invalid_token', 'wrong_audience', 'wrong_issuer', 'bad_token'].includes(r.error)) { auth.idToken = ''; saveAuth(); renderAuth(); }
  return r || { ok: false, error: 'bad_response' };
}
const ERR_TEXT = {
  not_configured: '送り先の設定がまだです。保存はできますが、送信はまだできません。', not_logged_in: '送るには、Google でログインしてください。',
  network: '電波がないか、受け付けにつながりません。あとでもう一度送ってください。', not_registered: 'この Google アカウントは、まだ登録されていません。研究会の担当者に登録を頼んでください。',
  token_expired: 'ログインの期限が切れました。もう一度ログインしてください。', invalid_token: 'ログインをやり直してください。', wrong_audience: 'ログインをやり直してください。',
  server_not_configured: '受け付け側の設定がまだです(担当者へ連絡してください)。', email_not_verified: 'この Google アカウントは使えません(メールが確認されていません)。',
  busy: '受け付けが混んでいます。少し待ってもう一度送ってください。',
};
const errText = e => ERR_TEXT[e] || `送れませんでした(${e || '不明'})`;
const blobToB64 = b => new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = ng; r.readAsDataURL(b); });

let sending = false;
// 未送信を1件ずつ順に送る。送れた物は status を sent にし、入力者IDを入れる
async function sendPending(quiet = false) {
  if (sending) return; sending = true;
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  try {
    const pend = (await allRecords()).filter(r => r.status === 'pending').sort((a, b) => a.time.localeCompare(b.time));
    if (!pend.length) return say('未送信の記録はありません');
    if (!configured()) return say(errText('not_configured'), 5000);
    if (!loggedIn()) return say(errText('not_logged_in'), 5000);
    if (!navigator.onLine) return say('電波がありません。電波が戻ったら自動で送ります。', 5000);
    let sent = 0, lastErr = null;
    for (const r of pend) {
      const record = {}; SEND_KEYS.forEach(k => { if (r[k] !== undefined) record[k] = r[k]; });
      const photos = []; for (const p of (r.photos || [])) { try { photos.push(await blobToB64(p)); } catch { /* 読めない写真は送らない */ } }
      say(`送っています… ${sent + 1}/${pend.length}`);
      const res = await api('submit', { record, photos });
      if (!res.ok) { lastErr = res.error; break; } // 1件失敗したら止める(順番を守る・同じ案内を繰り返さない)
      r.status = 'sent'; r.recorderId = res.recorderId; r.sentAt = new Date().toISOString(); await putAll([r]); sent++;
    }
    await updateBadge();
    if (lastErr) say(`${sent}件を送りました。` + errText(lastErr), 6000);
    else { say(`${sent}件を送りました(送信済み)`); await refreshFromServer(true); }
    if ($('#tab-list').classList.contains('active')) renderList();
  } finally { sending = false; }
}

// 自分の記録を受け付けから取り直し、端末の控えと合わせる(他人の記録は受け付けが返さない)
async function refreshFromServer(quiet = false) {
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  if (!configured()) return say(errText('not_configured'), 5000);
  if (!loggedIn()) return say(errText('not_logged_in'), 5000);
  const res = await api('list');
  if (!res.ok) return say(errText(res.error), 5000);
  const local = new Map((await allRecords()).map(r => [r.id, r])), put = [];
  for (const s of res.records || []) {
    const l = local.get(s.id);
    if (l) { if (l.status !== 'sent' || l.recorderId !== s.recorderId) { l.status = 'sent'; l.recorderId = s.recorderId; put.push(l); } }
    else put.push({ ...s, photos: [], remote: true, status: 'sent' }); // 別の端末や消した後の記録。写真はこの端末に無い
  }
  if (put.length) await putAll(put);
  if (auth && auth.recorderId !== res.recorderId) { auth.recorderId = res.recorderId; saveAuth(); renderAuth(); }
  await updateBadge();
  say(`自分の記録 ${res.records.length}件を受け付けから取り直しました`);
  if ($('#tab-list').classList.contains('active')) renderList(); if ($('#tab-map').classList.contains('active')) renderMap();
  return res;
}
// 電波があってログイン中なら、未送信を送り、記録を取り直す(案内は画面下に出さない)
async function syncQuiet() { if (!configured() || !loggedIn() || !navigator.onLine) return; await sendPending(true); }

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
  // 飼い猫の可能性の理由(「あり」の時だけ出る・複数選べる)を、その項目のカードの中に置く
  const petBox = $('#fields .opts[data-k=pet]');
  petBox.insertAdjacentHTML('afterend', `<div id="petwhy" class="petwhy hidden"><p class="hint">理由があれば選んでください(いくつでも・任意)</p>
    <div class="opts" id="petreasons">${PET_REASONS.map(o => `<button type="button" data-r="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    <input id="petother" class="petother hidden" type="text" maxlength="${PET_OTHER_MAX}" placeholder="その他の理由(短く)" aria-label="その他の理由">
    <p class="note">人の名前や住所は書かないでください。</p></div>`);
  document.querySelectorAll('#fields .opts[data-k]').forEach(box => box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (box.dataset.k === 'pet' && form.pet === b.dataset.v) { delete form.pet; b.classList.remove('sel'); } // 任意の項目: もう一度押すと外れる
    else { box.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b)); form[box.dataset.k] = b.dataset.v; }
    if (box.dataset.k === 'pet') syncPetWhy();
    checkDup();
  });
  $('#petreasons').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    b.classList.toggle('sel'); form.petReasons = [...document.querySelectorAll('#petreasons button.sel')].map(x => x.dataset.r);
    $('#petother').classList.toggle('hidden', !form.petReasons.includes('その他'));
  };
  $('#petother').oninput = () => { form.petOther = $('#petother').value; };
}
// 「あり」の時だけ理由を出す。「あり」でなくなったら理由は消す
function syncPetWhy() {
  const on = form.pet === 'あり';
  $('#petwhy').classList.toggle('hidden', !on);
  if (!on) resetPetWhy();
}
function resetPetWhy() {
  delete form.petReasons; delete form.petOther;
  document.querySelectorAll('#petreasons button.sel').forEach(b => b.classList.remove('sel'));
  $('#petother').value = ''; $('#petother').classList.add('hidden');
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
      recorderId: auth && auth.recorderId || null, // 受け付けが返した入力者ID(名前は持たない)。送信時に受け付け側で確定する
      area: $('#area').value, lat: loc.lat, lng: loc.lng, acc: loc.acc, locSrc: loc.src,
      ...form, ...(form.pet === 'あり' ? { petReasons: form.petReasons || [], petOther: form.petReasons && form.petReasons.includes('その他') ? (form.petOther || '').trim().slice(0, PET_OTHER_MAX) : '' } : { petReasons: undefined, petOther: undefined }),
      feature: $('#feature').value.trim(), photos, status: 'pending' }]);
  } catch { saving = false; $('#btn-save').disabled = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
  form = {}; photos = []; renderThumbs(); $('#feature').value = '';
  document.querySelectorAll('.opts button.sel').forEach(b => b.classList.remove('sel')); syncPetWhy();
  $('#dup').classList.add('hidden'); saving = false; $('#btn-save').disabled = false;
  await updateBadge(); toast(configured() && loggedIn() && navigator.onLine ? '保存しました。送っています…' : '保存しました(未送信)'); window.scrollTo(0, 0); getGps(); // 次の猫のために位置を取り直す
  syncQuiet().then(() => { if (!(configured() && loggedIn() && navigator.onLine)) return; updateBadge(); });
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
    const nPhoto = r.photos && r.photos.length ? ` 写真${r.photos.length}枚` : (r.photoCount ? ` 写真${r.photoCount}枚(受け付け側)` : '');
    return `<div class="item">${img}<div><b>${esc(r.color)}</b> さくら耳:${esc(r.ear)} ${esc(r.sex)} ${esc(r.age)}${petText(r) ? `<br><span class="pet">${esc(petText(r))}</span>` : ''}<br>
    <span class="note">${fmt(r.time)} ${esc(r.area)}${nPhoto}</span><br>
    <span class="st ${r.status === 'sent' ? 'sent' : ''}">${r.status === 'sent' ? '送信済み' : '未送信'}</span>${r.remote ? ' <span class="st remote">(受け付けから取り直した記録)</span>' : ''} ${esc(r.feature || '')}</div></div>`; }).join('')
    : `<p>${listFilter === 'pending' ? '未送信の記録はありません' : '記録はまだありません'}</p>`;
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
    .bindPopup(`<b>${esc(r.color)}</b><br>さくら耳: ${esc(r.ear)}<br>${petText(r) ? esc(petText(r)) + '<br>' : ''}${esc(r.area)}<br>${fmt(r.time)}<br>${r.status === 'sent' ? '送信済み' : '未送信'}`).addTo(layer));
  setTimeout(() => map.invalidateSize(), 50);
}

// ---- 集計 ----
async function renderStats() {
  const rs = await allRecords(), by = {};
  rs.forEach(r => { const a = by[r.area] ||= { n: 0, ear: 0, unk: 0, pet: 0 }; a.n++; if (r.pet === 'あり') a.pet++; if (hasEar(r)) a.ear++; if (r.ear === UNKNOWN_EAR) a.unk++; });
  const row = (name, a) => { const judged = a.n - a.unk;
    return `<tr><td>${esc(name)}</td><td>${a.n}</td><td>${a.ear}</td><td>${judged ? Math.round(a.ear / judged * 100) + '%' : '—'}</td><td>${a.pet}</td></tr>`; };
  const tot = Object.values(by).reduce((t, a) => ({ n: t.n + a.n, ear: t.ear + a.ear, unk: t.unk + a.unk, pet: t.pet + a.pet }), { n: 0, ear: 0, unk: 0, pet: 0 });
  $('#stats').innerHTML = `<div class="card"><h3>区域ごとの頭数と、さくら耳の割合(自分の記録)</h3>${rs.length ? `<table><tr><th>区域</th><th>記録数</th><th>さくら耳あり</th><th>割合</th><th>飼い猫の可能性あり</th></tr>
    ${Object.keys(by).sort().map(k => row(k, by[k])).join('')}${row('合計', tot)}</table>` : '<p>まだ記録がありません</p>'}
    <p class="note">割合は、さくら耳が「確認できず」の猫をのぞいた頭数のうち、さくら耳(不妊手術が済んだ印)がある猫の割合です。同じ猫を二度記録していることがあるため、記録数は猫の頭数と同じとは限りません。「飼い猫の可能性あり」は、記録のうち飼い猫かもしれないと入力された数です。頭数の推定から外したいときは、記録数から引いて考えます。全体の集計は受け付け側のスプレッドシートで見ます。</p></div>`;
}

// ---- 見本データ(名古屋市内・個人情報なし。設定で SHOW_DEMO か、URL に ?demo がある時だけボタンが出る) ----
async function demo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)], now = Date.now(), rs = [];
  for (let i = 0; i < 20; i++) {
    const area = AREAS[i % AREAS.length], [la, lo] = AREA_CENTER[area], o = {};
    FIELDS.forEach(([k, , opts]) => o[k] = pick(opts));
    if (rnd() < .4) o.ear = pick(['右', '左']);
    rs.push({ id: 'demo' + i + '_' + now.toString(36), time: new Date(now - rnd() * 14 * 864e5).toISOString(), recorderId: null, area,
      lat: la + (rnd() - .5) * .008, lng: lo + (rnd() - .5) * .008, acc: 5 + Math.round(rnd() * 20), locSrc: 'GPS',
      ...o, feature: '(見本データ)', photos: [], status: 'pending' });
  }
  await putAll(rs); await updateBadge(); toast('見本のデータを20頭分入れました(未送信)');
}

function showTab(t) {
  if (t !== 'map' && picking) setPicking(false); // 地図指定の途中で離れたら取り消す
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + t));
  if (t === 'list') renderList(); if (t === 'map') renderMap(); if (t === 'stats') renderStats(); if (t === 'settings') renderAuth();
}

document.addEventListener('DOMContentLoaded', async () => {
  buildForm(); getGps(); renderAuth(); loadGsi();
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#btn-gps').onclick = getGps;
  $('#btn-pick').onclick = () => { showTab('map'); setPicking(true); };
  $('#btn-pickcancel').onclick = () => { setPicking(false); showTab('record'); };
  $('#photo-cam').onchange = $('#photo-pick').onchange = onPhoto;
  $('#thumbs').onclick = e => { const b = e.target.closest('button'); if (!b) return; photos.splice(+b.dataset.i, 1); renderThumbs(); };
  $('#btn-save').onclick = saveRecord;
  document.querySelectorAll('#listfilter button').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  $('#btn-send').onclick = () => sendPending(false);
  $('#btn-refresh').onclick = () => refreshFromServer(false);
  $('#btn-logout').onclick = logout;
  if (CONF.SHOW_DEMO || new URLSearchParams(location.search).has('demo')) $('#btn-demo').classList.remove('hidden');
  $('#btn-demo').onclick = demo;
  $('#btn-clear').onclick = async () => { if (confirm('この端末の記録を、すべて消します。よろしいですか?')) { await clearAll(); await updateBadge(); renderList(); toast('消しました'); } };
  window.addEventListener('online', () => { toast('電波が戻りました。未送信を送ります'); syncQuiet(); });
  try { const n = await migrateOld(); if (n) toast(`以前の版の記録${n}件を引き継ぎました`); } catch { toast('以前の記録を引き継げませんでした(元の記録は残してあります)', 6000); }
  updateBadge();
  syncQuiet(); // 開いた時に、未送信があって電波があれば送る
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
});
