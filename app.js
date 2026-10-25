'use strict';
// 地域猫 頭数調査 — 保存は端末の IndexedDB。Google でログインした人と、ログインカード(2026-10-25 追加)でログインした人が、受け付け(Apps Script)へ送れる。
// ログインカード: カードの URL(…/#card=<合言葉>)で開くと、# の後ろをすぐ URL から消し(履歴に残さない)、4けたの暗証番号を聞く。受け付けが返す「通行証」を端末に持ち、次からはそれで照らす(カードも番号も要らない)。
// 合言葉は変数に持つだけで、端末にも保存しない。管理の画面(役割「管理者」の Google の人だけ)で、カードの発行(QR を端末の中で作る)・Google の人の登録ができる。
const DB_NAME = 'catSurvey', STORE = 'records', SITES = 'sites', OPT_KEY = 'catSurvey.options', OLD_KEY = 'catSurvey.records', CFG = 'catSurvey.config', AUTH_KEY = 'catSurvey.auth';
const CONF = Object.assign({ GAS_URL: '', GOOGLE_CLIENT_ID: '', SHOW_DEMO: false }, window.CAT_SURVEY_CONFIG || {});
const DEMO_CENTERS = [[35.1700, 136.9470], [35.1640, 136.9060], [35.1500, 136.9330], [35.1310, 136.9340]];   // 見本データの場所(名古屋市内)
const SITE_NEAR_M = 100, SITE_NAME_MAX = 30, SITE_MEMO_MAX = 60;
// 地域メッシュ(JIS X 0410)。受け付け(Code.gs)と同じ式。受け付けが返した値を正とし、これは端末で今すぐ出したい時(未送信の記録・集計)に使う
function meshCodes(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < 0 || lng < 100) return null;
  const L = Math.floor(lat * 480 + 1e-9), M = Math.floor(lng * 320 + 1e-9), p = Math.floor(L / 320), u = Math.floor(M / 320) - 100;
  if (p < 0 || p > 99 || u < 0 || u > 99) return null;
  const Lr = L % 320, Mr = M % 320, q = Math.floor(Lr / 40), v = Math.floor(Mr / 40), Lr2 = Lr % 40, Mr2 = Mr % 40;
  const r = Math.floor(Lr2 / 4), w = Math.floor(Mr2 / 4), Lq = Lr2 % 4, Mq = Mr2 % 4, two = n => (n < 10 ? '0' : '') + n;
  const m3 = two(p) + two(u) + q + v + r + w, d500 = 1 + Math.floor(Mq / 2) + 2 * Math.floor(Lq / 2), d250 = 1 + (Mq % 2) + 2 * (Lq % 2);
  return { mesh3: m3, mesh500: m3 + d500, mesh250: m3 + d500 + d250 };
}
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
];   // 首輪は別の項目にしない(飼い猫の可能性の理由「首輪がある」で表す)
const FIELDS_BUILTIN = FIELDS.map(f => [f[0], f[2].slice()]);
const REQUIRED = ['color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame'];
const PET_REASONS = ['首輪がある', '人にとても慣れている', '毛並みがきれい', '家に出入りしている', 'その他'], PET_OTHER_MAX = 30;   // 選び肢シートで変わる(applyOptions が中身を入れ替える)
const PET_REASONS_BUILTIN = PET_REASONS.slice();
const UNKNOWN_EAR = '確認できず';
const MAX_PHOTOS = 3, MAX_SIDE = 1600;
// 受け付けへ送る項目(入力者IDは送らない。受け付けがログインから決める)
// 送った後に「状態が変わった」として足せる項目(受け付けの CHANGE_FIELDS と同じ)
const CHANGE_ITEMS = ['ear', 'managed', 'feeder', 'body', 'pet'];   // + えさ場の付け替え(siteId)
// 「間違いを直す」で直せる項目(位置・日時・写真は直せない)
const EDIT_FIELD_KEYS = ['color', 'ear', 'managed', 'feeder', 'pet', 'age', 'sex', 'body', 'tail', 'tame'];
// 受け付けの内容に合わせる項目(取り直した時)
const SERVER_KEYS = ['area', 'color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame', 'collar', 'feature', 'pet', 'petReasons', 'petOther', 'editedAt', 'editCount', 'changes', 'siteId', 'mesh3', 'mesh500', 'mesh250'];
const SEND_KEYS = ['id', 'time', 'area', 'lat', 'lng', 'acc', 'locSrc', 'color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame', 'collar', 'feature', 'pet', 'petReasons', 'petOther', 'siteId'];

const $ = s => document.querySelector(s);
const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG) || '{}'); } catch { return {}; } };
const saveCfg = p => localStorage.setItem(CFG, JSON.stringify({ ...cfg(), ...p }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const petReasonText = r => (Array.isArray(r.petReasons) ? r.petReasons : []).map(x => x === 'その他' && r.petOther ? `その他(${r.petOther})` : x).join('、');
const petText = r => r.pet ? `飼い猫の可能性: ${r.pet}${r.pet === 'あり' && petReasonText(r) ? '(' + petReasonText(r) + ')' : ''}` : (r.collar === 'あり' ? '飼い猫の可能性: あり(首輪)' : '');   // 古い記録で、首輪=あり・飼い猫の可能性が空の物は「あり(首輪)」とみなす(シートの値は書き換えない)
const effPet = r => r.pet || (r.collar === 'あり' ? 'あり' : '');
const meshOf = r => r.mesh500 || (meshCodes(r.lat, r.lng) || {}).mesh500 || '';
const opsOf = r => r.ops || [];
const editMarks = r => (r.editCount || 0) + opsOf(r).filter(o => o.type === 'edit').length;
const changeMarks = r => (r.changes || []).length + opsOf(r).filter(o => o.type === 'change').length;
const marksHtml = r => (editMarks(r) ? '<span class="mark edit">直した</span>' : '') + (changeMarks(r) ? `<span class="mark chg">変化 ${changeMarks(r)}回</span>` : '');
const marksText = r => [editMarks(r) ? '直した' : '', changeMarks(r) ? `変化 ${changeMarks(r)}回` : ''].filter(Boolean).join('・');
const hasEar = r => r.ear === '右' || r.ear === '左';
const fmt = t => new Date(t).toLocaleString('ja-JP');

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- IndexedDB ----
const dbp = new Promise((ok, ng) => {
  const q = indexedDB.open(DB_NAME, 2);
  q.onupgradeneeded = () => {
    const db = q.result;
    if (!db.objectStoreNames.contains(STORE)) { const s = db.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('status', 'status'); }
    if (!db.objectStoreNames.contains(SITES)) db.createObjectStore(SITES, { keyPath: 'id' });   // えさ場(端末の控え。送信待ちの物もここ)
  };
  q.onsuccess = () => ok(q.result); q.onerror = () => ng(q.error);
});
const run = (mode, fn, store = STORE) => dbp.then(db => new Promise((ok, ng) => {
  const t = db.transaction(store, mode), r = fn(t.objectStore(store));
  t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => ng(t.error || new Error('保存に失敗しました'));
}));
const allRecords = () => run('readonly', s => s.getAll());
const getRecord = id => run('readonly', s => s.get(id));
const putAll = rs => run('readwrite', s => { rs.forEach(r => s.put(r)); });
const clearAll = async () => { await run('readwrite', s => s.clear()); await run('readwrite', s => s.clear(), SITES); };
const allSites = () => run('readonly', s => s.getAll(), SITES);
const getSite = id => run('readonly', s => s.get(id), SITES);
const putSites = rs => run('readwrite', s => { rs.forEach(r => s.put(r)); }, SITES);

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

// ---- ログイン(Google Identity Services / ログインカード)----
// 端末に持つのは、Google: ID トークン(約1時間で切れる)・期限・自分のメール(表示用)・入力者ID(受け付けが返す)。名前は持たない。
//            カード: 通行証(受け付けが返す長い乱数・90日・使うたびに延びる)・期限・呼び名・入力者ID。合言葉と番号は持たない。
let auth = null; try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { auth = null; }
const saveAuth = () => auth ? localStorage.setItem(AUTH_KEY, JSON.stringify(auth)) : localStorage.removeItem(AUTH_KEY);
const isCard = () => !!(auth && auth.type === 'card');
const tokenValid = () => !!(auth && (isCard() ? auth.pass && auth.passExp > Date.now() : auth.idToken && auth.exp * 1000 > Date.now() + 30000));
const loggedIn = () => tokenValid();
const whoLabel = () => !auth ? '' : isCard() ? `${auth.name || 'カードの人'}(カード)` : (auth.email || 'ログイン済み');
const configured = () => !!(CONF.GAS_URL && CONF.GOOGLE_CLIENT_ID);
function decodeJwt(tok) {
  try { const p = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch { return null; }
}
// GIS がログインの結果をここへ渡す(window に置くのは GIS の決まり)
window.onGoogleCredential = async resp => {
  const p = resp && decodeJwt(resp.credential);
  if (!p || !p.exp) return toast('ログインの結果を読めませんでした', 5000);
  auth = { type: 'google', idToken: resp.credential, exp: Number(p.exp), email: p.email || '', recorderId: auth && !isCard() && auth.recorderId || null };
  saveAuth(); renderAuth();
  const r = await api('whoami');
  if (r.ok) { auth.recorderId = r.recorderId; applyMeta(r); saveAuth(); renderAuth(); toast('ログインしました'); await syncQuiet(); }
};
function logout() {
  if (isCard() && tokenValid() && navigator.onLine) api('passRevoke').catch(() => {});   // 通行証を受け付け側でも使えなくする(できなくても端末からは消す)
  auth = null; saveAuth(); setScope('mine', true); renderAuth();
  try { google.accounts.id.disableAutoSelect(); } catch { /* 部品が無い時 */ }
  toast('ログアウトしました。この端末の記録は残っています');
}
// ---- ログインカード ----
let cardSecret = null;   // カードの URL から読んだ合言葉。番号を入れてログインするまでの間だけ持つ(保存しない)
const CARD_RE = /^[A-Za-z0-9_-]{20,64}$/;
// 開いた URL の #card=… を読み、すぐ URL から消す(戻る・履歴・共有に合言葉が残らないように)
function readCardFromUrl() {
  const m = /^#card=([^&]+)/.exec(location.hash || ''); if (!m) return false;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
  let secret = ''; try { secret = decodeURIComponent(m[1]); } catch { secret = m[1]; }
  if (!CARD_RE.test(secret)) { toast('このカードの URL は読めませんでした。研究会の担当者に連絡してください', 6000); return false; }
  cardSecret = secret; openCardPin(); return true;
}
// 暗証番号の画面(カードを読んだ直後)
function openCardPin() {
  if (!cardSecret) return;
  showSheet(`<div class="sheethead"><b>カードを読みました</b></div>
  <div class="sheetbody"><div class="card pinbox"><h3>暗証番号(4けた)を入れてください</h3>
  <p class="note">研究会から伝えられた4けたの数字です。この端末で最初の1回だけ入れます(次からは、かざさなくてもログインしたままです)。</p>
  <input id="pin" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" aria-label="暗証番号 4けた" placeholder="●●●●">
  <p id="pinmsg" class="warn hidden"></p>
  <button type="button" id="pin-go" class="primary">ログイン</button>
  <button type="button" id="pin-cancel" class="wide">やめる</button>
  <p class="note">5回続けて間違えると、このカードは使えなくなります(研究会の担当者が戻せます)。番号を忘れたときも担当者に連絡してください。</p></div></div>`);
  const msg = t => { const el = $('#pinmsg'); el.textContent = t; el.classList.toggle('hidden', !t); };
  $('#pin-cancel').onclick = () => { cardSecret = null; closeSheet(); };
  $('#pin').oninput = () => { $('#pin').value = $('#pin').value.replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).slice(0, 4); };
  $('#pin').onkeydown = e => { if (e.key === 'Enter') $('#pin-go').click(); };
  $('#pin-go').onclick = async () => {
    const pin = $('#pin').value; if (!/^[0-9]{4}$/.test(pin)) return msg('数字を4つ入れてください');
    if (!configured()) return msg(errText('not_configured')); if (!navigator.onLine) return msg('電波がありません。電波がある所でもう一度カードをかざしてください');
    $('#pin-go').disabled = true; msg('');
    const r = await rawApi({ action: 'cardLogin', card: cardSecret, pin });
    $('#pin-go').disabled = false;
    if (!r.ok) {
      if (r.error === 'wrong_pin') { $('#pin').value = ''; return msg(`番号が違います。あと${r.remaining}回まちがえると、このカードは使えなくなります`); }
      if (r.error === 'card_stopped') { cardSecret = null; return msg(r.locked ? '5回まちがえたので、このカードは止まりました。研究会の担当者に連絡して、番号を戻してもらってください' : errText('card_stopped')); }
      return msg(errText(r.error));
    }
    cardSecret = null;
    auth = { type: 'card', pass: r.pass, passExp: Number(r.passExp), name: r.name || '', recorderId: r.recorderId || null };
    saveAuth(); closeSheet(); renderAuth(); toast(`ようこそ、${auth.name || 'カードの人'}。ログインしました`, 4000);
    const w = await api('whoami'); if (w.ok) { auth.recorderId = w.recorderId; applyMeta(w); saveAuth(); renderAuth(); }
    await syncQuiet();
  };
  setTimeout(() => { try { $('#pin').focus(); } catch { /* 画面が無い時 */ } }, 50);
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
    if (auth && !isCard() && !tokenValid()) google.accounts.id.prompt(); // 前に Google でログインした人は、期限が切れていれば取り直しを促す
  } catch { gsiState = 'failed'; }
}
function renderAuth() {
  const on = loggedIn(), idTail = auth && auth.recorderId ? `(ID ${auth.recorderId.slice(0, 6)})` : '';
  $('#recorder').textContent = on ? `${whoLabel()} ${idTail}` : (auth && (auth.idToken || auth.pass) ? (isCard() ? 'ログインの期限が切れました。もう一度カードをかざして(QR を読んで)ください' : 'ログインの期限が切れました。もう一度ログインしてください') : 'ログインしていません');
  $('#logincard').classList.toggle('hidden', on);
  const m = $('#loginmsg');
  m.textContent = !configured() ? '送り先の設定がまだです(公開の時に入ります)。保存はできますが、送信はまだできません。'
    : gsiState === 'failed' ? 'ログインの部品を読み込めませんでした。電波がある所で開き直してください。'
    : gsiState === 'loading' ? 'ログインの部品を読み込んでいます…' : (auth && auth.idToken ? 'ログインの期限が切れています。もう一度ログインしてください。' : '');
  $('#authinfo').textContent = on ? (isCard() ? `ログイン中: ${auth.name || 'カードの人'}(ログインカード)${idTail}。この端末にはログインの通行証だけが残り、カードの合言葉や暗証番号は残りません。記録には ID だけが残ります。`
    : `ログイン中: ${auth.email || '(メール不明)'} ${idTail}。記録には ID だけが残り、メールアドレスや名前は送りません。${auth.admin ? '役割: 管理者(「管理」の画面で入力者の登録・カードの発行ができます。全員の記録も見られます)' : auth.viewAll ? '役割: 全体を見る(一覧・地図・集計で「全員の記録」に切り替えられます)' : ''}`) : 'ログインしていません。';
  renderScopeBar();
  $('#nav-admin').classList.toggle('hidden', !(on && !isCard() && auth.admin));
  if (!(on && auth.admin) && document.querySelector('.tab.active') && document.querySelector('.tab.active').id === 'tab-admin') showTab('record');
  $('#btn-logout').classList.toggle('hidden', !auth);
  $('#cfginfo').textContent = configured() ? `受け付け: 設定済み(${CONF.GAS_URL.replace(/^https?:\/\//, '').slice(0, 40)}…)` : '受け付け: 未設定(公開の時に設定ファイルに入ります)';
}

// ---- 選び肢(受け付けの「選び肢」シートで変わる)と役割 ----
// 受け付けが返した選び肢を端末に控え、次に開いた時から使う。受け付けが null を返した時(シートが壊れている)や、読めない時は、アプリに入っている選び肢で動く。
const okList = a => Array.isArray(a) && a.length > 0 && a.length <= 60 && a.every(x => typeof x === 'string' && x.length >= 1 && x.length <= 50);
function applyOptions(o) {
  FIELDS.forEach(f => { const b = FIELDS_BUILTIN.find(x => x[0] === f[0]); f[2] = o && okList(o[f[0]]) ? o[f[0]].slice() : b[1].slice(); });
  const pr = o && okList(o.petReasons) && o.petReasons.every(x => !/[、:]/.test(x)) ? o.petReasons : PET_REASONS_BUILTIN;
  PET_REASONS.splice(0, PET_REASONS.length, ...pr);
}
let optionsDirty = false;
function applyMeta(r) {
  if (!r || !r.ok) return;
  if (auth && auth.viewAll !== !!r.viewAll) { auth.viewAll = !!r.viewAll; saveAuth(); if (!auth.viewAll && scope === 'all') setScope('mine', true); renderScopeBar(); }
  if (auth && (auth.admin !== !!r.admin || (r.name != null && isCard() && auth.name !== r.name))) { auth.admin = !!r.admin; if (isCard() && r.name != null) auth.name = r.name; saveAuth(); renderAuth(); }
  if (!('options' in r)) return;   // 古い受け付けは options を返さない=何も変えない
  const before = JSON.stringify([FIELDS.map(f => f[2]), PET_REASONS]);
  applyOptions(r.options); r.options ? localStorage.setItem(OPT_KEY, JSON.stringify(r.options)) : localStorage.removeItem(OPT_KEY);
  if (before !== JSON.stringify([FIELDS.map(f => f[2]), PET_REASONS])) {
    if (formCtl && !Object.keys(form).length && $('#sheet').classList.contains('hidden')) buildForm(); else optionsDirty = true;   // 入力の途中なら、保存したあとに入れ替える
    toast('選び肢が新しくなりました', 3000);
  }
}
async function refreshMeta() { if (!configured() || !loggedIn() || !navigator.onLine) return; const r = await api('whoami'); applyMeta(r); }
try { applyOptions(JSON.parse(localStorage.getItem(OPT_KEY) || 'null')); } catch { applyOptions(null); }

// ---- 受け付け(Apps Script)との通信 ----
// Content-Type を text/plain にして、CORS のプリフライトを避ける。受け付けは 302 で別の URL へ飛ばすので redirect は follow。
// ログインの前の呼び出し(cardLogin)。ログインの印は付けない
async function rawApi(body) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  try { const res = await fetch(CONF.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify(body) }); return (await res.json()) || { ok: false, error: 'bad_response' }; }
  catch { return { ok: false, error: 'network' }; }
}
async function api(action, extra = {}) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  if (!tokenValid()) return { ok: false, error: 'not_logged_in' };
  let r;
  try {
    const cred = isCard() ? { pass: auth.pass } : { idToken: auth.idToken };   // カードの人は通行証、Google の人は ID トークン
    const res = await fetch(CONF.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify({ action, ...cred, ...extra }) });
    r = await res.json();
  } catch { return { ok: false, error: 'network' }; }
  if (r && !isCard() && ['token_expired', 'invalid_token', 'wrong_audience', 'wrong_issuer', 'bad_token'].includes(r.error)) { auth.idToken = ''; saveAuth(); renderAuth(); }
  if (r && isCard() && ['pass_invalid', 'card_stopped'].includes(r.error)) { auth = null; saveAuth(); setScope('mine', true); renderAuth(); toast(errText(r.error), 7000); }   // 通行証が使えなくなった(止められた・番号を戻した・期限切れ)→ ログアウトの状態に
  if (r && !isCard() && r.error === 'stopped') { auth.idToken = ''; saveAuth(); renderAuth(); }
  return r || { ok: false, error: 'bad_response' };
}
const ERR_TEXT = {
  not_configured: '送り先の設定がまだです。保存はできますが、送信はまだできません。', not_logged_in: '送るには、Google でログインするか、ログインカードをかざして(QR を読んで)ください。',
  stopped: 'このアカウントは止められています。研究会の担当者に連絡してください。', pass_invalid: 'このカードのログインは使えなくなりました(番号を戻した・期限切れなど)。もう一度カードをかざして(QR を読んで)、暗証番号を入れてください。',
  card_stopped: 'このカードは止まっています。研究会の担当者に連絡してください。', card_not_found: 'このカードは登録されていません(作り直された・止められたカードかもしれません)。研究会の担当者に連絡してください。',
  wrong_pin: '暗証番号が違います。', bad_pin: '暗証番号は数字4つです。', last_admin: '最後の管理者は外せません(先にほかの人を管理者にしてください)。', duplicate: 'そのメールアドレスは、もう登録されています。',
  bad_email: 'メールアドレスの形が違います。', bad_role: 'その役割は選べません。', bad_name: '呼び名は1〜20字で入れてください。', card_no_role: 'カードの人には役割を付けられません(全体を見るのは Google の人だけ)。',
  network: '電波がないか、受け付けにつながりません。あとでもう一度送ってください。', not_registered: 'この Google アカウントは、まだ登録されていません。研究会の担当者に登録を頼んでください。',
  token_expired: 'ログインの期限が切れました。もう一度ログインしてください。', invalid_token: 'ログインをやり直してください。', wrong_audience: 'ログインをやり直してください。',
  server_not_configured: '受け付け側の設定がまだです(担当者へ連絡してください)。', email_not_verified: 'この Google アカウントは使えません(メールが確認されていません)。',
  busy: '受け付けが混んでいます。少し待ってもう一度送ってください。',
  not_found: 'これは受け付けに見つかりません(自分の記録・えさ場だけ直せます)。', not_allowed: 'この操作は、今のアカウントでは使えません(役割がありません)。', bad_site: 'そのえさ場は使えません(自分の、使っているえさ場だけ選べます)。', unknown_action: '受け付けがまだ新しくなっていません(担当者へ連絡してください)。この端末に貯めた分は残っています。',
};
const errText = e => ERR_TEXT[e] || `送れませんでした(${e || '不明'})`;
const blobToB64 = b => new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = ng; r.readAsDataURL(b); });

let sending = false;
// 電波・ログイン・受け付けの都合で送れなかっただけの誤り。この時は端末に貯めた直し・変化を残して、あとでもう一度送る
const TRANSIENT = ['network', 'busy', 'not_logged_in', 'not_configured', 'token_expired', 'invalid_token', 'wrong_audience', 'wrong_issuer', 'bad_token', 'tokeninfo_unreachable', 'server_error', 'server_not_configured', 'bad_json', 'bad_response', 'unknown_action', 'not_registered', 'email_not_verified', 'stopped', 'pass_invalid', 'card_stopped'];
// 端末に貯めた「直し」「状態の変化」を、記録ごとに古い順に送る。送れた分は貯めた列から外す(外す前に記録を読み直す=送っている間に足された分を消さない)
async function sendOps() {
  let sent = 0, lastErr = null, dropped = [];
  const ids = (await allRecords()).filter(r => r.status === 'sent' && opsOf(r).length).sort((a, b) => opsOf(a)[0].queuedAt.localeCompare(opsOf(b)[0].queuedAt)).map(r => r.id);
  outer: for (const id of ids) {
    for (;;) {
      const r = await getRecord(id), op = r && opsOf(r)[0]; if (!op) break;
      const res = op.type === 'edit' ? await api('edit', { recordId: id, fields: op.fields })
        : await api('change', { change: { id: op.id, recordId: id, time: op.time, changes: op.changes, petReasons: op.petReasons, petOther: op.petOther, lat: op.lat, lng: op.lng, acc: op.acc } });
      const f = await getRecord(id); if (!f) break;
      if (!res.ok && TRANSIENT.includes(res.error)) { lastErr = res.error; break outer; }
      f.ops = opsOf(f).filter(o => o.opId !== op.opId);
      if (!res.ok) dropped.push(res.error);   // 受け付けが断った直し(見つからない・内容がおかしい)は取り下げる。画面は次の取り直しで受け付けの内容に戻る
      else if (op.type === 'edit') { f.editCount = res.editCount; f.editedAt = res.editedAt; sent++; }
      else { if (!res.duplicate && !res.unchanged) f.changes = [...(f.changes || []), { id: op.id, time: op.time, items: (res.items || []).map(({ label, from, to }) => ({ label, from, to })) }]; sent++; }
      await putAll([f]);
    }
  }
  return { sent, lastErr, dropped };
}
// えさ場: 未送信の登録 → 貯めた名前の直し・「使っていない」を、古い順に送る。記録より先に送る(記録がえさ場に結び付くため)
async function sendSites() {
  let sent = 0, lastErr = null;
  const pend = (await allSites()).filter(x => x.status === 'pending').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const x of pend) {
    const res = await api('siteAdd', { site: { id: x.id, name: x.name, memo: x.memo, lat: x.lat, lng: x.lng, acc: x.acc } });
    if (!res.ok) { lastErr = res.error; return { sent, lastErr }; }
    const f = await getSite(x.id); if (!f) continue;
    f.status = 'sent'; f.recorderId = auth.recorderId || f.recorderId; Object.assign(f, { mesh3: res.site.mesh3, mesh500: res.site.mesh500, mesh250: res.site.mesh250 }); await putSites([f]); sent++;   // メッシュは受け付けの値を正とする
  }
  const withOps = (await allSites()).filter(x => x.status === 'sent' && (x.ops || []).length);
  for (const x of withOps) {
    for (;;) {
      const f = await getSite(x.id), op = f && (f.ops || [])[0]; if (!op) break;
      const res = await api('siteEdit', { siteId: x.id, fields: op.fields });
      if (!res.ok && TRANSIENT.includes(res.error)) return { sent, lastErr: res.error };
      const g = await getSite(x.id); if (!g) break;
      g.ops = (g.ops || []).filter(o => o.opId !== op.opId); if (res.ok) sent++;   // 受け付けが断った物(見つからない等)は取り下げる。次の取り直しで受け付けの内容に戻る
      await putSites([g]);
    }
  }
  return { sent, lastErr };
}
// 未送信を1件ずつ順に送る。送れた物は status を sent にし、入力者IDを入れる。そのあと、貯めた直し・変化を送る
async function sendPending(quiet = false) {
  if (sending) return; sending = true;
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  try {
    const all = await allRecords(), pend = all.filter(r => r.status === 'pending').sort((a, b) => a.time.localeCompare(b.time)), sites = await allSites();
    if (!pend.length && !all.some(r => opsOf(r).length) && !sites.some(x => x.status === 'pending' || (x.ops || []).length)) return say('未送信の記録はありません');
    if (!configured()) return say(errText('not_configured'), 5000);
    if (!loggedIn()) return say(errText('not_logged_in'), 5000);
    if (!navigator.onLine) return say('電波がありません。電波が戻ったら自動で送ります。', 5000);
    let sent = 0, lastErr = null, dropped = [];
    const so = await sendSites(); sent += so.sent; lastErr = so.lastErr;
    if (!lastErr) for (const r of pend) {
      const record = {}; SEND_KEYS.forEach(k => { if (r[k] !== undefined) record[k] = r[k]; });
      const photos = []; for (const p of (r.photos || [])) { try { photos.push(await blobToB64(p)); } catch { /* 読めない写真は送らない */ } }
      say(`送っています… ${sent + 1}/${pend.length}`);
      const res = await api('submit', { record, photos });
      if (!res.ok) { lastErr = res.error; break; } // 1件失敗したら止める(順番を守る・同じ案内を繰り返さない)
      r.status = 'sent'; r.recorderId = res.recorderId; r.sentAt = new Date().toISOString(); if (res.siteDropped) r.siteId = ''; await putAll([r]); sent++;
    }
    if (!lastErr) { const o = await sendOps(); sent += o.sent; lastErr = o.lastErr; dropped = o.dropped; }
    await updateBadge();
    if (lastErr) say(`${sent}件を送りました。` + errText(lastErr), 6000);
    else {
      const dmsg = dropped.length ? `${sent}件を送りました。受け付けが受け付けなかった直し・変化が${dropped.length}件あります(${errText(dropped[0])})` : '';
      say(dmsg || `${sent}件を送りました(送信済み)`, dropped.length ? 7000 : 3500);
      await refreshFromServer(true);
      if (dmsg) $('#sendmsg').textContent = dmsg;   // 取り直しの案内で上書きされないように
    }
    renderActiveTab();
  } finally { sending = false; }
}

// 自分の記録を受け付けから取り直し、端末の控えと合わせる(他人の記録は受け付けが返さない)
async function refreshFromServer(quiet = false) {
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  if (!configured()) return say(errText('not_configured'), 5000);
  if (!loggedIn()) return say(errText('not_logged_in'), 5000);
  const res = await api('list');
  if (!res.ok) return say(errText(res.error), 5000);
  applyMeta(res);
  const lsites = new Map((await allSites()).map(x => [x.id, x])), putS = [];
  for (const s of res.sites || []) {   // えさ場: 送信待ちの直しが無い物は、受け付けの内容に合わせる。端末に無い物(別の端末で登録)は足す
    const l = lsites.get(s.id);
    if (!l) putS.push({ ...s, status: 'sent', ops: [] });
    else if (!(l.ops || []).length) { let d = l.status !== 'sent'; for (const k of ['name', 'memo', 'retired', 'mesh3', 'mesh500', 'mesh250', 'recorderId']) if (l[k] !== s[k]) { l[k] = s[k]; d = true; } if (d) { l.status = 'sent'; putS.push(l); } }
  }
  if (putS.length) await putSites(putS);
  const local = new Map((await allRecords()).map(r => [r.id, r])), put = [];
  for (const s of res.records || []) {
    const l = local.get(s.id);
    if (l) {
      let dirty = false;
      if (l.status !== 'sent' || l.recorderId !== s.recorderId) { l.status = 'sent'; l.recorderId = s.recorderId; dirty = true; }
      if (!opsOf(l).length) {   // 送っていない直し・変化が無い記録は、受け付けの今の内容に合わせる(別の端末で直した分も入る)
        for (const k of SERVER_KEYS) if (JSON.stringify(l[k]) !== JSON.stringify(s[k])) { l[k] = s[k]; dirty = true; }
      }
      if (dirty) put.push(l);
    }
    else put.push({ ...s, photos: [], remote: true, status: 'sent' }); // 別の端末や消した後の記録。写真はこの端末に無い
  }
  if (put.length) await putAll(put);
  if (auth && auth.recorderId !== res.recorderId) { auth.recorderId = res.recorderId; saveAuth(); renderAuth(); }
  await updateBadge();
  say(`自分の記録 ${res.records.length}件を受け付けから取り直しました`);
  renderActiveTab();
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

// 項目の選び肢を root の中に出し、押すと st(選んだ値の入れ物)に入れる。入力・直す・状態の変化で同じ部品を使う。
//  keys: 出す項目 / optional: もう一度押すと外れる項目 / idp: id の前置き(同じ画面に2つ出ても id が重ならないように)
//  current: 今の値(状態の変化の画面)。今と同じ選び肢には印を付け、押しても選ばない / onchange: 選んだ後に呼ぶ
function mountFields(root, st, { keys, optional = ['pet'], idp = '', current = null, onchange = () => {} }) {
  root.innerHTML = FIELDS.filter(f => keys.includes(f[0])).map(([k, label, opts, hint]) => `<div class="card"><h3>${label}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${current ? `<p class="now">今: ${esc(current[k] || '(未入力)')}</p>` : ''}<div class="opts" data-k="${k}">${opts.map(o => `<button type="button" data-v="${esc(o)}"${current && current[k] === o ? ' class="cur"' : ''}>${esc(o)}${current && current[k] === o ? '(今)' : ''}</button>`).join('')}</div></div>`).join('');
  const petBox = root.querySelector('.opts[data-k=pet]');
  if (petBox) petBox.insertAdjacentHTML('afterend', `<div id="${idp}petwhy" class="petwhy hidden"><p class="hint">理由があれば選んでください(いくつでも・任意)</p>
    <div class="opts" id="${idp}petreasons">${PET_REASONS.map(o => `<button type="button" data-r="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    <input id="${idp}petother" class="petother hidden" type="text" maxlength="${PET_OTHER_MAX}" placeholder="その他の理由(短く)" aria-label="その他の理由">
    <p class="note">人の名前や住所は書かないでください。</p></div>`);
  const why = () => root.querySelector('.petwhy'), other = () => root.querySelector('.petother');
  const resetWhy = () => {
    delete st.petReasons; delete st.petOther;
    root.querySelectorAll('.petwhy .opts button.sel').forEach(b => b.classList.remove('sel'));
    if (other()) { other().value = ''; other().classList.add('hidden'); }
  };
  const sync = () => { if (!why()) return; const on = st.pet === 'あり'; why().classList.toggle('hidden', !on); if (!on) resetWhy(); };   // 「あり」の時だけ理由を出す。外れたら理由は消す
  root.querySelectorAll('.opts[data-k]').forEach(box => box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = box.dataset.k, v = b.dataset.v;
    if (current && current[k] === v) return toast('今と同じです。変わった所だけ選んでください');
    if (optional.includes(k) && st[k] === v) { delete st[k]; b.classList.remove('sel'); } // 任意の項目: もう一度押すと外れる
    else { box.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b)); st[k] = v; }
    if (k === 'pet') sync();
    onchange();
  });
  if (why()) {
    why().querySelector('.opts').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      b.classList.toggle('sel'); st.petReasons = [...why().querySelectorAll('.opts button.sel')].map(x => x.dataset.r);
      other().classList.toggle('hidden', !st.petReasons.includes('その他'));
    };
    other().oninput = () => { st.petOther = other().value; };
  }
  // 値が入っていれば、選んだ状態にする(直す画面)
  keys.forEach(k => { const b = st[k] !== undefined && root.querySelector(`.opts[data-k=${k}] button[data-v="${CSS.escape(st[k])}"]`); if (b) b.classList.add('sel'); });
  if (why() && st.pet === 'あり') {
    why().classList.remove('hidden');
    (st.petReasons || []).forEach(r => { const b = why().querySelector(`button[data-r="${CSS.escape(r)}"]`); if (b) b.classList.add('sel'); });
    if ((st.petReasons || []).includes('その他')) { other().classList.remove('hidden'); other().value = st.petOther || ''; }
  }
  return { sync };
}
let formCtl;
function buildForm() {
  optionsDirty = false;
  formCtl = mountFields($('#fields'), form, { keys: FIELDS.map(f => f[0]), optional: ['pet'], idp: '', onchange: checkDup });
}

function setLocInfo(text, bad) { const el = $('#locinfo'); el.textContent = text; el.classList.toggle('bad', !!bad); }
function getGps() {
  loc = null; setLocInfo('位置: 取得中…'); checkDup(); renderSiteCands();
  if (!navigator.geolocation) return setLocInfo('位置: この端末では取得できません。「地図で場所を指定」を押してください', true);
  navigator.geolocation.getCurrentPosition(p => setLoc(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy), 'GPS'),
    () => setLocInfo('位置: 取得できませんでした。位置情報の許可を確かめるか、「地図で場所を指定」を押してください', true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function setLoc(lat, lng, acc, src) {
  loc = { lat, lng, acc, src }; renderSiteCands();
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

// ---- えさ場(自分の物だけ) ----
const liveSites = sites => sites.filter(x => !x.retired);
// ref から近い順の「使っているえさ場」。maxM を渡すとその距離内だけ
function sitesNear(sites, ref, maxM) {
  return liveSites(sites).map(x => ({ ...x, d: Math.round(distM(ref, x)) })).filter(x => maxM == null || x.d <= maxM).sort((a, b) => a.d - b.d);
}
const siteBtns = (list, sel, none) => `${none ? `<button type="button" data-site=""${sel === '' ? ' class="sel"' : ''}>${esc(none)}</button>` : ''}${list.map(x => `<button type="button" data-site="${esc(x.id)}"${sel === x.id ? ' class="sel"' : ''}>${esc(x.name)}<small>${x.d != null ? `約${x.d}m` : ''}${x.status === 'pending' ? ' 未送信' : ''}</small></button>`).join('')}`;
// 入力の画面: 今の位置から100m以内の自分のえさ場を近い順に出す。選ぶと結び付く(選ばなくてもよい)
let siteToken = 0;
async function renderSiteCands() {
  const box = $('#sitecands'), my = ++siteToken; if (!box) return;
  const sites = loc ? sitesNear(await allSites(), loc, SITE_NEAR_M) : [];
  if (my !== siteToken) return;
  if (form.siteId && !sites.some(x => x.id === form.siteId)) delete form.siteId;   // 場所を取り直して100mの外になったら外す
  box.innerHTML = siteBtns(sites, form.siteId || '', null);
  $('#sitenone').textContent = !loc ? '位置が決まると、近くのえさ場が出ます。' : sites.length ? '近くのえさ場です。この猫がそこに来ているなら選んでください(選ばなくてもかまいません。もう一度押すと外れます)。' : '100m以内に、登録したえさ場はありません。えさ場にまとめたい時は、下のボタンで登録できます。';
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
      area: '', lat: loc.lat, lng: loc.lng, acc: loc.acc, locSrc: loc.src, ...(meshCodes(loc.lat, loc.lng) || {}),   // 区域は決め打ちをやめた(えさ場と地域メッシュで表す)。メッシュは端末の計算(送信後は受け付けの値になる)
      ...form, ...(form.pet === 'あり' ? { petReasons: form.petReasons || [], petOther: form.petReasons && form.petReasons.includes('その他') ? (form.petOther || '').trim().slice(0, PET_OTHER_MAX) : '' } : { petReasons: undefined, petOther: undefined }),
      collar: form.pet === 'あり' && (form.petReasons || []).includes('首輪がある') ? 'あり' : '',   // 首輪は理由「首輪がある」だけで表す
      feature: $('#feature').value.trim(), photos, status: 'pending' }]);
  } catch { saving = false; $('#btn-save').disabled = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
  Object.keys(form).forEach(k => delete form[k]); photos = [];   // 入れ物は作り直さない(項目の部品が同じ入れ物を持っている)
  renderThumbs(); $('#feature').value = '';
  if (optionsDirty) buildForm(); else { document.querySelectorAll('#fields .opts button.sel').forEach(b => b.classList.remove('sel')); formCtl.sync(); }
  renderSiteCands();
  $('#dup').classList.add('hidden'); saving = false; $('#btn-save').disabled = false;
  await updateBadge(); toast(configured() && loggedIn() && navigator.onLine ? '保存しました。送っています…' : '保存しました(未送信)'); window.scrollTo(0, 0); getGps(); // 次の猫のために位置を取り直す
  syncQuiet().then(() => { if (!(configured() && loggedIn() && navigator.onLine)) return; updateBadge(); });
}

async function updateBadge() {
  const n = (await allRecords()).reduce((t, r) => t + (r.status === 'pending' ? 1 : 0) + opsOf(r).length, 0) + (await allSites()).reduce((t, x) => t + (x.status === 'pending' ? 1 : 0) + (x.ops || []).length, 0);
  $('#pending').textContent = n ? `未送信 ${n}` : '';
}
function renderActiveTab() {
  const t = document.querySelector('.tab.active'); if (!t) return;
  if (t.id === 'tab-list') renderList(); if (t.id === 'tab-map') renderMap(); if (t.id === 'tab-stats') renderStats(); if (t.id === 'tab-sites') renderSites(); if (t.id === 'tab-record') renderSiteCands(); if (t.id === 'tab-admin') renderAdmin();
}

// ---- 見る範囲(自分の記録 / 全員の記録)。「全員」は受け付けの入力者シートで役割「全体を見る」になっている人だけ ----
// 全員の記録は端末に保存しない(画面を開いている間だけ持つ)。ほかの人の記録は入力者 ID(番号)だけで出て、メール・名前は来ない。
let scope = 'mine', allView = null;
function renderScopeBar() {
  const bar = $('#scopebar'); if (!bar) return;
  const tab = document.querySelector('.tab.active'), show = !!(auth && auth.viewAll && loggedIn() && tab && ['tab-list', 'tab-map', 'tab-stats', 'tab-sites'].includes(tab.id));
  bar.classList.toggle('hidden', !show);
  bar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
}
async function setScope(sc, quiet) {
  if (sc === 'all') {
    if (!(auth && auth.viewAll)) return;
    if (!navigator.onLine) return toast('電波がありません。「全員の記録」は電波がある所で見られます', 4000);
    if (!quiet) toast('全員の記録を取っています…', 2000);
    const r = await api('list', { scope: 'all' });
    if (!r.ok) {
      if (r.error === 'not_allowed') { auth.viewAll = false; saveAuth(); }
      toast(errText(r.error), 5000); scope = 'mine'; allView = null; renderScopeBar(); renderActiveTab(); return;
    }
    allView = { records: r.records || [], sites: r.sites || [] }; scope = 'all';
  } else { scope = 'mine'; allView = null; }
  renderScopeBar(); if (!quiet) renderActiveTab();
}
const viewRecords = async () => scope === 'all' && allView ? allView.records : allRecords();
const viewSites = async () => scope === 'all' && allView ? allView.sites : allSites();
async function recById(id) {
  if (scope === 'all' && allView) { const a = allView.records.find(x => x.id === id); if (a) { if (a.mine) { const l = await getRecord(id); if (l) return l; } return a; } }
  return getRecord(id);
}
const siteNameOf = (id, sm) => id ? ((sm.get(id) || {}).name || 'えさ場(見つかりません)') : '';
const whoText = r => r.recorderId ? `入力者 ID ${String(r.recorderId).slice(0, 6)}` : '';

// ---- 一覧 ----
let listFilter = 'pending', listUrls = [];
async function renderList() {
  listUrls.forEach(u => URL.revokeObjectURL(u)); listUrls = [];
  const all = scope === 'all';
  $('#listmine').classList.toggle('hidden', all);
  document.querySelectorAll('#listfilter button').forEach(b => b.classList.toggle('active', b.dataset.f === listFilter));
  const sm = new Map((await viewSites()).map(x => [x.id, x]));
  const rs = (await viewRecords()).filter(r => all || listFilter === 'all' || (listFilter === 'pending' ? r.status === 'pending' || opsOf(r).length : r.status === listFilter)).sort((a, b) => b.time.localeCompare(a.time));
  $('#list').innerHTML = rs.length ? rs.map(r => {
    let img = ''; if (r.photos && r.photos[0]) { const u = URL.createObjectURL(r.photos[0]); listUrls.push(u); img = `<img src="${u}" alt="">`; }
    const nPhoto = r.photos && r.photos.length ? ` 写真${r.photos.length}枚` : (r.photoCount ? ` 写真${r.photoCount}枚(受け付け側)` : ''), sn = siteNameOf(r.siteId, sm);
    const st = all ? `<span class="st remote">${r.mine ? '自分の記録' : esc(whoText(r))}</span>` : `<span class="st ${r.status === 'sent' && !opsOf(r).length ? 'sent' : ''}">${r.status !== 'sent' ? '未送信' : opsOf(r).length ? `送信済み(直し・変化 ${opsOf(r).length}件が送信待ち)` : '送信済み'}</span>${r.remote ? ' <span class="st remote">(受け付けから取り直した記録)</span>' : ''}`;
    return `<div class="item" data-id="${esc(r.id)}" role="button" tabindex="0">${img}<div><b>${esc(r.color)}</b> さくら耳:${esc(r.ear)} ${esc(r.sex)} ${esc(r.age)} ${marksHtml(r)}${petText(r) ? `<br><span class="pet">${esc(petText(r))}</span>` : ''}${sn ? `<br><span class="sitetag">えさ場: ${esc(sn)}</span>` : ''}<br>
    <span class="note">${fmt(r.time)}${r.area ? ' ' + esc(r.area) : ''}${nPhoto}</span><br>
    ${st} ${esc(r.feature || '')}</div></div>`; }).join('')
    : `<p>${all ? '記録はまだありません' : listFilter === 'pending' ? '未送信の記録はありません' : '記録はまだありません'}</p>`;
}

// ---- 地図 ----
let map, layer, meLayer, picking = false, pickTarget = 'cat', mapAuto = false, mapFocus = null;
function setPicking(on) { picking = on; $('#pickmsg').classList.toggle('hidden', !on); $('#pickwhat').textContent = pickTarget === 'site' ? 'えさ場にする場所' : '猫がいた場所'; }
const siteIcon = () => L.divIcon({ className: 'siteicon-wrap', html: '<span class="siteicon"></span>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map').setView([35.155, 136.93], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map); meLayer = L.layerGroup().addTo(map);
  $('#map').addEventListener('click', e => { const b = e.target.closest('button[data-open]'); if (b) openDetail(b.dataset.open); });
  map.on('click', e => {
    if (!picking) return; setPicking(false);
    if (pickTarget === 'site') { showTab('sites'); openSiteForm({ lat: e.latlng.lat, lng: e.latlng.lng, acc: null, src: '地図' }); }
    else { setLoc(e.latlng.lat, e.latlng.lng, null, '地図'); showTab('record'); }
  });
}
// 今の場所(青い丸 = 誤差の広がり)を描く
function drawMe(g) {
  meLayer.clearLayers();
  L.circle([g.lat, g.lng], { radius: Math.max(g.acc || 0, 5), color: '#1c7ed6', weight: 2, fillColor: '#4dabf7', fillOpacity: .2, className: 'me-acc', interactive: false }).addTo(meLayer);
  L.circleMarker([g.lat, g.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1, className: 'me-dot', interactive: false }).addTo(meLayer);
}
async function fitMine() {
  const pts = [...(await viewRecords()), ...liveSites(await viewSites())].filter(x => isFinite(x.lat) && isFinite(x.lng)).map(x => [x.lat, x.lng]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.2), { maxZoom: 17, animate: false });
}
// 「今の場所へ」: GPS を取り直し、地図の中心を今の場所にする。開いた時(auto)も同じ。取れなければ、自分の記録の範囲を出す
async function locateMe(auto) {
  initMap(); if (!map) return;
  const btn = $('#btn-here'); btn.disabled = true; if (!auto) toast('今の場所を取っています…', 2500);
  const g = await getPos(); btn.disabled = false;
  map.invalidateSize();
  if (g) { drawMe(g); map.setView([g.lat, g.lng], Math.max(map.getZoom(), 16), { animate: false }); if (!auto) toast(`今の場所へ移りました(誤差 約${g.acc}m)`, 2500); }
  else if (auto) await fitMine();
  else toast('今の場所を取れませんでした。位置情報の許可を確かめてください', 4500);
}
async function renderMap() {
  initMap(); if (!map) return; layer.clearLayers();
  const sites = await viewSites(), sm = new Map(sites.map(x => [x.id, x]));
  (await viewRecords()).forEach(r => L.circleMarker([r.lat, r.lng], { radius: 10, weight: 2, color: '#fff', fillOpacity: .9, className: 'catdot',
    fillColor: hasEar(r) ? '#d6336c' : r.ear === 'なし' ? '#1971c2' : '#888' })
    .bindPopup(`<b>${esc(r.color)}</b><br>さくら耳: ${esc(r.ear)}<br>${petText(r) ? esc(petText(r)) + '<br>' : ''}${r.siteId ? 'えさ場: ' + esc(siteNameOf(r.siteId, sm)) + '<br>' : ''}${r.area ? esc(r.area) + '<br>' : ''}${fmt(r.time)}<br>${scope === 'all' ? (r.mine ? '自分の記録' : esc(whoText(r))) : r.status === 'sent' ? '送信済み' : '未送信'}${marksText(r) ? `<br><b class="pmark">${esc(marksText(r))}</b>` : ''}<br><button type="button" class="small popen" data-open="${esc(r.id)}">詳しく見る${r.mine === false ? '' : '・直す'}</button>`).addTo(layer));
  liveSites(sites).forEach(x => L.marker([x.lat, x.lng], { icon: siteIcon(), title: x.name, keyboard: false })
    .bindPopup(`<b>えさ場: ${esc(x.name)}</b>${x.memo ? '<br>' + esc(x.memo) : ''}<br>メッシュ ${esc(x.mesh500 || '')}${scope === 'all' && x.mine === false ? '<br>' + esc(whoText(x)) : ''}`).addTo(layer));
  setTimeout(() => map.invalidateSize(), 50);
}

// ---- 集計(自分の記録だけ。全員の記録に切り替えた時は全員分)----
function tally(rs, keyFn) {
  const by = new Map();
  rs.forEach(r => { const k = keyFn(r), a = by.get(k) || { n: 0, ear: 0, no: 0, unk: 0, pet: 0 }; a.n++; if (hasEar(r)) a.ear++; else if (r.ear === 'なし') a.no++; if (r.ear === UNKNOWN_EAR) a.unk++; if (effPet(r) === 'あり') a.pet++; by.set(k, a); });
  return by;
}
function statTable(title, head, rows) {
  const row = (name, a) => { const judged = a.n - a.unk; return `<tr><td class="nm">${esc(name)}</td><td>${a.n}</td><td>${a.ear}</td><td>${a.no}</td><td>${a.unk}</td><td>${judged ? Math.round(a.ear / judged * 100) + '%' : '—'}</td><td>${a.pet}</td></tr>`; };
  const tot = rows.reduce((t, [, a]) => ({ n: t.n + a.n, ear: t.ear + a.ear, no: t.no + a.no, unk: t.unk + a.unk, pet: t.pet + a.pet }), { n: 0, ear: 0, no: 0, unk: 0, pet: 0 });
  return `<div class="card"><h3>${esc(title)}</h3>${rows.length ? `<table class="stat"><tr><th>${esc(head)}</th><th>頭数</th><th>さくら耳あり</th><th>なし</th><th>確認できず</th><th>割合</th><th>飼い猫の可能性あり</th></tr>${rows.map(([k, a]) => row(k, a)).join('')}${row('合計', tot)}</table>` : '<p>まだ記録がありません</p>'}</div>`;
}
async function renderStats() {
  const rs = await viewRecords(), sites = await viewSites(), sm = new Map(sites.map(x => [x.id, x])), who = scope === 'all' ? '全員' : '自分';
  const bySite = [...tally(rs, r => r.siteId || '').entries()].map(([k, a]) => [k ? siteNameOf(k, sm) + (sm.get(k) && sm.get(k).retired ? '(使っていない)' : '') : 'えさ場なし', a]).sort((a, b) => (a[0] === 'えさ場なし') - (b[0] === 'えさ場なし') || a[0].localeCompare(b[0], 'ja'));
  const byMesh = [...tally(rs, meshOf).entries()].map(([k, a]) => [k || '(位置不明)', a]).sort((a, b) => a[0].localeCompare(b[0]));
  $('#stats').innerHTML = statTable(`えさ場ごとの頭数と、さくら耳の割合(${who}の記録)`, 'えさ場', bySite) + statTable(`地域メッシュ(500m)ごと(${who}の記録)`, 'メッシュ番号', byMesh) +
    `<div class="card"><p class="note">頭数は記録の数です。同じ猫を二度記録していることがあるため、猫の頭数と同じとは限りません。割合は、さくら耳が「確認できず」の猫をのぞいた頭数のうち、さくら耳(不妊手術が済んだ印)がある猫の割合です。「飼い猫の可能性あり」は、飼い猫かもしれないと入力された数(首輪がある猫を含む)で、頭数の推定から外したいときは引いて考えます。メッシュ番号は、緯度経度から自動で付く約500m四方の区画の番号(地域メッシュ)です。${scope === 'all' ? '' : '全体の集計は受け付け側のスプレッドシートで見ます。'}</p></div>`;
}

// ---- えさ場の画面 ----
async function renderSites() {
  const all = scope === 'all', sites = await viewSites(), rs = await viewRecords(), cnt = new Map();
  rs.forEach(r => { if (r.siteId) cnt.set(r.siteId, (cnt.get(r.siteId) || 0) + 1); });
  $('#sitehead').classList.toggle('hidden', all);
  const card = x => {
    const own = !all || x.mine !== false, pend = x.status === 'pending' ? '未送信' : (x.ops || []).length ? '送信待ちの直しあり' : '送信済み';
    return `<div class="card site" data-id="${esc(x.id)}"><b>${esc(x.name)}</b>${x.retired ? ' <span class="mark">使っていない</span>' : ''}${x.memo ? `<br><span class="note">${esc(x.memo)}</span>` : ''}
    <br><span class="note">この場所の記録 ${cnt.get(x.id) || 0}件・メッシュ ${esc(x.mesh500 || '')}${all && !own ? '・' + esc(whoText(x)) : ''}</span>${all ? '' : `<br><span class="st ${x.status === 'sent' && !(x.ops || []).length ? 'sent' : ''}">${pend}</span>`}
    <div class="row">${own && !all ? `<button type="button" class="small" data-act="rename">名前を直す</button><button type="button" class="small" data-act="${x.retired ? 'restore' : 'retire'}">${x.retired ? 'また使う' : '使わない'}</button>` : ''}<button type="button" class="small" data-act="map">地図で見る</button></div></div>`; };
  const live = liveSites(sites).sort((a, b) => a.name.localeCompare(b.name, 'ja')), off = sites.filter(x => x.retired).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  $('#sitelist').innerHTML = (live.length ? live.map(card).join('') : `<p>${all ? 'えさ場はまだありません' : 'えさ場はまだありません。上のボタンで登録できます'}</p>`) + (off.length ? `<h3>使っていないえさ場</h3>${off.map(card).join('')}` : '');
}
async function startSiteHere(after) {
  toast('今の位置を取っています…', 2500); const g = await getPos();
  if (!g) return toast('位置を取れませんでした。位置情報の許可を確かめるか、「地図で場所を指定して登録」を使ってください', 5000);
  openSiteForm({ ...g, src: 'GPS' }, after);
}
// えさ場を登録する画面。pos = {lat,lng,acc,src}。保存後に after(site) を呼ぶ(無ければ、えさ場の画面に戻る)
function openSiteForm(pos, after) {
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>えさ場を登録</b></div>
  <div class="sheetbody"><div class="warn">猫がよく集まる餌場・たまり場を、自分用に登録します。出るのは自分の一覧と地図だけです(研究会で「全体を見る」役割の人は全員分を見られます)。<br>名前は短く。人の名前や住所は書かないでください。</div>
  <div class="card"><p class="note" id="sf-loc">位置: ${pos.src === 'GPS' ? `GPSで取得(誤差 約${pos.acc}m)` : pos.src === '地図' ? '地図で指定しました' : esc(pos.src || '')}　メッシュ ${esc((meshCodes(pos.lat, pos.lng) || {}).mesh500 || '')}</p>
  <label class="fl">名前<input id="sf-name" type="text" maxlength="${SITE_NAME_MAX}" placeholder="例: 公園の東の入口"></label>
  <label class="fl">メモ(任意)<input id="sf-memo" type="text" maxlength="${SITE_MEMO_MAX}" placeholder="例: 朝に餌をあげる人が来る"></label></div>
  <button type="button" id="sf-save" class="primary">このえさ場を登録する</button><button type="button" id="sf-cancel" class="wide">やめる</button></div>`);
  $('#s-back').onclick = $('#sf-cancel').onclick = () => closeSheet();
  $('#sf-save').onclick = async () => {
    if (sheetBusy) return;
    const name = $('#sf-name').value.replace(/\s+/g, ' ').trim().slice(0, SITE_NAME_MAX), memo = $('#sf-memo').value.replace(/\s+/g, ' ').trim().slice(0, SITE_MEMO_MAX);
    if (!name) return toast('名前を入れてください');
    sheetBusy = true;
    const site = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, memo, lat: pos.lat, lng: pos.lng, acc: pos.acc ?? null, recorderId: auth && auth.recorderId || null,
      createdAt: new Date().toISOString(), retired: false, status: 'pending', ops: [], ...(meshCodes(pos.lat, pos.lng) || {}) };
    try { await putSites([site]); } catch { sheetBusy = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
    sheetBusy = false; await updateBadge();
    toast(configured() && loggedIn() && navigator.onLine ? 'えさ場を登録しました。送っています…' : 'えさ場を登録しました(未送信。電波が戻ったら送ります)');
    closeSheet(); if (after) await after(site);
    syncQuiet().then(() => updateBadge().then(renderActiveTab));
  };
}
async function openSiteEdit(id) {
  const x = await getSite(id); if (!x) return;
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>えさ場の名前を直す</b></div>
  <div class="sheetbody"><div class="card"><label class="fl">名前<input id="se-name" type="text" maxlength="${SITE_NAME_MAX}"></label><label class="fl">メモ(任意)<input id="se-memo" type="text" maxlength="${SITE_MEMO_MAX}"></label>
  <p class="note">場所は直せません。場所が違う時は、「使わない」にして、新しく登録してください。</p></div>
  <button type="button" id="se-save" class="primary">この内容に直す</button><button type="button" id="se-cancel" class="wide">やめる</button></div>`);
  $('#se-name').value = x.name; $('#se-memo').value = x.memo || '';
  $('#s-back').onclick = $('#se-cancel').onclick = () => closeSheet();
  $('#se-save').onclick = async () => {
    const name = $('#se-name').value.replace(/\s+/g, ' ').trim().slice(0, SITE_NAME_MAX), memo = $('#se-memo').value.replace(/\s+/g, ' ').trim().slice(0, SITE_MEMO_MAX);
    if (!name) return toast('名前を入れてください');
    const f = {}; if (name !== x.name) f.name = name; if (memo !== (x.memo || '')) f.memo = memo;
    if (!Object.keys(f).length) return toast('直した所がありません');
    const cur = await getSite(id); Object.assign(cur, f);
    if (cur.status === 'sent') cur.ops = [...(cur.ops || []), { opId: 'o' + Date.now().toString(36), type: 'siteEdit', fields: f, queuedAt: new Date().toISOString() }];   // 未送信の登録は、送る時に新しい名前で出る
    await putSites([cur]); await updateBadge(); toast(cur.status === 'sent' ? '直しました。送っています…' : '直しました'); closeSheet(); syncQuiet().then(() => updateBadge().then(renderActiveTab));
  };
}
async function setSiteRetired(id, retired) {
  const x = await getSite(id); if (!x) return;
  if (retired && !confirm('このえさ場を「使っていない」にします。記録は消えません(行も残ります)。よろしいですか?')) return;
  x.retired = retired; x.ops = [...(x.ops || []), { opId: 'o' + Date.now().toString(36), type: 'siteEdit', fields: { retired }, queuedAt: new Date().toISOString() }];
  await putSites([x]); await updateBadge(); toast(retired ? '「使っていない」にしました' : 'また使えるようにしました'); renderSites(); syncQuiet().then(() => updateBadge().then(renderActiveTab));
}
// えさ場を1つ選ぶ部品(直す・状態の変化)。list = 候補、cur = 今のえさ場ID(印を付け、押しても選ばない)、toggle = もう一度押すと外れる
function mountSitePicker(root, { list, selected, none, cur, toggle, onpick }) {
  let sel = selected;
  const draw = () => { root.innerHTML = list.map(x => `<button type="button" data-site="${esc(x.id)}" class="${sel === x.id ? 'sel' : ''}${cur === x.id ? ' cur' : ''}">${esc(x.name)}${cur === x.id ? '(今)' : ''}<small>${x.d != null ? `約${x.d}m` : ''}${x.status === 'pending' ? ' 未送信' : ''}</small></button>`).join('') + (none ? `<button type="button" data-site="" class="${sel === '' ? 'sel' : ''}${cur === '' ? ' cur' : ''}">${esc(none)}${cur === '' ? '(今)' : ''}</button>` : ''); };
  draw();
  root.onclick = e => {
    const b = e.target.closest('button[data-site]'); if (!b) return; const v = b.dataset.site;
    if (cur !== undefined && v === cur) return toast('今と同じです。変わった所だけ選んでください');
    sel = toggle && sel === v ? undefined : v; draw(); onpick(sel);
  };
}

// ---- 詳しい画面・間違いを直す・状態が変わった ----
// 画面全体にかぶせる「シート」(#sheet)。閉じると一覧・地図を描き直す。
const LABELS = { color: '毛色・模様', ear: 'さくら耳', managed: '地域猫として世話', feeder: '餌をあげている人', age: '年齢のめやす', sex: '性別', body: '体の様子', tail: '尻尾', tame: '人への慣れ', siteId: 'えさ場' };
let sheetUrls = [], sheetBusy = false, sheetId = null;
const fmtShort = t => { const d = new Date(t); return isNaN(d) ? String(t || '') : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const mine = r => r.mine !== false && (!r.recorderId || !auth || !auth.recorderId || r.recorderId === auth.recorderId);   // 自分の記録か(分からない時は受け付けが確かめる)
function showSheet(html) { const el = $('#sheet'); sheetUrls.forEach(u => URL.revokeObjectURL(u)); sheetUrls = []; el.innerHTML = html; el.classList.remove('hidden'); el.scrollTop = 0; document.body.classList.add('noscroll'); }
function closeSheet() {
  const el = $('#sheet'); sheetId = null; el.classList.add('hidden'); el.innerHTML = ''; sheetUrls.forEach(u => URL.revokeObjectURL(u)); sheetUrls = []; document.body.classList.remove('noscroll');
  renderActiveTab(); if (optionsDirty && !Object.keys(form).length) buildForm();
}
const rowLine = (label, v) => v ? `<div class="line2"><span class="lbl">${esc(label)}</span><span>${esc(v)}</span></div>` : '';

async function openDetail(id) {
  const r = await recById(id); if (!r) return; sheetId = id;
  const sm = new Map((await viewSites()).map(x => [x.id, x])), all = scope === 'all';
  let img = ''; if (r.photos && r.photos[0]) { const u = URL.createObjectURL(r.photos[0]); sheetUrls.push(u); img = `<img class="dphoto" src="${u}" alt="写真">`; }
  const ops = opsOf(r), pendingChanges = ops.filter(o => o.type === 'change'), pendingEdits = ops.filter(o => o.type === 'edit').length;
  const chItems = (items, wait) => items.map(i => `<div class="chg-line">${esc(i.label)}: ${esc(i.from || '(未入力)')} → <b>${esc(i.to || '(なし)')}</b>${wait ? ' <span class="st">(送信待ち)</span>' : ''}</div>`).join('');
  const hist = [...(r.changes || []).map(e => `<div class="chg"><div class="note">${fmtShort(e.time)}</div>${chItems(e.items, false)}</div>`),
    ...pendingChanges.map(o => `<div class="chg"><div class="note">${fmtShort(o.time)}</div>${Object.entries(o.changes).map(([k, v]) => `<div class="chg-line">${esc(k === 'pet' ? '飼い猫の可能性' : LABELS[k] || k)} → <b>${esc(k === 'siteId' ? (siteNameOf(v, sm) || '(なし)') : v)}</b> <span class="st">(送信待ち)</span></div>`).join('')}</div>`)];
  const own = mine(r), unsent = r.status !== 'sent';
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>記録の詳しい内容</b></div>
  <div class="sheetbody">
  <div class="card">${img}<h3>${esc(r.color)}　さくら耳: ${esc(r.ear)} ${marksHtml(r)}</h3>
    ${rowLine('記録した日時', fmt(r.time))}${all && !own ? rowLine('入力した人', whoText(r)) : ''}${rowLine('えさ場', siteNameOf(r.siteId, sm))}${rowLine('地域メッシュ', meshOf(r))}${rowLine('区域', r.area)}${rowLine('世話', r.managed)}${rowLine('餌をあげる人', r.feeder)}${rowLine('年齢', r.age)}${rowLine('性別', r.sex)}${rowLine('体の様子', r.body)}${rowLine('尻尾', r.tail)}${rowLine('人への慣れ', r.tame)}${rowLine('飼い猫の可能性', petText(r).replace('飼い猫の可能性: ', ''))}${rowLine('特徴', r.feature)}
    ${rowLine('写真', r.photos && r.photos.length ? r.photos.length + '枚' : r.photoCount ? r.photoCount + '枚(受け付け側)' : '')}
    ${all && !own ? '' : `<div class="line2"><span class="lbl">送信</span><span class="st ${unsent ? '' : 'sent'}">${unsent ? '未送信' : '送信済み'}</span></div>`}</div>
  <div class="card"><h3>これまでの変化(${hist.length}回)</h3>${hist.length ? hist.join('') : '<p class="note">状態の変化はまだ記録されていません。</p>'}
    ${editMarks(r) ? `<p class="note">この記録は、入力のまちがいを${editMarks(r)}回直しています${r.editedAt ? '(最後に直した日時: ' + esc(fmtShort(r.editedAt)) + ')' : ''}${pendingEdits ? `。うち${pendingEdits}回は送信待ちです` : ''}。</p>` : ''}</div>
  ${own ? `<button type="button" id="s-edit" class="act">間違いを直す<small>入力をまちがえた時。この記録をそのまま書き換えます</small></button>
  <button type="button" id="s-change" class="act orange"${unsent ? ' disabled' : ''}>状態が変わった<small>未手術→手術済み・さくら耳が付いた・えさ場が変わった など。履歴に足していきます</small></button>
  ${unsent ? '<p class="note">まだ送っていない記録です。「状態が変わった」は、送ってから使えます(間違いは今すぐ直せます)。</p>' : ''}`
    : '<p class="warn">この記録は別の人の物なので、直せません。</p>'}
  </div>`);
  $('#s-back').onclick = closeSheet;
  if (own) { $('#s-edit').onclick = () => openEdit(id); $('#s-change').onclick = () => openChange(id); }
}

async function openEdit(id) {
  const r = await getRecord(id); if (!r) return;
  const st = {}; EDIT_FIELD_KEYS.forEach(k => { if (r[k]) st[k] = r[k]; });
  st.petReasons = [...(r.petReasons || [])]; st.petOther = r.petOther || ''; st.siteId = r.siteId || '';
  const sites = await allSites(), here = sitesNear(sites, r), curSite = sites.find(x => x.id === r.siteId);
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>間違いを直す</b></div>
  <div class="sheetbody"><div class="warn">入力をまちがえた所だけ直してください。この記録がそのまま書き換わり、シートに「直した日時」が残ります。<br>写真と場所は、ここでは直せません。猫の状態が変わったときは、「状態が変わった」を使ってください。</div>
  <div class="card"><h3>えさ場</h3><p class="hint">この猫が来ているえさ場(自分のえさ場だけ。近い順)</p><div class="opts siteopts" id="e-site"></div></div>
  <div id="e-fields"></div>
  <div class="card"><h3>目立つ特徴(任意)</h3><textarea id="e-feature" rows="2"></textarea></div>
  <button type="button" id="e-save" class="primary">この内容に直す</button>
  <button type="button" id="e-cancel" class="wide">やめる</button></div>`);
  mountSitePicker($('#e-site'), { list: curSite && curSite.retired ? [{ ...curSite, d: Math.round(distM(r, curSite)) }, ...here] : here, selected: st.siteId, none: 'えさ場なし', onpick: v => { st.siteId = v; } });
  mountFields($('#e-fields'), st, { keys: EDIT_FIELD_KEYS, optional: ['pet'], idp: 'e-' });
  $('#e-feature').value = r.feature || '';
  $('#s-back').onclick = $('#e-cancel').onclick = () => openDetail(id);
  $('#e-save').onclick = async () => {
    if (sheetBusy) return;
    const miss = FIELDS.filter(f => REQUIRED.includes(f[0]) && !st[f[0]]).map(f => f[1]);
    if (miss.length) return toast('まだ選んでいない項目があります:\n' + miss.join('、'), 5000);
    const fields = {}, feature = $('#e-feature').value.trim();
    EDIT_FIELD_KEYS.forEach(k => { const nv = st[k] ?? ''; if (nv !== (r[k] ?? '')) fields[k] = nv; });
    if ((st.siteId || '') !== (r.siteId || '')) fields.siteId = st.siteId || '';
    if (feature !== (r.feature || '')) fields.feature = feature;
    const reasons = st.pet === 'あり' ? [...(st.petReasons || [])] : [], other = reasons.includes('その他') ? (st.petOther || '').trim().slice(0, PET_OTHER_MAX) : '';
    if ('pet' in fields ? st.pet === 'あり' : (JSON.stringify(reasons) !== JSON.stringify(r.petReasons || []) || other !== (r.petOther || ''))) { fields.petReasons = reasons; fields.petOther = other; }
    if (!Object.keys(fields).length) return toast('直した所がありません');
    sheetBusy = true;
    try {
      const nr = { ...r, ...fields };
      if ('pet' in fields || 'petReasons' in fields) { nr.petReasons = fields.petReasons || []; nr.petOther = fields.petOther || ''; if (r.pet || !r.collar) nr.collar = nr.pet === 'あり' && nr.petReasons.includes('首輪がある') ? 'あり' : ''; }   // 首輪は理由に合わせる(古い形の首輪は消さない)
      if (r.status === 'sent') nr.ops = [...opsOf(r), { type: 'edit', opId: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), queuedAt: new Date().toISOString(), fields }];   // 送った記録は、直しを貯めて送る(電波が無くても貯まる)
      await putAll([nr]);
    } catch { sheetBusy = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
    sheetBusy = false; await updateBadge();
    toast(r.status === 'sent' ? (configured() && loggedIn() && navigator.onLine ? '直しました。送っています…' : '直しました(送信待ち。電波が戻ったら送ります)') : '直しました(まだ送っていない記録なので、そのまま書き換えました)');
    await openDetail(id); syncQuiet().then(async () => { await updateBadge(); if (sheetId === id && $('#s-edit')) openDetail(id); });
  };
}

const getPos = () => new Promise(ok => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }), () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }) : ok(null));
async function openChange(id) {
  const r = await getRecord(id); if (!r || r.status !== 'sent') return;
  const st = {}, cur = {}; CHANGE_ITEMS.forEach(k => { cur[k] = r[k] || ''; });
  const sites = await allSites(), sm = new Map(sites.map(x => [x.id, x])), curSite = r.siteId || '';
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>状態が変わった</b></div>
  <div class="sheetbody"><div class="warn">変わった項目だけ選んでください。選ばなかった項目は、そのままです。<br>記録は書き換えず、「いつ・何が変わったか」を履歴に足します。日時は今の時刻が自動で入ります。<br>手術が済んだと分かったときは、「さくら耳」の右か左を選んでください。</div>
  <div id="c-fields"></div>
  <div class="card"><h3>えさ場</h3><p class="now">今: ${esc(curSite ? siteNameOf(curSite, sm) : 'えさ場なし')}</p><p class="hint">えさ場が変わった時だけ選んでください(自分のえさ場だけ。近い順)</p><div class="opts siteopts" id="c-site"></div></div>
  <div class="card"><label class="line chk"><input type="checkbox" id="c-loc"><span>今いる場所も一緒に記録する(任意)</span></label><p class="note">変化に気づいた場所の目安です。この猫の記録の場所は変わりません。</p></div>
  <button type="button" id="c-save" class="primary">この変化を記録する</button>
  <button type="button" id="c-cancel" class="wide">やめる</button></div>`);
  mountFields($('#c-fields'), st, { keys: CHANGE_ITEMS, optional: CHANGE_ITEMS, idp: 'c-', current: cur });
  mountSitePicker($('#c-site'), { list: sitesNear(sites, r), selected: undefined, none: curSite ? 'えさ場なし' : null, cur: curSite, toggle: true, onpick: v => { if (v === undefined) delete st.siteId; else st.siteId = v; } });
  $('#s-back').onclick = $('#c-cancel').onclick = () => openDetail(id);
  $('#c-save').onclick = async () => {
    if (sheetBusy) return;
    const changes = {}; CHANGE_ITEMS.forEach(k => { if (st[k] && st[k] !== cur[k]) changes[k] = st[k]; });
    if (st.siteId !== undefined && st.siteId !== curSite) changes.siteId = st.siteId;
    if (!Object.keys(changes).length) return toast('変わった項目を選んでください');
    sheetBusy = true; $('#c-save').disabled = true;
    const op = { type: 'change', opId: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), queuedAt: new Date().toISOString(), time: new Date().toISOString(), changes };
    if (changes.pet === 'あり') { op.petReasons = [...(st.petReasons || [])]; op.petOther = op.petReasons.includes('その他') ? (st.petOther || '').trim().slice(0, PET_OTHER_MAX) : ''; }
    if ($('#c-loc').checked) { toast('位置を取っています…'); const g = await getPos(); if (g) Object.assign(op, g); else toast('位置は取れなかったので、位置なしで記録します', 4000); }
    try {
      const fresh = await getRecord(id), nr = { ...fresh, ...changes, ops: [...opsOf(fresh), op] };
      if ('pet' in changes) { nr.petReasons = changes.pet === 'あり' ? (op.petReasons || []) : []; nr.petOther = changes.pet === 'あり' ? (op.petOther || '') : ''; if (fresh.pet || !fresh.collar) nr.collar = nr.petReasons.includes('首輪がある') ? 'あり' : ''; }
      await putAll([nr]);
    } catch { sheetBusy = false; return toast('保存できませんでした。端末の空きが足りないかもしれません', 6000); }
    sheetBusy = false; await updateBadge();
    toast(configured() && loggedIn() && navigator.onLine ? '変化を記録しました。送っています…' : '変化を記録しました(送信待ち。電波が戻ったら送ります)');
    await openDetail(id); syncQuiet().then(async () => { await updateBadge(); if (sheetId === id && $('#s-edit')) openDetail(id); });
  };
}

// ---- 管理の画面(役割「管理者」の Google の人だけ。受け付けも毎回「管理者か」で照らす)----
const ROLE_LABEL = r => r === '管理者' ? '管理者' : r === '全体を見る' ? '全体を見る' : '入力者';
const ROLE_OPTIONS = sel => ['', '全体を見る', '管理者'].map(r => `<option value="${r}"${r === sel ? ' selected' : ''}>${ROLE_LABEL(r)}</option>`).join('');
let adminData = null, adminShow = new Set();   // adminShow: メールを全部見せている人の鍵
async function renderAdmin() {
  const box = $('#admin'); if (!box) return;
  if (!(loggedIn() && auth.admin && !isCard())) { box.innerHTML = '<div class="card"><p class="note">この画面は、研究会で「管理者」の役割になっている Google アカウントの人だけが使えます。</p></div>'; return; }
  if (!navigator.onLine) { box.innerHTML = '<div class="card"><p class="warn">電波がありません。管理の画面は電波がある所で使えます。</p></div>'; return; }
  box.innerHTML = '<div class="card"><p class="note">読み込んでいます…</p></div>';
  const r = await api('adminList'); if (!r.ok) { box.innerHTML = `<div class="card"><p class="warn">${esc(errText(r.error))}</p></div>`; if (r.error === 'not_allowed') { auth.admin = false; saveAuth(); renderAuth(); } return; }
  adminData = r;
  const people = r.recorders.slice().sort((a, b) => (a.type === 'card') - (b.type === 'card') || (a.name || a.email).localeCompare(b.name || b.email, 'ja'));
  const person = x => {
    const title = x.type === 'card' ? esc(x.name || '(呼び名なし)') : (adminShow.has(x.key) ? esc(x.email) : esc(x.masked));
    const last = x.lastUsed ? fmtShort(x.lastUsed) : (x.firstLogin ? fmtShort(x.firstLogin) : 'まだ使っていない');
    return `<div class="card person${x.stopped ? ' stopped' : ''}" data-key="${esc(x.key)}">
      <div class="ptop"><b class="pname">${title}</b><span class="mark ${x.type === 'card' ? 'chg' : 'edit'}">${x.type === 'card' ? 'カード' : 'Google'}</span>${x.type === 'google' ? `<button type="button" class="tiny" data-act="peek">${adminShow.has(x.key) ? '隠す' : 'メールを見る'}</button>` : ''}</div>
      <div class="note">${x.type === 'card' ? `番号を間違えた回数: ${x.fails}${x.roleIgnored ? '・シートの役割は無視されます' : ''}` : `役割: <select class="rolesel" data-act="role" aria-label="役割">${ROLE_OPTIONS(x.role)}</select>`}
      <br>状態: <b>${x.stopped ? esc('止めた' + (x.state && x.state !== '止めた' ? '(' + x.state + ')' : '')) : '使える'}</b>・最後に使った: ${esc(last)}${x.recorderId ? `・ID ${esc(String(x.recorderId).slice(0, 6))}` : ''}</div>
      <div class="row"><button type="button" class="small" data-act="${x.stopped ? 'restore' : 'stop'}">${x.stopped ? 'また使う' : '止める'}</button>${x.type === 'card' ? `<button type="button" class="small" data-act="resetpin">番号を戻す</button><button type="button" class="small" data-act="reissue">カードを作り直す</button>` : ''}</div></div>`; };
  box.innerHTML = `<div class="card"><h3>Google の人を登録</h3><p class="note">Google アカウントで入力する人。メールアドレスと役割を入れます(メールはこの画面でも伏字で出ます)。</p>
      <label class="fl">メールアドレス<input id="ad-email" type="email" inputmode="email" autocomplete="off" placeholder="例: taro@example.com"></label>
      <label class="fl">役割<select id="ad-role" class="rolesel wide">${ROLE_OPTIONS('')}</select></label>
      <button type="button" id="ad-add" class="wide">この人を登録する</button></div>
    <div class="card"><h3>ログインカードを作る</h3><p class="note">Google のアカウントが無い人向け。呼び名(本名でなくてよい。例: 東町Aさん)と、その人に伝える暗証番号(数字4つ)を入れます。合言葉は作った直後の画面に1回だけ出ます(受け付けにもシートにも残りません)。</p>
      <label class="fl">呼び名<input id="ad-name" type="text" maxlength="20" autocomplete="off" placeholder="例: 東町Aさん"></label>
      <label class="fl">暗証番号(4けた)<input id="ad-pin" class="pin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="例: 2580"></label>
      <button type="button" id="ad-card" class="primary">カードを作る(QR を出す)</button></div>
    <h3 class="listhead">入力者の一覧(${people.length}人・管理者 ${r.admins}人)</h3>${people.map(person).join('') || '<p class="note">まだ誰も登録されていません</p>'}
    <div class="card"><p class="note">カードの人は、入力と自分の記録だけができます(役割は付けられません)。「止める」は記録を消しません。カードを止めると、その人の端末のログインも使えなくなります。なくした時は「カードを作り直す」(前のカードは使えなくなり、記録はつながります)。番号を忘れた時・5回まちがえて止まった時は「番号を戻す」。管理の操作はシートの「管理の記録」に残ります。</p></div>`;
  $('#ad-pin').oninput = () => { $('#ad-pin').value = $('#ad-pin').value.replace(/[^0-9]/g, '').slice(0, 4); };
}
// 管理の画面の押し物(登録・カードを作る・一覧の操作)
async function onAdminClick(e) {
  const b = e.target.closest('button'); if (!b || sheetBusy) return;
  if (b.id === 'ad-add') {
    const email = $('#ad-email').value.trim(), role = $('#ad-role').value; if (!email) return toast('メールアドレスを入れてください');
    const r = await api('adminAddGoogle', { email, role }); if (!r.ok) return toast(errText(r.error), 5000);
    toast(`登録しました(${r.recorder.masked})`); return renderAdmin();
  }
  if (b.id === 'ad-card') {
    const name = $('#ad-name').value.replace(/\s+/g, ' ').trim(), pin = $('#ad-pin').value;
    if (!name) return toast('呼び名を入れてください'); if (!/^[0-9]{4}$/.test(pin)) return toast('暗証番号は数字4つです');
    b.disabled = true; const r = await api('adminCardCreate', { name, pin }); b.disabled = false;
    if (!r.ok) return toast(errText(r.error), 5000);
    $('#ad-name').value = ''; $('#ad-pin').value = '';
    return showCardResult({ secret: r.secret, name: r.recorder.name, pin, fresh: true });
  }
  const card = e.target.closest('.person'); if (!card || !adminData) return; const key = card.dataset.key, x = adminData.recorders.find(p => p.key === key); if (!x) return;
  const act = b.dataset.act, label = x.type === 'card' ? x.name : x.masked;
  if (act === 'peek') { if (adminShow.has(key)) adminShow.delete(key); else adminShow.add(key); return renderAdmin(); }
  if (act === 'stop' || act === 'restore') {
    const stopped = act === 'stop';
    if (stopped && !confirm(`${label} を止めます。記録は消えません。${x.type === 'card' ? 'この人の端末のログインも使えなくなります。' : ''}よろしいですか?`)) return;
    const r = await api('adminSetState', { key, stopped }); if (!r.ok) return toast(errText(r.error), 5000);
    toast(stopped ? '止めました' : 'また使えるようにしました'); return renderAdmin();
  }
  if (act === 'resetpin') return openPinForm({ title: `${label} の番号を戻す`, note: 'この人に伝える新しい暗証番号(数字4つ)を入れてください。カードはそのまま使えます。この人の端末では、もう一度カードをかざして新しい番号を入れることになります。', button: 'この番号にする',
    onsubmit: async pin => { const r = await api('adminCardResetPin', { key, pin }); if (!r.ok) return toast(errText(r.error), 5000); closeSheet(); toast('番号を戻しました。新しい番号をその人に伝えてください', 5000); renderAdmin(); } });
  if (act === 'reissue') return openPinForm({ title: `${label} のカードを作り直す`, note: '前のカードは使えなくなります(記録はつながります)。新しいカードの暗証番号(数字4つ)を入れてください。', button: '作り直す(QR を出す)',
    onsubmit: async pin => { const r = await api('adminCardReissue', { key, pin }); if (!r.ok) return toast(errText(r.error), 5000); showCardResult({ secret: r.secret, name: r.recorder.name, pin, fresh: false }); } });
}
// 一覧の「役割」の選び肢を変えた時
async function onAdminChange(e) {
  const sel = e.target.closest('select[data-act=role]'), card = e.target.closest('.person'); if (!sel || !card || !adminData) return;
  const key = card.dataset.key, x = adminData.recorders.find(p => p.key === key); if (!x) return;
  const r = await api('adminSetRole', { key, role: sel.value });
  if (!r.ok) { toast(errText(r.error), 5000); sel.value = x.role; return; }
  toast(r.unchanged ? '変わっていません' : `役割を「${ROLE_LABEL(sel.value)}」にしました`); renderAdmin();
}
// 暗証番号を1つ聞く小さな画面(管理の操作)
function openPinForm({ title, note, button, onsubmit }) {
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>${esc(title)}</b></div>
  <div class="sheetbody"><div class="card pinbox"><p class="note">${esc(note)}</p><input id="pf-pin" class="pin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="例: 2580" aria-label="暗証番号 4けた">
  <button type="button" id="pf-go" class="primary">${esc(button)}</button><button type="button" id="pf-cancel" class="wide">やめる</button></div></div>`);
  $('#s-back').onclick = $('#pf-cancel').onclick = () => closeSheet();
  $('#pf-pin').oninput = () => { $('#pf-pin').value = $('#pf-pin').value.replace(/[^0-9]/g, '').slice(0, 4); };
  $('#pf-go').onclick = async () => { const pin = $('#pf-pin').value; if (!/^[0-9]{4}$/.test(pin)) return toast('暗証番号は数字4つです'); $('#pf-go').disabled = true; await onsubmit(pin); if ($('#pf-go')) $('#pf-go').disabled = false; };
}
// カードを作った直後の画面: QR(端末の中で作る)・印刷・NFC タグに書き込む(Android の Chrome)・URL をコピー。合言葉が出るのはこの画面の1回だけ
const cardUrl = secret => `${location.origin}${location.pathname}#card=${secret}`;
function showCardResult({ secret, name, pin, fresh }) {
  const url = cardUrl(secret), nfc = 'NDEFReader' in window;
  showSheet(`<div class="sheethead noprint"><b>${fresh ? 'カードを作りました' : 'カードを作り直しました'}</b></div>
  <div class="sheetbody">
  <div class="warn noprint">この画面を閉じると、このカードの合言葉は<b>二度と出ません</b>。印刷か NFC の書き込みを済ませてから閉じてください。失くした時は「カードを作り直す」で新しいカードにします。</div>
  <div class="card printcard"><div class="pc-title">地域猫 頭数調査 ログインカード</div><div class="pc-name">${esc(name)}</div>
    <canvas id="qr" class="qr" aria-label="ログイン用の QR コード"></canvas>
    <p class="pc-note">スマホのカメラでこの QR コードを読むと、調査のアプリが開きます。はじめの1回だけ、研究会から伝えられた4けたの暗証番号を入れてください。<br>このカードは他の人に渡さないでください。</p></div>
  <div class="card noprint"><p class="note">暗証番号 <b>${esc(pin)}</b> は、この人に口頭などで伝えてください(カードには書かないでください)。</p>
    <button type="button" id="cr-print" class="wide">印刷する(紙のカード)</button>
    ${nfc ? '<button type="button" id="cr-nfc" class="wide">NFC タグに書き込む(タグをスマホの裏に当てる)</button>' : '<p class="note">NFC タグへの書き込みは Android の Chrome でこの画面を開いた時にできます。iPhone では、無料の「NFC Tools」アプリで下の URL を書き込みます(手順書)。</p>'}
    <button type="button" id="cr-copy" class="wide">URL をコピー(NFC Tools に貼る用)</button>
    <button type="button" id="cr-show" class="wide">URL を文字で見る</button>
    <p id="cr-url" class="urlbox hidden"></p><p id="cr-msg" class="note"></p>
    <button type="button" id="cr-close" class="primary">閉じる(合言葉は消えます)</button></div></div>`);
  try { QR.draw($('#qr'), url, { ecl: 'M', scale: 6, quiet: 4 }); } catch { $('#cr-msg').textContent = 'QR を作れませんでした'; }
  const msg = t => { $('#cr-msg').textContent = t; };
  $('#cr-print').onclick = () => window.print();
  if (nfc) $('#cr-nfc').onclick = async () => {
    msg('タグをスマホの裏に当ててください…');
    try { await new NDEFReader().write({ records: [{ recordType: 'url', data: url }] }); msg('NFC タグに書き込みました。タグをスマホにかざして、アプリが開くか確かめてください'); }
    catch (e) { msg('書き込めませんでした(' + (e && e.name === 'NotAllowedError' ? 'NFC の許可がありません' : e && e.message || '不明') + ')。もう一度押して、タグを動かさずに当ててください'); }
  };
  $('#cr-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); msg('URL をコピーしました(貼った後は、その貼り先からも消してください)'); } catch { msg('コピーできませんでした。「URL を文字で見る」で写してください'); } };
  $('#cr-show').onclick = () => { const u = $('#cr-url'); u.textContent = url; u.classList.toggle('hidden'); };
  $('#cr-close').onclick = () => { if (!confirm('閉じると、この合言葉は二度と表示されません。印刷か書き込みは済みましたか?')) return; closeSheet(); renderAdmin(); };
}

// ---- 見本データ(名古屋市内・個人情報なし。設定で SHOW_DEMO か、URL に ?demo がある時だけボタンが出る) ----
async function demo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)], now = Date.now(), rs = [];
  for (let i = 0; i < 20; i++) {
    const [la, lo] = DEMO_CENTERS[i % DEMO_CENTERS.length], o = {};
    FIELDS.forEach(([k, , opts]) => o[k] = pick(opts));
    if (rnd() < .4) o.ear = pick(['右', '左']);
    rs.push({ id: 'demo' + i + '_' + now.toString(36), time: new Date(now - rnd() * 14 * 864e5).toISOString(), recorderId: null, area: '', ...(meshCodes(la, lo) || {}),
      lat: la + (rnd() - .5) * .008, lng: lo + (rnd() - .5) * .008, acc: 5 + Math.round(rnd() * 20), locSrc: 'GPS',
      ...o, feature: '(見本データ)', photos: [], status: 'pending' });
  }
  await putAll(rs); await updateBadge(); toast('見本のデータを20頭分入れました(未送信)');
}

function showTab(t) {
  if (t !== 'map' && picking) setPicking(false); // 地図指定の途中で離れたら取り消す
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + t));
  renderScopeBar();
  if (t === 'list') renderList(); if (t === 'stats') renderStats(); if (t === 'sites') renderSites(); if (t === 'settings') renderAuth(); if (t === 'record') renderSiteCands(); if (t === 'admin') renderAdmin();
  if (t === 'map') {
    renderMap();
    if (mapFocus) { initMap(); map.invalidateSize(); map.setView([mapFocus.lat, mapFocus.lng], 17, { animate: false }); mapFocus = null; mapAuto = true; }
    else if (!mapAuto && !picking) { mapAuto = true; locateMe(true); }   // 地図を最初に開いた時: 位置が取れれば今の場所を中心に(取れなければ自分の記録の範囲)
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  buildForm(); getGps(); renderAuth(); loadGsi();
  readCardFromUrl();   // カードの URL(#card=…)で開かれたら、合言葉を URL から消して、暗証番号を聞く
  window.addEventListener('hashchange', readCardFromUrl);   // 開いたままの画面で、もう一度カードをかざした(# だけ変わった)時も同じ
  $('#tab-admin').onclick = onAdminClick; $('#tab-admin').onchange = onAdminChange;
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#btn-gps').onclick = getGps;
  $('#btn-pick').onclick = () => { pickTarget = 'cat'; showTab('map'); setPicking(true); };
  $('#btn-pickcancel').onclick = () => { const back = pickTarget === 'site' ? 'sites' : 'record'; setPicking(false); showTab(back); };
  $('#btn-here').onclick = () => locateMe(false);
  $('#scopebar').onclick = e => { const b = e.target.closest('button[data-scope]'); if (b) setScope(b.dataset.scope); };
  $('#sitecands').onclick = e => { const b = e.target.closest('button[data-site]'); if (!b) return; const v = b.dataset.site; if (form.siteId === v) delete form.siteId; else form.siteId = v; renderSiteCands(); };
  $('#btn-site-new').onclick = () => {
    if (!loc) return toast('位置が決まってから押してください', 4000);
    openSiteForm({ lat: loc.lat, lng: loc.lng, acc: loc.acc, src: loc.src === 'GPS' ? 'GPS' : '地図' }, async site => { form.siteId = site.id; await renderSiteCands(); });
  };
  $('#btn-site-here').onclick = () => startSiteHere();
  $('#btn-site-pick').onclick = () => { pickTarget = 'site'; showTab('map'); setPicking(true); };
  $('#sitelist').onclick = e => {
    const b = e.target.closest('button[data-act]'), card = e.target.closest('.site'); if (!b || !card) return; const id = card.dataset.id, a = b.dataset.act;
    if (a === 'rename') openSiteEdit(id); else if (a === 'retire') setSiteRetired(id, true); else if (a === 'restore') setSiteRetired(id, false);
    else if (a === 'map') viewSites().then(ss => { const x = ss.find(y => y.id === id); if (x) { mapFocus = { lat: x.lat, lng: x.lng }; showTab('map'); } });
  };
  $('#photo-cam').onchange = $('#photo-pick').onchange = onPhoto;
  $('#thumbs').onclick = e => { const b = e.target.closest('button'); if (!b) return; photos.splice(+b.dataset.i, 1); renderThumbs(); };
  $('#btn-save').onclick = saveRecord;
  document.querySelectorAll('#listfilter button').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  $('#list').onclick = e => { const it = e.target.closest('.item'); if (it) openDetail(it.dataset.id); };
  $('#list').onkeydown = e => { if (e.key !== 'Enter' && e.key !== ' ') return; const it = e.target.closest('.item'); if (it) { e.preventDefault(); openDetail(it.dataset.id); } };
  $('#btn-send').onclick = () => sendPending(false);
  $('#btn-refresh').onclick = () => refreshFromServer(false);
  $('#btn-logout').onclick = logout;
  if (CONF.SHOW_DEMO || new URLSearchParams(location.search).has('demo')) $('#btn-demo').classList.remove('hidden');
  $('#btn-demo').onclick = demo;
  $('#btn-clear').onclick = async () => { if (confirm('この端末の記録を、すべて消します。よろしいですか?')) { await clearAll(); await updateBadge(); renderList(); toast('消しました'); } };
  window.addEventListener('online', () => { toast('電波が戻りました。未送信を送ります'); syncQuiet(); refreshMeta(); });
  try { const n = await migrateOld(); if (n) toast(`以前の版の記録${n}件を引き継ぎました`); } catch { toast('以前の記録を引き継げませんでした(元の記録は残してあります)', 6000); }
  updateBadge();
  refreshMeta();   // 開いた時に、選び肢と役割を取り直す(次に開いた時から新しい選び肢が出る)
  syncQuiet(); // 開いた時に、未送信があって電波があれば送る
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
});
