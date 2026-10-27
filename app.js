'use strict';
// © 2026 ikezos. All rights reserved. 無断の転用・複製を禁じます
// まちねこ帳(20261027-1051 に名前を変えた)— 保存は端末の IndexedDB。Google でログインした人と、ログインカード(2026-10-25 追加)でログインした人が、受け付け(Apps Script)へ送れる。
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
  ['color', '毛色・模様', ['キジトラ', 'キジ白', '黒白', '黒', '三毛', '茶トラ', '茶白', 'サバトラ', 'サバ白', 'サビ', '白', '灰色(グレー)', '灰白', 'シャム系', 'その他'], '当てはまるものを1つ。「その他」は下の欄に毛色を書いてください'],   // 2026-10-27 coat-list(管理者 msg 6914)
  ['hairLen', '毛の長さ', ['短毛', '長毛', '分からない']],   // 2026-10-27 coat-list(管理者 msg 6922)。既定は「分からない」。選択肢シートでは変えない
  ['ear', 'さくら耳', ['右', '左', 'なし', '確認できず'], '耳の先が桜の花びらの形に切ってある印(不妊手術が済んだ猫)。どちらの耳か選んでください'],
  ['neuter', '不妊手術', ['済み', 'まだ', '分からない'], 'さくら耳が右か左なら自動で「済み」になります(直せます)。耳の印が無くても、手術済みと分かっていれば「済み」を選んでください'],
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
const PET_REASONS = ['首輪がある', '人にとても慣れている', '毛並みがきれい', '家に出入りしている', 'その他'], PET_OTHER_MAX = 30;   // 選択肢シートで変わる(applyOptions が中身を入れ替える)
const PET_REASONS_BUILTIN = PET_REASONS.slice();
// いなくなった(2026-10-26 0002)。削除(入力の間違い用)とは別。理由は選択肢シートで変わる。記録の goneAt(日)が空なら今いる猫
const GONE_REASONS = ['見かけなくなった(行方不明)', '保護・譲渡された', '飼い主が見つかった', '亡くなった', 'その他'], GONE_OTHER_MAX = 30, GONE_REASONS_BUILTIN = GONE_REASONS.slice();
const isGone = r => !!(r && r.goneAt);
const goneReasonText = t => { t = String(t || ''); return t.indexOf('その他:') === 0 ? `その他(${t.slice(4)})` : t; };
const goneText = r => isGone(r) ? `いなくなった${r.goneReason ? '(' + goneReasonText(r.goneReason) + ')' : ''} ${r.goneAt}` : '';
const todayText = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
let showGone = false;   // 一覧・地図で「いなくなった猫も見る」(既定は今いる猫だけ)
const UNKNOWN_EAR = '確認できず';
const MAX_PHOTOS = 3, MAX_SIDE = 1600;
// 受け付けへ送る項目(入力者IDは送らない。受け付けがログインから決める)
// 送った後に「状態が変わった」として足せる項目(受け付けの CHANGE_FIELDS と同じ)
const CHANGE_ITEMS = ['ear', 'neuter', 'hairLen', 'managed', 'feeder', 'body', 'pet'];   // + えさ場の付け替え(siteId)
// 「間違いを直す」で直せる項目(位置・日時・写真は直せない)
const EDIT_FIELD_KEYS = ['color', 'hairLen', 'ear', 'neuter', 'managed', 'feeder', 'pet', 'age', 'sex', 'body', 'tail', 'tame'];
// 受け付けの内容に合わせる項目(取り直した時)
const SERVER_KEYS = ['area', 'color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame', 'collar', 'feature', 'pet', 'petReasons', 'petOther', 'editedAt', 'editCount', 'changes', 'siteId', 'mesh3', 'mesh500', 'mesh250', 'deleted', 'deletedAt', 'goneAt', 'goneReason', 'neuter', 'hairLen'];
const SEND_KEYS = ['id', 'time', 'area', 'lat', 'lng', 'acc', 'locSrc', 'color', 'ear', 'managed', 'feeder', 'age', 'sex', 'body', 'tail', 'tame', 'collar', 'feature', 'pet', 'petReasons', 'petOther', 'siteId', 'neuter', 'hairLen'];

const $ = s => document.querySelector(s);
// 20261027-1050c: v26 で足した画面の部品は、古い index.html(公開直後の HTTP の控え)には無い。無い時は、画面に出ない仮の部品を返して飛ばす(起動の段の残りのボタンが止まらないように)
const $opt = s => document.querySelector(s) || document.createElement('div');
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
// 不妊手術(2026-10-26 1355)。空(前からの記録)= さくら耳が右か左なら「済み」、ほかは「分からない」として扱う
const NEUTER_DONE = '済み', NEUTER_UNKNOWN = '分からない';
const effNeuter = r => r.neuter || (hasEar(r) ? NEUTER_DONE : NEUTER_UNKNOWN);
const neuterText = r => effNeuter(r);
// 毛の長さ(2026-10-27 coat-list)。空(前の記録)は「分からない」
const HAIR_UNKNOWN = '分からない', effHair = r => (r && r.hairLen) || HAIR_UNKNOWN;
// 毛色の「その他」(2026-10-27 coat-list)。記録は「その他:〇〇」(20字まで)。数える・比べる時は「その他」
const COLOR_OTHER = 'その他', COLOR_OTHER_MAX = 20;
const colorBase = c => { c = String(c || ''); return c.indexOf(COLOR_OTHER + ':') === 0 ? COLOR_OTHER : c; };
const colorText = r => { const c = String((r && r.color) || ''); return c.indexOf(COLOR_OTHER + ':') === 0 ? `${COLOR_OTHER}(${c.slice(COLOR_OTHER.length + 1)})` : c; };
const colorOf = st => st.color === COLOR_OTHER ? `${COLOR_OTHER}:${(st.colorOther || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, COLOR_OTHER_MAX)}` : (st.color || '');   // 画面の選び → 記録の形
const splitColor = (c, st) => { c = String(c || ''); if (c.indexOf(COLOR_OTHER + ':') === 0) { st.color = COLOR_OTHER; st.colorOther = c.slice(COLOR_OTHER.length + 1); } else if (c) st.color = c; };
// 毛色の見本の丸(SVG を描く)。写真が用意できたら COAT_PHOTOS に「名前: 画像の場所」を足すと、その色だけ写真に替わる(丸く切り抜く)
// 20261027-1051: 管理者が用意した毛色の見本(AI で作った画像)から切り抜いた写真。img/coat/<名前>.webp(160)・<名前>-l.webp(320・大きく見る用)。JPEG の予備あり。
// 写真は描いた丸の上に重ねて出す。読めなかった時は写真を外し、下の描いた丸が見える(下の error の受け)
const COAT_PHOTOS = { 'キジトラ': 'kijitora', 'キジ白': 'kijishiro', '黒白': 'kuroshiro', '黒': 'kuro', '三毛': 'mike', '茶トラ': 'chatora', '茶白': 'chashiro', 'サバトラ': 'sabatora', 'サバ白': 'sabashiro', 'サビ': 'sabi', '白': 'shiro', '灰色(グレー)': 'hai', '灰白': 'haishiro', 'シャム系': 'siam' };
const ASSET_V = 30;   // sw.js の VER と同じ。中身が変わる物(画像・PDF)は ?v=版 を付けて読む(同じ名前で古い控えが出続けないように)
const coatPic = (ph, big) => `<picture><source srcset="img/coat/${ph}${big ? '-l' : ''}.webp?v=${ASSET_V}" type="image/webp"><img class="cimg" src="img/coat/${ph}${big ? '-l' : ''}.jpg?v=${ASSET_V}" alt="" decoding="async"></picture>`;
document.addEventListener('error', e => { const t = e.target; if (t && t.classList && t.classList.contains('cimg')) { const p = t.closest('picture'); (p || t).remove(); } }, true);
const COAT_SVG = (() => {
  const W = '#fafafa', K = '#222', KI = '#8a7457', KID = '#3b2f22', CH = '#e39a4b', CHD = '#a85a1a', SA = '#a3a8ad', SAD = '#3d4247', GR = '#8e9092';
  const stripes = c => `<path d="M-2 6 Q7 3 14 6 T30 6 M-2 13 Q7 10 14 13 T30 13 M-2 20 Q7 17 14 20 T30 20" fill="none" stroke="${c}" stroke-width="2.6"/>`;
  const bg = c => `<rect width="28" height="28" fill="${c}"/>`, belly = `<path d="M0 16 Q14 11 28 16 V28 H0Z" fill="${W}"/>`;
  return {
    'キジトラ': bg(KI) + stripes(KID), 'キジ白': bg(KI) + stripes(KID) + belly, '黒白': bg(K) + belly + `<path d="M10 28 L14 15 L18 28Z" fill="${W}"/>`, '黒': bg(K),
    '三毛': bg(W) + `<path d="M0 0 H15 Q11 9 0 12Z" fill="${CH}"/><path d="M28 0 V14 Q19 12 17 0Z" fill="${K}"/><circle cx="20" cy="22" r="5" fill="${CH}"/>`,
    '茶トラ': bg(CH) + stripes(CHD), '茶白': bg(CH) + stripes(CHD) + belly, 'サバトラ': bg(SA) + stripes(SAD), 'サバ白': bg(SA) + stripes(SAD) + belly,
    'サビ': bg(K) + `<circle cx="8" cy="9" r="4" fill="${CH}"/><circle cx="19" cy="7" r="2.5" fill="${CHD}"/><circle cx="17" cy="18" r="4.5" fill="${CHD}"/><circle cx="7" cy="21" r="2.5" fill="${CH}"/><circle cx="24" cy="15" r="2" fill="${CH}"/>`,
    '白': bg(W), '灰色(グレー)': bg(GR), '灰白': bg(GR) + belly,
    'シャム系': bg('#efe3cf') + `<path d="M0 0 H28 V6 Q14 2 0 6Z M0 22 Q14 26 28 22 V28 H0Z" fill="#4a3426"/>`,
  };
})();
function coatSwatch(name, big) {
  const ph = COAT_PHOTOS[name], g = COAT_SVG[name];
  return `<span class="sw${g ? '' : ' unk'}${ph ? ' ph' : ''}"><svg viewBox="0 0 28 28" aria-hidden="true">${g || ''}</svg>${ph ? coatPic(ph, big) : ''}</span>`;   // 「その他」と、管理者が足した名前の分からない色は、点線の丸に「?」(style.css で描く。ボタンの文字には入れない)
}   // 手術済みの理由は聞かない(2026-10-26 1440)
// 毛色の見本を大きく見る(20261027-1051・管理者 msg 6948)。画面いっぱいに2列で写真と名前を並べる。押した物を選んで閉じる(表のボタンを押したのと同じ)。
// ✕・端末の戻るボタン・Esc で閉じる(何も選ばない)
let coatBig = null, coatSkipPop = false;   // coatSkipPop: 閉じた時の「戻る」で、画面を開き直さない(上へ戻らない)
function openCoatBig(box) {
  if (!box) return; if (coatBig) closeCoatBig(true);
  const el = document.createElement('div'); el.className = 'coatbig'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '毛色の見本');
  const opts = [...box.querySelectorAll('button[data-v]')].map(b => b.dataset.v);
  el.innerHTML = `<div class="cbbar"><b>毛色の見本</b><button type="button" class="cbclose" aria-label="閉じる">✕</button></div>
    <p class="hint">当てはまるものを押すと、選んで閉じます。</p>
    <div class="cbgrid">${opts.map(o => `<button type="button" data-v="${esc(o)}"${box.querySelector(`button.sel[data-v="${CSS.escape(o)}"]`) ? ' class="sel"' : ''}>${coatSwatch(o, true)}<span class="cn">${esc(o)}</span></button>`).join('')}</div>`;
  document.body.appendChild(el); document.body.classList.add('noscroll');
  coatBig = { el, box };
  try { history.pushState(Object.assign({}, history.state, { coatbig: 1 }), ''); coatBig.pushed = true; } catch { /* 戻るボタンで閉じられないだけ */ }
  el.querySelector('.cbclose').onclick = () => closeCoatBig();
  el.querySelector('.cbgrid').onclick = e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    const t = box.querySelector(`button[data-v="${CSS.escape(b.dataset.v)}"]`);
    closeCoatBig(); if (t) { t.click(); t.scrollIntoView({ block: 'nearest' }); }
  };
}
function closeCoatBig(quiet) {
  const c = coatBig; if (!c) return; coatBig = null;
  c.el.remove(); if ($opt('#sheet').classList.contains('hidden') && !viewer) document.body.classList.remove('noscroll');
  if (c.pushed && !quiet && history.state && history.state.coatbig) { coatSkipPop = true; history.back(); }
}
addEventListener('popstate', () => { if (coatBig) { coatBig.pushed = false; closeCoatBig(true); coatSkipPop = true; } });
addEventListener('keydown', e => { if (coatBig && e.key === 'Escape') closeCoatBig(); });

const fmt = t => new Date(t).toLocaleString('ja-JP');

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// 押すと保存・送信するボタン: 押したら処理が終わるまで押せなくし、「処理中…」を出す(二度押しで二重に登録しない。2026-10-25 2332)
const BUSY = new WeakSet();
async function busy(btn, fn, label = '処理中…') {
  if (!btn) return fn();
  if (BUSY.has(btn)) return; BUSY.add(btn);
  const was = btn.innerHTML; btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); btn.textContent = label;
  try { return await fn(); }
  finally { BUSY.delete(btn); btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); btn.innerHTML = was; }
}
const newId = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// 古い画面の入れ替え(サービスワーカーが新しくなった・保存の入れ物を新しい版に譲った時)。入力の途中なら、保存して空になってから1回だけ読み込み直す
let wantReload = false;
const typingNow = () => !!(formTouched() || photos.length || (document.getElementById('feature') || {}).value || saving || !document.getElementById('sheet').classList.contains('hidden'));   // 保存していない入力がある・保存の途中・記録を開いている
function maybeReload() {
  if (!wantReload) return;
  if (typingNow()) return;
  const last = Number(sessionStorage.getItem('catSurvey.swReload') || 0); if (Date.now() - last < 60000) return;   // 続けて読み込み直さない(1回だけ)
  sessionStorage.setItem('catSurvey.swReload', String(Date.now())); location.reload();
}

// ---- IndexedDB ----
// 版を上げる時(1→2 など)、前の版の画面が同じ入れ物を開いたままだと、上げが止まる(blocked)。前は何も出さずに待ち続け、保存が永遠に終わらなかった(2026-10-25 2332)。
// 止まったら上に大きく知らせる。どの読み書きにも上限(8秒)を付け、時間切れなら理由を出す(黙って止まらない)。
// 開いた後は、別の画面がもっと新しい版で開こうとしたら(versionchange)、自分の入れ物を閉じて邪魔をしない。
const DB_WAIT_MS = 8000;
let dbState = 'opening';   // opening / ready / blocked(前の画面が開いたまま) / closed(新しい版に譲った) / failed
const dbErr = code => Object.assign(new Error(code), { code });
const DB_TEXT = {
  blocked: '前の画面が開いたままです。このアプリのほかのタブや画面を閉じてから、開き直してください。',
  closed: 'このアプリの新しい版が、別の画面で開かれました。この画面を読み込み直してください。',
  timeout: '端末への保存が時間内に終わりませんでした。画面を開き直してから、もう一度押してください(入れた内容は、この画面にまだ残っています)。',
  quota: '保存できませんでした。端末の空きが足りないかもしれません。',
  failed: 'この端末に保存できませんでした。画面を開き直してください(続く時は、ブラウザの「シークレット」でない普通の画面で開いてください)。',
};
const dbErrText = e => DB_TEXT[e && e.code] || DB_TEXT.failed;
// 上の大きな案内(#dbmsg)。止まった・譲った・使えない時だけ出す
function showDbMsg() {
  const el = document.getElementById('dbmsg'); if (!el) return document.addEventListener('DOMContentLoaded', showDbMsg, { once: true });
  const bad = dbState === 'blocked' || dbState === 'closed' || dbState === 'failed';
  el.classList.toggle('hidden', !bad);
  if (bad) el.querySelector('.dbtext').textContent = DB_TEXT[dbState];
}
const dbp = new Promise((ok, ng) => {
  let q; try { q = indexedDB.open(DB_NAME, 2); } catch { dbState = 'failed'; showDbMsg(); return ng(dbErr('failed')); }
  q.onupgradeneeded = () => {
    const db = q.result;
    if (!db.objectStoreNames.contains(STORE)) { const s = db.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('status', 'status'); }
    if (!db.objectStoreNames.contains(SITES)) db.createObjectStore(SITES, { keyPath: 'id' });   // えさ場(端末の控え。送信待ちの物もここ)。版を上げても、記録の入れ物は消さない
  };
  q.onblocked = () => { dbState = 'blocked'; showDbMsg(); };
  q.onsuccess = () => {
    const db = q.result, was = dbState;
    db.onversionchange = () => { db.close(); dbState = 'closed'; showDbMsg(); wantReload = true; maybeReload(); };   // 新しい版に譲る(閉じないと、向こうの版上げが止まる)
    dbState = 'ready'; showDbMsg(); if (was === 'blocked') toast('使えるようになりました。保存できなかった物は、もう一度押してください', 6000);
    ok(db);
  };
  q.onerror = () => { dbState = 'failed'; showDbMsg(); ng(dbErr('failed')); };
});
dbp.catch(() => {});
// 読み書きに上限を付ける。時間切れの後に入れ物が開いても、その読み書きは始めない(画面で「できませんでした」と出した物が、後から黙って保存されないように)
const run = (mode, fn, store = STORE) => {
  let late = false, timer;
  const work = dbp.then(db => new Promise((ok, ng) => {
    if (late) return ng(dbErr('timeout'));
    if (dbState === 'closed') return ng(dbErr('closed'));
    let t; try { t = db.transaction(store, mode); } catch { return ng(dbErr(dbState === 'closed' ? 'closed' : 'failed')); }
    const r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => { const c = t.error && t.error.name === 'QuotaExceededError' ? 'quota' : 'failed'; logErr('保存の失敗: ' + c); ng(dbErr(c)); };
  }));
  const limit = new Promise((_, ng) => { timer = setTimeout(() => { late = true; ng(dbErr(dbState === 'blocked' ? 'blocked' : dbState === 'closed' ? 'closed' : 'timeout')); }, DB_WAIT_MS); });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
};
// 入れ物が止まっている・譲った時は、押してもすぐ理由を出す(8秒待たせない)
const dbNotUsable = () => dbState === 'blocked' || dbState === 'closed' || dbState === 'failed';
window.addEventListener('unhandledrejection', e => { if (e.reason && DB_TEXT[e.reason.code]) { e.preventDefault(); showDbMsg(); } });   // 画面の描き直しなどで出た保存の入れ物の誤りは、上の案内で知らせる(コンソールに積まない)
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
// Google の人も、確かめが通った時に受け付けから通行証(30日・使うたびに延びる)をもらう(2026-10-26)。ID トークン(約1時間)が切れても、通行証が期限内なら入力・送信できる
const idValid = () => !!(auth && !isCard() && auth.idToken && auth.exp * 1000 > Date.now() + 30000);
const passValid = () => !!(auth && auth.pass && auth.passExp > Date.now());
const tokenValid = () => !!(auth && (isCard() ? passValid() : idValid() || passValid()));
// verified=受け付けが登録を確かめて通した印。これが無い人(確かめが通っていない・電波が無くて確かめられなかった人)は、使えない。
// 前の版で確かめが通った人(入力者IDを持つ)・カードの人(カードのログインは受け付けが通した時だけ作られる)は、印が無くても確かめが通った扱い。
const wasVerified = a => !!(a && (a.verified || a.recorderId || a.type === 'card'));
// 使えるのは「確かめが通った人で、通行証・ID トークンが期限内」の時だけ。電波が無くても、前に確かめが通った人は期限内なら使える(畑や路地のため)
const loggedIn = () => tokenValid() && !auth.pending && wasVerified(auth);   // pending=受け付けで確かめている最中(まだログインした形にしない)
// 受け付けが「この人は使えない」と答えた時(登録されていない・止められた・カードが使えない)。ログインの印を消し、入力・一覧などの画面を出さない
const DENY = ['not_registered', 'stopped', 'email_not_verified', 'pass_invalid', 'card_stopped', 'card_not_found'];
let blocked = null;   // 使えない理由(画面に出す)。ログインしていない時の画面は、理由が無くても同じ(locked)
const DENY_TEXT = { not_registered: 'このアカウントは登録されていません。管理者に登録を頼んでください。', stopped: 'このアカウントは止められています。管理者に連絡してください。',
  unverified: '電波がなくて、登録を確かめられませんでした。電波のある所で、もう一度ログインしてください。' };
const whoLabel = () => !auth ? '' : isCard() ? `${auth.name || 'カードの人'}(カード)` : (auth.email || 'ログイン済み');
const configured = () => !!(CONF.GAS_URL && CONF.GOOGLE_CLIENT_ID);
function decodeJwt(tok) {
  try { const p = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch { return null; }
}
// GIS がログインの結果をここへ渡す(window に置くのは GIS の決まり)
window.onGoogleCredential = async resp => {
  const p = resp && decodeJwt(resp.credential);
  if (!p || !p.exp) return toast('ログインの結果を読めませんでした', 5000);
  if (loggedIn() && !isCard() && auth.email === (p.email || '')) return reconfirm(resp.credential, Number(p.exp));   // 20261027-2326: ログイン中の同じ人が確かめ直した時は、ログインの画面へ移らずにその場で続ける
  // 受け付けで確かめる(whoami)まで、ログインした形にしない(pending)。確かめる前の状態は端末に保存しない
  const prev = auth && !isCard() && auth.email === (p.email || '') && wasVerified(auth) ? auth : null;   // 同じ人が前に確かめを通っていれば、電波が無くても使える
  const mine = { type: 'google', idToken: resp.credential, exp: Number(p.exp), email: p.email || '', recorderId: prev && prev.recorderId || null, verified: !!prev, admin: prev && prev.admin, viewAll: prev && prev.viewAll, pass: prev && prev.pass || '', passExp: prev && prev.passExp || 0, pending: true };
  auth = mine; blocked = null; renderAuth();
  const r = await api('whoami');
  if (auth !== mine) return;   // 使えない人と分かって、もう取り消された(または別のログインに替わった)
  delete mine.pending;
  if (r.ok) { auth.recorderId = r.recorderId; auth.verified = true; applyMeta(r); saveAuth(); renderAuth(); toast('ログインしました'); await syncQuiet(); }
  else if (noAnswer(r.error) && mine.verified) { saveAuth(); renderAuth(); toast('受け付けにつながりません。前に確かめた登録で使えます。送る時にもう一度確かめます', 6000); }   // 前に確かめが通った人だけ、電波が無くても使える
  else { auth = null; saveAuth(); const off = noAnswer(r.error); blocked = off ? 'unverified' : r.error; renderAuth(); toast(off ? DENY_TEXT.unverified : errText(r.error), 6000); }   // 一度も確かめが通っていない人は、確かめが取れるまで使えない
};
// ---- Google でもう一度確かめる(20261027-2326。艦長 msg 7007「もう一度ログインと出るが、どこからログインするのか不明」)----
// 通行証でログインしたまま ID トークン(約1時間)が切れた人が「全員の記録」「管理」を開いた時、その場に Google のボタンを出す。
// 確かめが済んだら、画面を移らずに、そのまま全員の記録(管理の画面)を出す。reauth: 確かめが済んだら続けること('all' / 'admin')
let reauth = null, quietPromptAt = 0;
async function reconfirm(cred, exp) {
  const old = { idToken: auth.idToken, exp: auth.exp }, job = reauth;
  auth.idToken = cred; auth.exp = exp; saveAuth();
  const r = await api('whoami');
  if (!auth) return;   // 確かめの途中で使えない人と分かった(api が取り消した)
  if (!r.ok) {
    if (noAnswer(r.error)) { auth.idToken = old.idToken; auth.exp = old.exp; saveAuth(); }   // 確かめられなかった(電波)。前のままにして、もう一度押せるようにする
    renderRelogin(); return toast(errText(r.error), 6000);
  }
  if (r.recorderId) auth.recorderId = r.recorderId;
  applyMeta(r); saveAuth(); reauth = null; renderAuth();
  toast('Google で確かめました', 2500);
  photoResume();   // 20261028-0140: 確かめを待っていた写真を、そのまま出す
  const tab = document.querySelector('.tab.active');
  if (job === 'all' && auth.viewAll) await setScope('all');
  else if (job === 'admin' && tab && tab.id === 'tab-admin') renderAdmin();
}
const GSI_BTN = { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja', width: 300 };
// 箱(wrap)の中の .gsi-spot に Google のボタンを出す。出せない時は「Google のボタンを出し直す」と訳を出す
function gsiSpot(wrap) {
  if (!wrap) return;
  const spot = wrap.querySelector('.gsi-spot'), rg = wrap.querySelector('.regsi'), m = wrap.querySelector('.gsi-msg');
  if (!spot || !rg || !m) return;
  if (gsiState === 'ready' && !spot.firstChild && wrap.offsetParent) { try { google.accounts.id.renderButton(spot, GSI_BTN); } catch { /* 部品が無い時 */ } }
  const shown = gsiState === 'ready' && !!spot.querySelector('*');
  rg.classList.toggle('hidden', shown || gsiState === 'loading');
  m.textContent = shown ? '' : gsiState === 'loading' ? 'Google のボタンを読み込んでいます…' : !navigator.onLine ? '電波がありません。電波がある所で「Google のボタンを出し直す」を押してください。' : 'Google のボタンを出せませんでした。「Google のボタンを出し直す」を押してください。';
}
const RELOGIN_TABS = ['tab-list', 'tab-map', 'tab-stats', 'tab-sites'];
function renderRelogin() {
  const tab = document.querySelector('.tab.active'), g = loggedIn() && !isCard();
  const box = $opt('#relogin');
  if (box) { box.classList.toggle('hidden', !(g && reauth === 'all' && auth.viewAll && !idValid() && tab && RELOGIN_TABS.includes(tab.id))); gsiSpot(box); }
  const set = $opt('#reloginset');
  if (set) {
    set.classList.toggle('hidden', !g);
    const st = $opt('#reloginstate');
    if (st) st.textContent = !g || !auth.viewAll ? '' : idValid() ? `全員の記録・管理の確かめ: 済み(あと約${Math.max(1, Math.round((auth.exp * 1000 - Date.now()) / 60000))}分)` : '全員の記録・管理の確かめ: 期限が切れています(下のボタンで確かめ直せます。ログアウトはしません)';
    gsiSpot(set);
  }
  gsiSpot(document.getElementById('relogin-admin'));
  document.querySelectorAll('.relogin-photo').forEach(gsiSpot);
}
// 通行証でログインしたまま、全員の記録・管理を見ている人の ID トークンが切れる前に、Google の自動のログイン(前に選んだアカウント)で静かに取り直す。
// 選び直しの画面が出る時もあるので、全員の記録・管理を見ている時だけ・30分に1回まで(何度も出して嫌われると、Google が自動のログインをしばらく止めるため)
function quietRefresh() {
  if (!(loggedIn() && !isCard() && auth.viewAll && gsiState === 'ready' && navigator.onLine && document.visibilityState === 'visible')) return;
  const tab = document.querySelector('.tab.active');
  if (!(scope === 'all' || (tab && tab.id === 'tab-admin'))) return;
  if (auth.exp * 1000 > Date.now() + 5 * 60000 || Date.now() - quietPromptAt < 30 * 60000) return;
  quietPromptAt = Date.now();
  try { google.accounts.id.prompt(); } catch { /* 部品が無い時 */ }
}
function denyAccess(err) {
  auth = null; homeSrv = null; saveAuth(); blocked = err; reauth = null; setScope('mine', true); closeSheet();
  try { google.accounts.id.disableAutoSelect(); } catch { /* 部品が無い時 */ }
  renderAuth(); toast(errText(err), 7000);
}
function logout() {
  if (auth && passValid() && configured() && navigator.onLine) post({ action: 'passRevoke', pass: auth.pass }).catch(() => {});   // 通行証(カード・Google とも)を受け付け側でも使えなくする(できなくても端末からは消す)
  auth = null; homeSrv = null; saveAuth(); reauth = null; setScope('mine', true); closeSheet(); renderAuth();   // 端末の記録は消さない(次にログインした時に送る)
  try { google.accounts.id.disableAutoSelect(); } catch { /* 部品が無い時 */ }
  toast('ログアウトしました。この端末の記録は残っています(次にログインした時に送ります)');
}
// ---- ログインカード ----
let cardSecret = null;   // カードの URL から読んだ合言葉。番号を入れてログインするまでの間だけ持つ(保存しない)
const CARD_RE = /^[A-Za-z0-9_-]{20,64}$/;
// 開いた URL の #card=… を読み、すぐ URL から消す(戻る・履歴・共有に合言葉が残らないように)
function readCardFromUrl() {
  const m = /^#card=([^&]+)/.exec(location.hash || ''); if (!m) return false;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
  let secret = ''; try { secret = decodeURIComponent(m[1]); } catch { secret = m[1]; }
  if (!CARD_RE.test(secret)) { toast('このカードの URL は読めませんでした。管理者に連絡してください', 6000); return false; }
  cardSecret = secret;
  if (window.CardKit && !loggedIn() && CardKit.needsHomeGuide()) CardKit.showHomeGuide(openCardPin); else openCardPin();   // iPhone で、ホーム画面のアプリでない所なら、番号の前に「先にホーム画面に追加」の案内
  return true;
}
// 暗証番号の画面(カードを読んだ直後)
function openCardPin() {
  if (!cardSecret) return;
  showSheet(`<div class="sheethead"><b>カードを読みました</b></div>
  <div class="sheetbody"><div class="card pinbox"><h3>暗証番号(4けた)を入れてください</h3>
  <p class="note">管理者から伝えられた4けたの数字です。この端末で最初の1回だけ入れます(次からは、かざさなくてもログインしたままです)。</p>
  <input id="pin" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" aria-label="暗証番号 4けた" placeholder="●●●●">
  <p id="pinmsg" class="warn hidden"></p>
  <button type="button" id="pin-go" class="primary">ログイン</button>
  <button type="button" id="pin-cancel" class="wide">やめる</button>
  <p class="note">5回続けて間違えると、このカードは使えなくなります(管理者が戻せます)。番号を忘れたときも管理者に連絡してください。</p></div></div>`);
  const msg = t => { const el = $('#pinmsg'); el.textContent = t; el.classList.toggle('hidden', !t); };
  $('#pin-cancel').onclick = () => { cardSecret = null; closeSheet(); };
  $('#pin').oninput = () => { $('#pin').value = $('#pin').value.replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).slice(0, 4); };
  $('#pin').onkeydown = e => { if (e.key === 'Enter') $('#pin-go').click(); };
  $('#pin-go').onclick = e => busy(e.currentTarget, async () => {
    const pin = $('#pin').value; if (!/^[0-9]{4}$/.test(pin)) return msg('数字を4つ入れてください');
    if (!configured()) return msg(errText('not_configured')); if (!navigator.onLine) return msg('電波がありません。電波がある所でもう一度カードをかざしてください');
    msg('');
    const r = await rawApi({ action: 'cardLogin', card: cardSecret, pin });
    if (!r.ok) {
      if (r.error === 'wrong_pin') { $('#pin').value = ''; return msg(`番号が違います。あと${r.remaining}回まちがえると、このカードは使えなくなります`); }
      if (r.error === 'card_stopped') { cardSecret = null; return msg(r.locked ? '5回まちがえたので、このカードは止まりました。管理者に連絡して、番号を戻してもらってください' : errText('card_stopped')); }
      return msg(errText(r.error));
    }
    cardSecret = null; blocked = null;
    auth = { type: 'card', verified: true, pass: r.pass, passExp: Number(r.passExp), name: r.name || '', recorderId: r.recorderId || null };
    saveAuth(); closeSheet(); renderAuth(); toast(`ようこそ、${auth.name || 'カードの人'}。ログインしました`, 4000);
    const w = await api('whoami'); if (w.ok) { auth.recorderId = w.recorderId; applyMeta(w); saveAuth(); renderAuth(); }
    syncQuiet();
  }, 'ログインしています…');
  setTimeout(() => { try { $('#pin').focus(); } catch { /* 画面が無い時 */ } }, 50);
}
let gsiState = 'loading', gsiTimer = null;
// 20261027-0820: Google の部品が10秒で読めなければ「読めない」とし、ログインの画面に「Google のボタンを出し直す」を出す(ログインカードのボタンは、部品を待たずに初めから出ている)
function loadGsi() {
  if (!CONF.GOOGLE_CLIENT_ID) { gsiState = 'noconfig'; return renderAuth(); }
  bootMark('Googleの部品:読み込み開始');
  const old = document.getElementById('gsi-script'); if (old) old.remove();
  document.querySelectorAll('.gsi-spot').forEach(x => { x.textContent = ''; });   // 出し直す時は、その場の Google のボタンも作り直す
  gsiState = 'loading'; clearTimeout(gsiTimer);
  const s = document.createElement('script'); s.id = 'gsi-script'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
  s.onload = () => { clearTimeout(gsiTimer); bootMark('Googleの部品:読めた'); gsiState = 'ready'; initGsi(); renderAuth(); };
  s.onerror = () => { clearTimeout(gsiTimer); bootMark('Googleの部品:読めない'); gsiState = 'failed'; renderAuth(); };
  gsiTimer = setTimeout(() => { if (gsiState === 'loading') { bootMark('Googleの部品:10秒で読めない'); gsiState = 'failed'; renderAuth(); } }, 10000);
  document.head.appendChild(s);
}
function initGsi() {
  try {
    google.accounts.id.initialize({ client_id: CONF.GOOGLE_CLIENT_ID, callback: window.onGoogleCredential, auto_select: true, itp_support: true, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton($('#gsi-btn'), GSI_BTN); bootMark('Googleのボタン');
    if (auth && !isCard() && !tokenValid()) google.accounts.id.prompt(); // 前に Google でログインした人は、期限が切れていれば取り直しを促す
  } catch { gsiState = 'failed'; }
}
let wasLoggedIn = false;
function renderAuth() {
  const on = loggedIn(), idTail = auth && auth.recorderId ? `(ID ${auth.recorderId.slice(0, 6)})` : '';
  $('#recorder').textContent = on ? `${whoLabel()} ${idTail}` : (auth && (auth.idToken || auth.pass) ? (isCard() ? 'ログインの期限が切れました。もう一度カードをかざして(QR を読んで)ください' : 'ログインの期限が切れました。もう一度ログインしてください') : 'ログインしていません');
  $('#logincard').classList.toggle('hidden', on);
  const checking = !!(auth && auth.pending);
  document.body.classList.toggle('locked', !on);   // ログインしていない人(確かめ中・断られた・一度もログインしていない・確かめが通っていない)には、ログインの画面と「使い方を見る」だけを出す(CSS)
  const bm = $('#blockmsg'); bm.classList.toggle('hidden', !blocked);
  bm.textContent = blocked ? (DENY_TEXT[blocked] || errText(blocked)) : '';
  if (!on) { const t = document.querySelector('.tab.active'); if (!t || t.id !== 'tab-record') showTab('record'); updateBadge().then(() => { const n = (($('#pending').textContent.match(/\d+/) || [0])[0]); $('#blockpending').textContent = n > 0 ? `この端末に未送信の記録が ${n} 件あります(消えていません。登録された方でログインすると送れます)。` : ''; $('#blockpending').classList.toggle('hidden', !(n > 0)); }); }
  else $('#blockpending').classList.add('hidden');
  const rg = document.getElementById('btn-regsi'); if (rg) rg.classList.toggle('hidden', on || !configured() || !CONF.GOOGLE_CLIENT_ID || (gsiState === 'ready' && !!document.querySelector('#gsi-btn *')));
  const m = $('#loginmsg');
  m.textContent = checking ? '登録を確かめています…' : !configured() ? '送り先の設定がまだです(公開の時に入ります)。入るまでは、ログインできません。'
    : gsiState === 'failed' ? 'Google のログインの部品を読み込めませんでした。電波がある所で「Google のボタンを出し直す」を押してください(ログインカードの方は、下のボタンでログインできます)。'
    : gsiState === 'loading' ? 'ログインの部品を読み込んでいます…' : (auth && auth.idToken ? 'ログインの期限が切れています。もう一度ログインしてください。' : '');
  $('#authinfo').textContent = on ? (isCard() ? `ログイン中: ${auth.name || 'カードの人'}(ログインカード)${idTail}。この端末にはログインの通行証だけが残り、カードの合言葉や暗証番号は残りません。記録には ID だけが残ります。全員の記録は、Google でログインした人だけが見られます。`
    : `ログイン中: ${auth.email || '(メール不明)'} ${idTail}。記録には ID だけが残り、メールアドレスや名前は送りません。${auth.admin ? '役割: 管理者(「管理」の画面で入力者の登録・カードの発行ができます。全員の記録も見られます)' : auth.viewAll ? '役割: 全体を見る(一覧・地図・集計で「全員の記録」に切り替えられます)' : ''}`) : 'ログインしていません。';
  renderScopeBar();
  $opt('#home-admin').classList.toggle('hidden', !(on && !isCard() && auth.admin));
  if (on && !wasLoggedIn) { wasLoggedIn = true; showTab('home'); } else if (!on) wasLoggedIn = false;   // ログインできたら、ホームから始める
  if (!(on && auth.admin) && document.querySelector('.tab.active') && document.querySelector('.tab.active').id === 'tab-admin') showTab('record');
  $('#btn-logout').classList.toggle('hidden', !auth);
  if (window.CardKit) CardKit.refresh();   // 「カードの QR を読む」の置き場所・Android の「ホーム画面に追加」の案内
  $('#cfginfo').textContent = configured() ? `受け付け: 設定済み(${CONF.GAS_URL.replace(/^https?:\/\//, '').slice(0, 40)}…)` : '受け付け: 未設定(公開の時に設定ファイルに入ります)';
}

// ---- 選択肢(受け付けの「選択肢」シートで変わる)と役割 ----
// 受け付けが返した選択肢を端末に控え、次に開いた時から使う。受け付けが null を返した時(シートが壊れている)や、読めない時は、アプリに入っている選択肢で動く。
const okList = a => Array.isArray(a) && a.length > 0 && a.length <= 60 && a.every(x => typeof x === 'string' && x.length >= 1 && x.length <= 50);
function applyOptions(o) {
  FIELDS.forEach(f => { const b = FIELDS_BUILTIN.find(x => x[0] === f[0]); f[2] = o && okList(o[f[0]]) ? o[f[0]].slice() : b[1].slice(); });
  const pr = o && okList(o.petReasons) && o.petReasons.every(x => !/[、:]/.test(x)) ? o.petReasons : PET_REASONS_BUILTIN;
  PET_REASONS.splice(0, PET_REASONS.length, ...pr);
  const gr = o && okList(o.goneReasons) && o.goneReasons.every(x => !/:/.test(x)) ? o.goneReasons : GONE_REASONS_BUILTIN;
  GONE_REASONS.splice(0, GONE_REASONS.length, ...gr);
}
let optionsDirty = false;
function applyMeta(r) {
  if (!r || !r.ok) return;
  takeHomeCounts(r);
  if (r.viaPass && auth && !isCard()) r = { ...r, viewAll: auth.viewAll, admin: auth.admin };   // 通行証で通った返事は役割を返さない(前の ID トークンで分かった役割を消さない)
  if (auth && auth.viewAll !== !!r.viewAll) { auth.viewAll = !!r.viewAll; saveAuth(); if (!auth.viewAll && scope === 'all') setScope('mine', true); renderScopeBar(); }
  if (auth && (auth.admin !== !!r.admin || (r.name != null && isCard() && auth.name !== r.name))) { auth.admin = !!r.admin; if (isCard() && r.name != null) auth.name = r.name; saveAuth(); renderAuth(); }
  if (!('options' in r)) return;   // 古い受け付けは options を返さない=何も変えない
  const before = JSON.stringify([FIELDS.map(f => f[2]), PET_REASONS]);
  applyOptions(r.options); r.options ? localStorage.setItem(OPT_KEY, JSON.stringify(r.options)) : localStorage.removeItem(OPT_KEY);
  if (before !== JSON.stringify([FIELDS.map(f => f[2]), PET_REASONS])) {
    if (formCtl && !formTouched() && $('#sheet').classList.contains('hidden')) buildForm(); else optionsDirty = true;   // 入力の途中なら、保存したあとに入れ替える
    toast('選択肢が新しくなりました', 3000);
  }
}
async function refreshMeta() { if (!configured() || !loggedIn() || !navigator.onLine) return; const r = await api('whoami'); applyMeta(r); }
try { applyOptions(JSON.parse(localStorage.getItem(OPT_KEY) || 'null')); } catch { applyOptions(null); }

// ---- 受け付け(Apps Script)との通信 ----
// Content-Type を text/plain にして、CORS のプリフライトを避ける。受け付けは 302 で別の URL へ飛ばすので redirect は follow。
// 受け付けの返事にも上限を付ける(返事が来ないまま待ち続けない)。写真つきの送信は長め。時間切れでも受け付けで済んでいることがあるので、送り直しは同じ ID で送る(受け付けが二重にしない)
const API_WAIT_MS = Number(CONF.API_WAIT_MS) > 0 ? Number(CONF.API_WAIT_MS) : 30000, API_WAIT_PHOTO_MS = Math.max(API_WAIT_MS, Number(CONF.API_WAIT_MS) > 0 ? Number(CONF.API_WAIT_MS) : 90000);   // CONF.API_WAIT_MS は試しの時だけ(公開の設定には入れない)
// 送れなかった訳を2つに分ける(2026-10-26 0821。管理者 msg 6673):
//  電波(NET_ERR): 端末が圏外・応答がまったく無い(つながらない・返事の始まりが来ないまま時間切れ)→「電波が弱いようです。つながったら自動で送ります。」
//  受け付け(SRV_ERR): 受け付けまでは届いたが、まともな返事でない(HTML の頁・500 など・server_error・返事の途中で止まった)→「受け付けが応えません。管理者に知らせてください。」
//  どちらも記録は端末に残る(送れた扱いにしない)。ブラウザは CORS の見出しの無い誤りの頁も「応答なし」(TypeError)に見せるので、その時は受け付けに軽く問い合わせて(no-cors の GET)、届くなら受け付けの側とみなす
const NET_ERR = ['network', 'timeout'], SRV_ERR = ['bad_response', 'http_error', 'server_error', 'stalled', 'no_cors'];
const noAnswer = e => NET_ERR.includes(e) || SRV_ERR.includes(e);
async function reachable(ms = 6000) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null, timer = ac && setTimeout(() => ac.abort(), ms);
  try { await fetch(CONF.GAS_URL, { method: 'GET', mode: 'no-cors', cache: 'no-store', ...(ac ? { signal: ac.signal } : {}) }); return true; } catch { return false; } finally { if (timer) clearTimeout(timer); }
}
async function post(body, ms = API_WAIT_MS) {
  if (navigator.onLine === false) return { ok: false, error: 'network', offline: true };
  const ac = typeof AbortController === 'function' ? new AbortController() : null, timer = ac && setTimeout(() => ac.abort(), ms);
  let res = null;
  try {
    res = await fetch(CONF.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify(body), ...(ac ? { signal: ac.signal } : {}) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'http_error', status: res.status };
    let j; try { j = JSON.parse(text); } catch { return { ok: false, error: 'bad_response' }; }   // Google の誤りの頁(HTML)など
    return j && typeof j === 'object' ? j : { ok: false, error: 'bad_response' };
  } catch (e) {
    if (res) return { ok: false, error: 'stalled' };   // 返事の始まりは来たが、途中で止まった・切れた
    if (e && e.name === 'AbortError') return { ok: false, error: 'timeout' };
    if (timer) clearTimeout(timer);
    return { ok: false, error: navigator.onLine !== false && await reachable() ? 'no_cors' : 'network' };
  }
  finally { if (timer) clearTimeout(timer); }
}
// ログインの前の呼び出し(cardLogin)。ログインの印は付けない
async function rawApi(body) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  return post(body);
}
async function api(action, extra = {}, ms) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  if (!tokenValid()) return { ok: false, error: 'not_logged_in' };
  // 全員の記録・管理の操作は、Google の新しい ID トークンが要る(通行証だけでは通さない)
  const needId = /^admin[A-Z]/.test(action) || (action === 'list' && extra.scope === 'all') || (action === 'photo' && (extra.items || []).some(i => i.ownerId));   // 他の人の記録の写真も、全員の記録と同じ
  if (needId && !idValid()) { if (!isCard()) { try { google.accounts.id.prompt(); } catch { /* 部品が無い時 */ } } return { ok: false, error: isCard() ? (/^admin/.test(action) ? 'not_allowed' : 'card_no_all') : 'id_needed' }; }   // カードの人: 全員の記録・他の人の写真は「Google でログインした人だけ」の案内
  // カードの人は通行証。Google の人は ID トークンが期限内ならそれ(通行証をまだ持っていなければ whoami で受け取る)、切れていれば通行証
  const cred = isCard() || !idValid() ? { pass: auth.pass } : { idToken: auth.idToken, ...(action === 'whoami' && !(auth.pass && auth.passExp > Date.now() + 7 * 864e5) ? { wantPass: true } : {}) };
  const viaPass = !!cred.pass;
  const r = await post({ action, ...cred, ...extra }, ms);
  if (noAnswer(r.error)) return r;
  if (r && r.ok && r.pass && !isCard() && auth) { auth.pass = r.pass; auth.passExp = Number(r.passExp) || 0; saveAuth(); }
  if (r && !isCard() && viaPass && r.error === 'pass_invalid') { auth.pass = ''; auth.passExp = 0; saveAuth(); renderAuth(); return r; }   // Google の人の通行証が使えない(期限切れ・登録から外された)→ 通行証を捨て、Google でログインし直してもらう
  if (r && !isCard() && ['token_expired', 'invalid_token', 'wrong_audience', 'wrong_issuer', 'bad_token'].includes(r.error)) { auth.idToken = ''; delete auth.pending; saveAuth(); renderAuth(); }
  if (r && DENY.includes(r.error) && auth) denyAccess(r.error);
  if (r && !r.ok && !/^bug|^adminBug/.test(action) && !['network', 'timeout', 'not_logged_in', 'id_needed', 'already_done'].includes(r.error)) logErr(`受け付けの断り: ${action} ${r.error || ''}`);   // 自動の誤りの記録(0607)   // 登録されていない・止められた・カードが使えなくなった → ログアウトの形にして、はっきり知らせる
  return r || { ok: false, error: 'bad_response' };
}
// 送れない時の案内(0821)。送る時(sendNow)は WEAK_TEXT・SRV_TEXT + 端末に残っている旨。押してすぐ結果が要る操作(管理・元に戻す等)は WEAK_TEXT_TRY
const WEAK_TEXT = '電波が弱いようです。つながったら自動で送ります。', WEAK_TEXT_TRY = '電波が弱いようです。電波のよい所で、もう一度押してください。', SRV_TEXT = '受け付けが応えません。管理者に知らせてください。';
const sendErrText = e => NET_ERR.includes(e) ? WEAK_TEXT + '(記録はこの端末に残っています)' : SRV_ERR.includes(e) ? SRV_TEXT + '(記録はこの端末に残っています)' : errText(e);
const ERR_TEXT = {
  not_configured: '送り先の設定がまだです(公開の時に入ります)。入るまでは、ログインできません。', not_logged_in: 'Google でログインするか、ログインカードをかざして(QR を読んで)ください。',
  stopped: 'このアカウントは止められています。管理者に連絡してください。', pass_invalid: 'このカードのログインは使えなくなりました(番号を戻した・期限切れなど)。もう一度カードをかざして(QR を読んで)、暗証番号を入れてください。',
  card_stopped: 'このカードは止まっています。管理者に連絡してください。', card_not_found: 'このカードは登録されていません(作り直された・止められたカードかもしれません)。管理者に連絡してください。',
  wrong_pin: '暗証番号が違います。', bad_pin: '暗証番号は数字4つです。', last_admin: '最後の管理者は外せません(先にほかの人を管理者にしてください)。', duplicate: 'そのメールアドレスは、もう登録されています。',
  bad_confirm: '「消す」と打ってください。', bad_email: 'メールアドレスの形が違います。', bad_role: 'その役割は選べません。', bad_name: '呼び名は1〜20字で入れてください。', card_no_role: 'カードの人には役割を付けられません(全体を見るのは Google の人だけ)。',
  network: WEAK_TEXT_TRY, http_error: SRV_TEXT, stalled: SRV_TEXT, no_cors: SRV_TEXT, bad_response: SRV_TEXT, server_error: SRV_TEXT, bad_json: SRV_TEXT, not_registered: 'この Google アカウントは、まだ登録されていません。管理者に登録を頼んでください。',
  token_expired: 'ログインの期限が切れました。もう一度ログインしてください。', invalid_token: 'ログインをやり直してください。', wrong_audience: 'ログインをやり直してください。',
  server_not_configured: '受け付け側の設定がまだです(管理者へ連絡してください)。', email_not_verified: 'この Google アカウントは使えません(メールが確認されていません)。',
  busy: '受け付けが混んでいます。少し待ってもう一度送ってください。',
  timeout: WEAK_TEXT_TRY,
  already_done: 'この操作は、もう受け付けで済んでいます(二度押しや送り直しの分は、行いませんでした)。一覧を見てください。',
  deleted: 'この記録・えさ場は削除されています(元に戻してから直してください)。', restore_expired: '削除してから30日を過ぎたので、元に戻せません(シートの行は残っています。管理者に相談してください)。',
  id_needed: '全員の記録・管理は、Google でもう一度確かめてから使えます。画面に出る Google のボタン(または設定の「Google でもう一度ログイン」)を押してください。', card_no_all: '全員の記録は、Google でログインした人だけが見られます(ログインカードでは、自分の記録だけです)。', not_found: 'これは受け付けに見つかりません(自分の記録・えさ場だけ直せます)。', not_allowed: 'この操作は、今のアカウントでは使えません(役割がありません)。', bad_site: 'そのえさ場は使えません(自分の、使っているえさ場だけ選べます)。', unknown_action: '受け付けがまだ新しくなっていません(管理者へ連絡してください)。この端末に貯めた分は残っています。',
};
const errText = e => ERR_TEXT[e] || `送れませんでした(${e || '不明'})`;
const blobToB64 = b => new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = ng; r.readAsDataURL(b); });

let sending = false, sendAgain = false, sendingP = null;   // sendAgain: 送っている最中に保存された物がある(終わったら続けて送る)。sendingP: 今の送りが終わるのを待つため
// 電波・ログイン・受け付けの都合で送れなかっただけの誤り。この時は端末に貯めた直し・変化を残して、あとでもう一度送る
const TRANSIENT = ['network', 'timeout', 'http_error', 'stalled', 'no_cors', 'busy', 'not_logged_in', 'not_configured', 'token_expired', 'invalid_token', 'wrong_audience', 'wrong_issuer', 'bad_token', 'tokeninfo_unreachable', 'server_error', 'server_not_configured', 'bad_json', 'bad_response', 'unknown_action', 'not_registered', 'email_not_verified', 'stopped', 'pass_invalid', 'card_stopped'];
// 端末に貯めた「直し」「状態の変化」を、記録ごとに古い順に送る。送れた分は貯めた列から外す(外す前に記録を読み直す=送っている間に足された分を消さない)
async function sendOps() {
  let sent = 0, lastErr = null, dropped = [];
  const ids = (await allRecords()).filter(r => r.status === 'sent' && opsOf(r).length).sort((a, b) => opsOf(a)[0].queuedAt.localeCompare(opsOf(b)[0].queuedAt)).map(r => r.id);
  outer: for (const id of ids) {
    for (;;) {
      const r = await getRecord(id), op = r && opsOf(r)[0]; if (!op) break;
      const res = op.type === 'edit' ? await api('edit', { recordId: id, fields: op.fields })
        : op.type === 'delete' || op.type === 'restore' ? await api(op.type, { recordId: id })
        : await api('change', { change: { id: op.id, recordId: id, time: op.time, changes: op.changes, petReasons: op.petReasons, petOther: op.petOther, goneReason: op.goneReason, goneOther: op.goneOther, goneDate: op.goneDate, lat: op.lat, lng: op.lng, acc: op.acc } });
      const f = await getRecord(id); if (!f) break;
      if (!res.ok && TRANSIENT.includes(res.error)) { lastErr = res.error; break outer; }
      f.ops = opsOf(f).filter(o => o.opId !== op.opId);
      if (!res.ok) dropped.push(res.error);   // 受け付けが断った直し(見つからない・内容がおかしい)は取り下げる。画面は次の取り直しで受け付けの内容に戻る
      else if (op.type === 'edit') { f.editCount = res.editCount; f.editedAt = res.editedAt; sent++; }
      else if (op.type === 'delete' || op.type === 'restore') sent++;
      else { if (!res.duplicate && !res.unchanged) f.changes = [...(f.changes || []), { id: op.id, time: op.time, items: (res.items || []).map(({ label, from, to }) => ({ label, from, to })) }]; sent++; }
      await putAll([f]);
    }
  }
  return { sent, lastErr, dropped };
}
// えさ場: 未送信の登録 → 貯めた名前の直し・「使っていない」を、古い順に送る。記録より先に送る(記録がえさ場に結び付くため)
async function sendSites() {
  let sent = 0, lastErr = null;
  const pend = (await allSites()).filter(x => x.status === 'pending' && !x.deleted).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const x of pend) {
    const res = await api('siteAdd', { site: { id: x.id, name: x.name, memo: x.memo, lat: x.lat, lng: x.lng, acc: x.acc } });
    if (!res.ok) { lastErr = res.error; return { sent, lastErr }; }
    const f = await getSite(x.id); if (!f) continue;
    f.status = 'sent'; f.recorderId = auth.recorderId || f.recorderId; Object.assign(f, { mesh3: res.site.mesh3, mesh500: res.site.mesh500, mesh250: res.site.mesh250 });   // メッシュは受け付けの値を正とする
    const fx = {}; if (f.name !== x.name) fx.name = f.name; if ((f.memo || '') !== (x.memo || '')) fx.memo = f.memo || ''; if (f.retired) fx.retired = true;   // 送っている間に直された分
    if (Object.keys(fx).length) f.ops = [...(f.ops || []), { opId: newId('o'), type: 'siteEdit', fields: fx, queuedAt: new Date().toISOString() }];
    if (f.deleted) f.ops = [...(f.ops || []), { opId: newId('o'), type: 'siteDelete', queuedAt: new Date().toISOString() }];
    await putSites([f]); sent++;
  }
  const withOps = (await allSites()).filter(x => x.status === 'sent' && (x.ops || []).length);
  for (const x of withOps) {
    for (;;) {
      const f = await getSite(x.id), op = f && (f.ops || [])[0]; if (!op) break;
      const res = op.type === 'siteDelete' || op.type === 'siteRestore' ? await api(op.type, { siteId: x.id }) : await api('siteEdit', { siteId: x.id, fields: op.fields });
      if (!res.ok && TRANSIENT.includes(res.error)) return { sent, lastErr: res.error };
      const g = await getSite(x.id); if (!g) break;
      g.ops = (g.ops || []).filter(o => o.opId !== op.opId); if (res.ok) sent++;   // 受け付けが断った物(見つからない等)は取り下げる。次の取り直しで受け付けの内容に戻る
      await putSites([g]);
    }
  }
  return { sent, lastErr };
}
// 未送信を1件ずつ順に送る。送れた物は status を sent にし、入力者IDを入れる。そのあと、貯めた直し・変化を送る
// 送っている最中に呼ばれたら、今の送りが終わった後にもう一度送る(前は黙って何もせず、送信中に保存した猫が「未送信」のまま残った。2026-10-25 2332)
function sendPending(quiet = false) {
  if (sending) { sendAgain = true; if (!quiet) toast('今送っています。終わったら続けて送ります', 3000); return sendingP; }   // 押したボタンは、今の送りが終わるまで「送っています…」のまま
  sending = true; sendAgain = false;
  return (sendingP = sendNow(quiet));
}
async function sendNow(quiet) {
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  try {
    const all = await allRecords(), pend = all.filter(r => r.status === 'pending' && !r.deleted).sort((a, b) => a.time.localeCompare(b.time)), sites = await allSites();
    if (!pend.length && !all.some(r => opsOf(r).length) && !sites.some(x => (x.status === 'pending' && !x.deleted) || (x.ops || []).length)) return say('未送信の記録はありません');
    if (!configured()) return say(errText('not_configured'), 5000);
    if (!loggedIn()) return say(errText('not_logged_in'), 5000);
    if (!navigator.onLine) return say(WEAK_TEXT + '(記録はこの端末に残っています)', 5000);
    let sent = 0, lastErr = null, dropped = [];
    const so = await sendSites(); sent += so.sent; lastErr = so.lastErr;
    if (!lastErr) for (const r of pend) {
      const record = {}; SEND_KEYS.forEach(k => { if (r[k] !== undefined) record[k] = r[k]; });
      const photos = []; for (const p of (r.photos || [])) { try { photos.push(await blobToB64(p)); } catch { /* 読めない写真は送らない */ } }
      say(`送っています… ${sent + 1}/${pend.length}`);
      const res = await api('submit', { record, photos }, photos.length ? API_WAIT_PHOTO_MS : API_WAIT_MS);
      if (!res.ok) { lastErr = res.error; break; } // 1件失敗したら止める(順番を守る・同じ案内を繰り返さない)
      // 送っている間に直された・削除された物は、端末の今の形を読み直し、違う所を直し・削除として続けて送る(前は送る前の形で上書きして、直しが消えた)
      const f = (await getRecord(r.id)) || r, now = new Date().toISOString(), diff = {};
      if (res.siteDropped && f.siteId === record.siteId) f.siteId = '';
      // 受け付けに前の送りがもうあった(duplicate=返事が電波で切れた送りの、送り直し)時は、受け付けの中身が分からないので、直せる所を全部「直し」で送る(同じ所は受け付けが数えない。0821)
      const base = res.duplicate ? {} : record;
      [...EDIT_FIELD_KEYS, 'feature', 'siteId'].forEach(k => { if (k === 'siteId' && res.siteDropped) return; if ((f[k] ?? '') !== (base[k] ?? '')) diff[k] = f[k] ?? ''; });
      if (JSON.stringify(f.petReasons || []) !== JSON.stringify(base.petReasons || []) || (f.petOther || '') !== (base.petOther || '')) { diff.petReasons = f.petReasons || []; diff.petOther = f.petOther || ''; }
      f.status = 'sent'; f.recorderId = res.recorderId; f.sentAt = now;
      if (homeSrv && !res.duplicate && !r.deleted && !isGone(r)) { homeSrv.all++; homeSrv.mine++; }   // ホームの数: 送れた新しい記録を受け付けの数へ移す(送った後の list で取り直す)
      if (Object.keys(diff).length) f.ops = [...opsOf(f), { type: 'edit', opId: newId('o'), queuedAt: now, fields: diff }];
      if (f.deleted) f.ops = [...opsOf(f), { type: 'delete', opId: newId('o'), queuedAt: now }];
      await putAll([f]); sent++;
    }
    if (!lastErr) { const o = await sendOps(); sent += o.sent; lastErr = o.lastErr; dropped = o.dropped; }
    await updateBadge();
    lastSendErr = lastErr;
    if (lastErr) { say((sent ? `${sent}件を送りました。` : '') + sendErrText(lastErr), 7000); if (noAnswer(lastErr)) retryLater(); }
    else {
      const dmsg = dropped.length ? `${sent}件を送りました。受け付けが受け付けなかった直し・変化が${dropped.length}件あります(${errText(dropped[0])})` : '';
      say(dmsg || `${sent}件を送りました(送信済み)`, dropped.length ? 7000 : 3500);
      await refreshFromServer(true);
      if (dmsg) $('#sendmsg').textContent = dmsg;   // 取り直しの案内で上書きされないように
    }
    renderActiveTab();
  } catch (e) { if (!DB_TEXT[e && e.code]) throw e; say(dbErrText(e), 7000); }
  finally { sending = false; if (sendAgain) { sendAgain = false; if (noAnswer(lastSendErr)) retryLater(); else setTimeout(() => { if (!sending) sendPending(true); }, 0); } }   // 電波・受け付けの都合で止まった直後は、すぐ送り直さない(自動の送り直しに任せる。すぐ送り直すと、時間切れのたびに続けて送り続けた)
}

// 受け付けの記録と端末の控えを合わせる(2026-10-26 0821)。読みと書きを1つの取引で行う(合わせている間に押された削除・直しを、古い形で上書きしない)。
//  ・未送信の直し・変化・削除がある記録は上書きしない(送ってから合わせる)
//  ・端末では未送信なのに受け付けにある記録(送った返事が電波で切れた物): 送れた扱いにし、端末で後から直した所・削除を「直し」「削除」として貯める。
//    前はここで受け付けの形に上書きしたので、返事が切れた後に削除した猫が、取り直しで復活した(管理者 msg 6681・6683)
//  ・受け付けに無くなった自分の送信済みの記録(管理者が試しの記録をすべて消した等)は、端末からも外す。未送信の物は残す
// 戻り値: 送る物を貯めたか
function mergeServerRecords(list, myId) {
  let queued = false;
  return run('readwrite', st => {
    const q = st.getAll();
    q.onsuccess = () => {
      const local = new Map(q.result.map(r => [r.id, r])), seen = new Set(), now = new Date().toISOString();
      for (const s of list) {
        seen.add(s.id);
        const l = local.get(s.id);
        if (!l) { st.put({ ...s, photos: [], remote: true, status: 'sent' }); continue; }   // 別の端末や消した後の記録。写真はこの端末に無い
        let dirty = false;
        if (l.status !== 'sent') {
          const diff = {};
          [...EDIT_FIELD_KEYS, 'feature', 'siteId'].forEach(k => { if ((l[k] ?? '') !== (s[k] ?? '')) diff[k] = l[k] ?? ''; });
          if (JSON.stringify(l.petReasons || []) !== JSON.stringify(s.petReasons || []) || (l.petOther || '') !== (s.petOther || '')) { diff.petReasons = l.petReasons || []; diff.petOther = l.petOther || ''; }
          l.status = 'sent'; l.sentAt = l.sentAt || now; ['mesh3', 'mesh500', 'mesh250'].forEach(k => { if (s[k]) l[k] = s[k]; });
          if (!l.deleted && Object.keys(diff).length) { l.ops = [...opsOf(l), { type: 'edit', opId: newId('o'), queuedAt: now, fields: diff }]; queued = true; }
          if (l.deleted && !s.deleted) { l.ops = [...opsOf(l), { type: 'delete', opId: newId('o'), queuedAt: now }]; queued = true; }
          dirty = true;
        }
        if (l.recorderId !== s.recorderId) { l.recorderId = s.recorderId; dirty = true; }
        if (!opsOf(l).length) {   // 送っていない直し・変化・削除が無い記録は、受け付けの今の内容に合わせる(別の端末で直した分も入る)
          for (const k of SERVER_KEYS) if (JSON.stringify(l[k]) !== JSON.stringify(s[k])) { l[k] = s[k]; dirty = true; }
        }
        if (dirty) st.put(l);
      }
      for (const l of q.result) if (!seen.has(l.id) && l.status === 'sent' && !opsOf(l).length && myId && l.recorderId === myId) st.delete(l.id);
    };
  }).then(() => queued);
}
// 自分の記録を受け付けから取り直し、端末の控えと合わせる(他人の記録は受け付けが返さない)
async function refreshFromServer(quiet = false) {
  const say = (m, ms) => { if (!quiet) toast(m, ms); $('#sendmsg').textContent = m; };
  if (!configured()) return say(errText('not_configured'), 5000);
  if (!loggedIn()) return say(errText('not_logged_in'), 5000);
  const res = await api('list');
  if (!res.ok) return say(noAnswer(res.error) ? (NET_ERR.includes(res.error) ? WEAK_TEXT_TRY : SRV_TEXT) : errText(res.error), 5000);
  lastRefreshAt = Date.now();
  applyMeta(res);
  const lsites = new Map((await allSites()).map(x => [x.id, x])), putS = [], seenS = new Set(); let queuedS = false;
  for (const s of res.sites || []) {   // えさ場: 送信待ちの直しが無い物は、受け付けの内容に合わせる。端末に無い物(別の端末で登録)は足す
    const l = lsites.get(s.id); seenS.add(s.id);
    if (!l) putS.push({ ...s, status: 'sent', ops: [] });
    else if (l.status !== 'sent') {   // 登録の返事が電波で切れた物(受け付けにはある): 送れた扱いにし、端末で後から直した所・削除を貯める(記録と同じ。0821)
      const fx = {}, now = new Date().toISOString(); if (l.name !== s.name) fx.name = l.name; if ((l.memo || '') !== (s.memo || '')) fx.memo = l.memo || ''; if (!!l.retired !== !!s.retired) fx.retired = !!l.retired;
      l.status = 'sent'; l.recorderId = s.recorderId; ['mesh3', 'mesh500', 'mesh250'].forEach(k => { if (s[k]) l[k] = s[k]; });
      if (!l.deleted && Object.keys(fx).length) { l.ops = [...(l.ops || []), { opId: newId('o'), type: 'siteEdit', fields: fx, queuedAt: now }]; queuedS = true; }
      if (l.deleted && !s.deleted) { l.ops = [...(l.ops || []), { opId: newId('o'), type: 'siteDelete', queuedAt: now }]; queuedS = true; }
      putS.push(l);
    }
    else if (!(l.ops || []).length) { let d = false; for (const k of ['name', 'memo', 'retired', 'mesh3', 'mesh500', 'mesh250', 'recorderId', 'deleted', 'deletedAt']) if (l[k] !== s[k]) { l[k] = s[k]; d = true; } if (d) putS.push(l); }
  }
  if (putS.length) await putSites(putS);
  const goneS = [...lsites.values()].filter(x => !seenS.has(x.id) && x.status === 'sent' && !(x.ops || []).length && res.recorderId && x.recorderId === res.recorderId).map(x => x.id);   // 受け付けに無くなった自分のえさ場(試しの記録をすべて消した等)
  if (goneS.length) await run('readwrite', s => { goneS.forEach(id => s.delete(id)); }, SITES);
  if (queuedS) sendPending(true);
  const queued = await mergeServerRecords(res.records || [], res.recorderId);
  if (queued) sendPending(true);   // 端末に残っていた削除・直しを、続けて送る(送っている最中なら、終わった後に)
  if (auth && auth.recorderId !== res.recorderId) { auth.recorderId = res.recorderId; saveAuth(); renderAuth(); }
  await updateBadge();
  say(`自分の記録 ${res.records.filter(r => !r.deleted).length}件を受け付けから取り直しました`);
  if (scope === 'all') await setScope('all', true);   // 「全員の記録」を見ている時は、全員の写しも取り直す(前は切り替えた時の古い写しのままだった)
  renderActiveTab();
  return res;
}
// 電波があってログイン中なら、未送信を送り、記録を取り直す(案内は画面下に出さない)
// 自動の取り直し(2026-10-26): ログインの直後・開いた時・電波が戻った時・送り終えた後・画面に戻った時(前から5分以上)。未送信の記録は消さない(送ってから合わせる)
const AUTO_REFRESH_MS = 5 * 60000;
let lastRefreshAt = 0, autoP = null, syncAgain = false, retryTimer = null, lastSendErr = null;   // lastSendErr: 前の送りが電波・受け付けの都合で止まった訳(その時は続けて取り直さない=送れない案内を上書きしない)
// 電波・受け付けの都合で送れなかった時は、1分ごとに自動で送り直す(電波が弱い所では「電波が戻った」の合図が来ないため。0821)。送る物が無くなれば止まる
const RETRY_MS = Number(CONF.RETRY_MS) > 0 ? Number(CONF.RETRY_MS) : 60000;
function retryLater() {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => { retryTimer = null; if (sending || autoP) return retryLater(); await syncQuiet(); }, RETRY_MS);   // 送っている最中なら、重ねずに次の回へ
}
function syncQuiet() {
  if (!configured() || !loggedIn() || !navigator.onLine) return Promise.resolve();
  if (autoP) { syncAgain = true; return autoP; }   // 取り直しの最中に呼ばれたら(削除を押した等)、終わってからもう1回だけ(前は呼ばれた分を送らずに終えた)
  const ind = $('#refreshing'); if (ind) ind.classList.remove('hidden');
  return (autoP = (async () => {
    try { const t0 = Date.now(); lastSendErr = null; await sendPending(true); if (lastRefreshAt < t0 && loggedIn() && navigator.onLine && !noAnswer(lastSendErr)) await refreshFromServer(true);
      if (!noAnswer(lastSendErr)) { await bugFlush(true); await autoErrFlush(); } }   // 不具合の知らせの残り・1日1回の自動の誤り(0607)
    catch (e) { /* 自動の時は黙る(手で押した時に案内が出る) */ }
    finally { autoP = null; if (ind) ind.classList.add('hidden'); if (syncAgain) { syncAgain = false; setTimeout(() => syncQuiet(), 0); } }
  })());
}

// ---- 写真: 位置情報を消し、縮めて、Blob にする ----
// canvas に描き直して JPEG にすると、撮影場所(EXIF の GPS)を含む付属情報はすべて落ちる。
async function cleanImage(file, side = MAX_SIDE, quality = 0.8) {
  let src, w, h;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; }
  catch {
    src = await new Promise((ok, ng) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = ng; i.src = u; });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const s = Math.min(1, side / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise((ok, ng) => c.toBlob(b => b ? ok(b) : ng(new Error('写真を変換できません')), 'image/jpeg', quality));
}

let form = {}, photos = [], loc = null, saving = false;

function distM(a, b) {
  const R = 6371000, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 項目の選択肢を root の中に出し、押すと st(選んだ値の入れ物)に入れる。入力・直す・状態の変化で同じ部品を使う。
//  keys: 出す項目 / optional: もう一度押すと外れる項目 / idp: id の前置き(同じ画面に2つ出ても id が重ならないように)
//  current: 今の値(状態の変化の画面)。今と同じ選択肢には印を付け、押しても選ばない / onchange: 選んだ後に呼ぶ
function mountFields(root, st, { keys, optional = ['pet'], idp = '', current = null, onchange = () => {} }) {
  root.innerHTML = FIELDS.filter(f => keys.includes(f[0])).map(([k, label, opts, hint]) => `<div class="card"><h3>${label}</h3>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${current ? `<p class="now">今: ${esc(current[k] || '(未入力)')}</p>` : ''}${k === 'color' ? '<button type="button" class="coatbigbtn">見本を大きく見る</button>' : ''}<div class="opts${k === 'color' ? ' coat' : k === 'hairLen' ? ' three' : ''}" data-k="${k}">${opts.map(o => `<button type="button" data-v="${esc(o)}"${current && current[k] === o ? ' class="cur"' : ''}>${k === 'color' ? coatSwatch(o) + '<span class="cn">' + esc(o) + '</span>' : esc(o)}${current && current[k] === o ? '(今)' : ''}</button>`).join('')}</div>${k === 'color' ? `<input id="${idp}colorother" class="petother colorother hidden" type="text" maxlength="${COLOR_OTHER_MAX}" placeholder="どんな毛色か(20字まで・必ず書く)" aria-label="その他の毛色"><div class="coatpick hidden" aria-live="polite"></div>` : ''}</div>`).join('');
  const petBox = root.querySelector('.opts[data-k=pet]');
  if (petBox) petBox.insertAdjacentHTML('afterend', `<div id="${idp}petwhy" class="petwhy hidden"><p class="hint">理由があれば選んでください(いくつでも・任意)</p>
    <div class="opts" id="${idp}petreasons">${PET_REASONS.map(o => `<button type="button" data-r="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    <input id="${idp}petother" class="petother hidden" type="text" maxlength="${PET_OTHER_MAX}" placeholder="その他の理由(短く)" aria-label="その他の理由">
    <p class="note">人の名前や住所は書かないでください。</p></div>`);
  const neuBox = root.querySelector('.opts[data-k=neuter]');
  const neuNow = () => st.neuter || (current && current.neuter) || '';
  const why = () => root.querySelector('.petwhy'), other = () => root.querySelector('.petwhy .petother');
  const cOther = root.querySelector('.colorother');   // 毛色の「その他」の自由記入(その他を選んだ時だけ出す)
  const cPick = root.querySelector('.coatpick');   // 20261027-1051: 選んだ毛色を、表の下に大きな写真で出す(合っているか一目で確かめる)
  const syncPick = () => { if (!cPick) return; const c = st.color; cPick.classList.toggle('hidden', !c); cPick.innerHTML = c ? `${coatSwatch(c, true)}<p>選んだ毛色: <b>${esc(c)}</b></p>` : ''; };
  const syncColor = () => { syncPick(); if (!cOther) return; const on = st.color === COLOR_OTHER; cOther.classList.toggle('hidden', !on); if (on) cOther.value = st.colorOther || ''; else delete st.colorOther; };
  const cBig = root.querySelector('.coatbigbtn');
  if (cBig) cBig.onclick = () => openCoatBig(root.querySelector('.opts[data-k=color]'));
  if (cOther) cOther.oninput = () => { st.colorOther = cOther.value; };
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
    if (k === 'color') { syncColor(); if (st.color === COLOR_OTHER && !(st.colorOther || '').trim()) cOther.focus(); }
    if (k === 'ear' && neuBox && (v === '右' || v === '左') && st.ear === v && neuNow() !== NEUTER_DONE) {   // さくら耳が右・左なら、不妊手術は自動で「済み」(直せる)
      st.neuter = NEUTER_DONE; neuBox.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x.dataset.v === NEUTER_DONE));
    }
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
  syncColor();
  if (why() && st.pet === 'あり') {
    why().classList.remove('hidden');
    (st.petReasons || []).forEach(r => { const b = why().querySelector(`button[data-r="${CSS.escape(r)}"]`); if (b) b.classList.add('sel'); });
    if ((st.petReasons || []).includes('その他')) { other().classList.remove('hidden'); other().value = st.petOther || ''; }
  }
  return { sync: () => { sync(); syncColor(); } };
}
// 毛色が「その他」なのに自由記入が空なら、その項目名を返す(入力・直すの「まだ選んでいない項目」に足す)
const colorOtherMissing = st => st.color === COLOR_OTHER && !(st.colorOther || '').trim() ? ['毛色の「その他」の欄'] : [];
// 入力の途中か(不妊手術の既定「分からない」だけなら、まだ何も入れていない)
function formTouched() { return Object.keys(form).some(k => !(k === 'neuter' && form[k] === NEUTER_UNKNOWN) && !(k === 'hairLen' && form[k] === HAIR_UNKNOWN)); }
let formCtl;
function buildForm() {
  optionsDirty = false; if (!form.neuter) form.neuter = NEUTER_UNKNOWN;   // 不妊手術の既定は「分からない」
  if (!form.hairLen) form.hairLen = HAIR_UNKNOWN;   // 毛の長さの既定も「分からない」(押し間違えても直せる)
  formCtl = mountFields($('#fields'), form, { keys: FIELDS.map(f => f[0]), optional: ['pet'], idp: '', onchange: checkDup });
}

function setLocInfo(text, bad) { const el = $('#locinfo'); el.textContent = text; el.classList.toggle('bad', !!bad); }
// 2026-10-26 1212: gpsToken。GPS を待っている間に、地図やえさ場で猫の位置を決めたら、後から来た GPS の返事では上書きしない
let gpsToken = 0;
function getGps() {
  const my = ++gpsToken;
  loc = null; setLocInfo('位置: 取得中…'); showLocMini(); checkDup(); renderSiteCands();
  if (!navigator.geolocation) return setLocInfo('位置: この端末では取得できません。「地図で場所を指定」を押してください', true);
  navigator.geolocation.getCurrentPosition(p => { if (my === gpsToken) setLoc(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy), 'GPS'); },
    () => { if (my === gpsToken) setLocInfo('位置: 取得できませんでした。位置情報の許可を確かめるか、「地図で場所を指定」を押してください', true); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
// src: 'GPS' / '地図' / SITE_LOC_SRC(えさ場の位置にした。siteName = そのえさ場の名前)。記録の「位置の取り方」に残る
const SITE_LOC_SRC = 'えさ場の位置';
// 地図で選んだ時だけ、入力の画面に小さな地図(ピン)を出し、ボタンを「地図で選び直す」にする(2026-10-26 2105)
function showLocMini() {
  const on = !!(loc && loc.src === '地図'), el = $('#locmini');
  el.classList.toggle('hidden', !on); $('#btn-pick').textContent = on ? '地図で選び直す' : '地図で場所を指定';
  if (on) miniMap(el, loc.lat, loc.lng);
}
function setLoc(lat, lng, acc, src, siteName) {
  if (src !== 'GPS') gpsToken++;
  loc = { lat, lng, acc, src }; renderSiteCands();
  if (src === 'GPS') setLocInfo(`位置: GPSで取得(誤差 約${acc}m)${acc > 50 ? '。誤差が大きめです。取り直すと良くなることがあります' : ''}`, acc > 50);
  else if (src === SITE_LOC_SRC) setLocInfo(`位置: えさ場「${siteName || ''}」の位置にしました`);
  else setLocInfo('位置: 地図で選んだ場所(下の地図のピンの所)');
  showLocMini(); checkDup();
  if (form.siteId) onSitePick(form.siteId); else hideSiteAsk();   // 選んでいるえさ場から100mより遠くなったら、もう一度聞く
}

let dupToken = 0;
async function checkDup() {
  const box = $('#dup'), my = ++dupToken;
  if (!loc || !form.color || !form.ear) return box.classList.add('hidden');
  let near; try { near = (await allRecords()).filter(r => !r.deleted && colorBase(r.color) === form.color && r.ear === form.ear && distM(loc, r) <= 50); } catch { return; }
  if (my !== dupToken) return;
  if (!near.length) return box.classList.add('hidden');
  box.innerHTML = `⚠️ 前に記録した猫ではありませんか?<br>同じ毛色(${esc(form.color)})・さくら耳(${esc(form.ear)})の記録が、50m以内に${near.length}件あります。` +
    near.slice(0, 3).map(r => `<br>・${fmt(r.time)} 約${Math.round(distM(loc, r))}m ${esc(r.feature || '')}`).join('');
  box.classList.remove('hidden');
}

// ---- えさ場(自分の物だけ) ----
const liveSites = sites => sites.filter(x => !x.retired && !x.deleted);
// ref から近い順の「使っているえさ場」。maxM を渡すとその距離内だけ
function sitesNear(sites, ref, maxM) {
  return liveSites(sites).map(x => ({ ...x, d: Math.round(distM(ref, x)) })).filter(x => maxM == null || x.d <= maxM).sort((a, b) => a.d - b.d);
}
// えさ場のプルダウン(2026-10-25 2332: 色の付くボタンから替えた。1行目で「えさ場なし」をはっきり選べる)。
// 2026-10-26 1212(管理者 msg 6738): 帰ってから入力しても選べるように、候補は「この猫の位置」から数え、100m より遠い物も全部出す。
//  1行目「えさ場なし」→「近くのえさ場」(猫の位置から100m以内・近い順・距離つき)→ 区切り「そのほかの自分のえさ場」(残りの使っている物・近い順・距離つき)
//  list = 候補(d = 猫の位置からの距離m。位置が無ければ null)、head = 区切りの前に出す物(今のえさ場が使えない時など)、
//  none = 1行目の文字、cur = 今のえさ場ID(「(今)」の印)、empty = 近くに1つも無い時に出す1行
const siteOpt = (x, cur) => `<option value="${esc(x.id)}">${esc(x.name)}${x.d != null ? `(約 ${x.d}m)` : ''}${cur === x.id ? '(今)' : ''}${x.status === 'pending' ? '・未送信' : ''}${x.retired ? '・使っていない' : ''}</option>`;
const siteOptions = (list, { none, cur, empty, head = [] }) => {
  const near = list.filter(x => x.d != null && x.d <= SITE_NEAR_M), rest = list.filter(x => !near.includes(x)), placed = list.some(x => x.d != null);
  return `<option value="">${esc(none)}${cur === '' ? '(今)' : ''}</option>` + head.map(x => siteOpt(x, cur)).join('') +
    (near.length ? `<optgroup label="近くのえさ場(猫の位置から${SITE_NEAR_M}m以内)">${near.map(x => siteOpt(x, cur)).join('')}</optgroup>` : placed && empty ? `<option value="" disabled>${esc(empty)}</option>` : '') +
    (rest.length ? `<optgroup label="${placed ? 'そのほかの自分のえさ場' : '自分のえさ場'}">${rest.map(x => siteOpt(x, cur)).join('')}</optgroup>` : '');
};
// 自分の使っているえさ場を、ref(猫の位置)から近い順に・距離つきで。ref が無ければ名前の順(距離なし)
const siteCands = (sites, ref) => ref ? sitesNear(sites, ref) : liveSites(sites).map(x => ({ ...x, d: null })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
// 入力の画面: 1行目「えさ場なし(選ばない)」が既定。どのえさ場も選べる(消した・使わないにした物だけは外す)。猫の位置が変わったら並べ直す
let siteToken = 0;
async function renderSiteCands() {
  const sel = $('#sitesel'), my = ++siteToken; if (!sel) return;
  let all; try { all = await allSites(); } catch { return; }
  if (my !== siteToken) return;
  const list = siteCands(all, loc);
  if (form.siteId && !list.some(x => x.id === form.siteId)) { delete form.siteId; hideSiteAsk(); }
  sel.innerHTML = siteOptions(list, { none: 'えさ場なし(選ばない)', empty: '(猫の位置から100m以内のえさ場はありません)' });
  sel.value = form.siteId || '';
  const picked = form.siteId && list.find(x => x.id === form.siteId);
  $('#sitenone').textContent = !list.length ? 'えさ場はまだ登録されていません。下のボタンか、下の「えさ場」の画面で登録できます(地図で場所を指定しても登録できます)。'
    : (loc ? '猫の位置から近い順です。100m以内の物が上に、そのほかの自分のえさ場も下から選べます(家に帰ってからでも選べます)。' : '猫の位置が決まると、近い順に並びます。')
      + (picked && picked.d != null && picked.d > SITE_NEAR_M ? `選んだえさ場は、猫の位置から約 ${picked.d}m です。` : '');
}
// えさ場を選んだ時: 猫の位置から100mより遠い(または猫の位置がまだ無い)なら、「猫の位置をえさ場の位置にしますか?」と聞く(はい / そのまま)
const hideSiteAsk = () => { const b = $('#siteask'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; } };
async function onSitePick(v) {
  hideSiteAsk();
  if (!v) { delete form.siteId; return renderSiteCands(); }
  form.siteId = v;
  let x; try { x = (await allSites()).find(s => s.id === v); } catch { return; }
  if (!x || form.siteId !== v) return;
  const d = loc ? Math.round(distM(loc, x)) : null;
  if (d != null && d <= SITE_NEAR_M) return renderSiteCands();
  const box = $('#siteask');
  box.innerHTML = `<p>${d != null ? `えさ場から 約${d}m 離れています。` : '猫の位置がまだ決まっていません。'}猫の位置をえさ場の位置にしますか?</p><div class="row"><button type="button" id="siteask-yes" class="small yes">はい</button><button type="button" id="siteask-no" class="small">そのまま</button></div>`;
  box.classList.remove('hidden');
  $('#siteask-yes').onclick = () => { hideSiteAsk(); setLoc(x.lat, x.lng, null, SITE_LOC_SRC, x.name); toast(`猫の位置を、えさ場「${x.name}」の位置にしました`); };
  $('#siteask-no').onclick = () => { hideSiteAsk(); renderSiteCands(); };
  renderSiteCands();
}

// ---- 写真の追加・削除 ----
let thumbUrls = [];
function renderThumbs() {
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = photos.map(p => URL.createObjectURL(p));
  $('#thumbs').innerHTML = photos.map((_, i) => `<div class="th"><img src="${thumbUrls[i]}" class="zoomable" data-zoom="${i}" alt="写真${i + 1}(押すと大きく見られます)"><button type="button" data-i="${i}" aria-label="この写真を外す">✕</button></div>`).join('');
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
  if (!loggedIn()) { renderAuth(); return toast('ログインの期限が切れました。もう一度ログインしてください(いま入れた内容は、ログインすると続けて保存できます)', 6000); }
  if (saving) return;
  if (dbNotUsable()) return toast(DB_TEXT[dbState], 8000);   // 前の画面が開いたまま等: 待たずに理由を出す
  const miss = FIELDS.filter(f => REQUIRED.includes(f[0]) && !form[f[0]]).map(f => f[1]).concat(colorOtherMissing(form));
  if (miss.length) return toast('まだ選んでいない項目があります:\n' + miss.join('、'), 5000);
  if (!loc) return toast('位置がありません。「地図で場所を指定」を押してください', 5000);
  saving = true; const btn = $('#btn-save'), was = btn.innerHTML; btn.disabled = true; btn.textContent = '保存しています…';
  const done = () => { saving = false; btn.disabled = false; btn.innerHTML = was; };
  try {
    await putAll([{ id: newId(), time: new Date().toISOString(),
      recorderId: auth && auth.recorderId || null, // 受け付けが返した入力者ID(名前は持たない)。送信時に受け付け側で確定する
      area: '', lat: loc.lat, lng: loc.lng, acc: loc.acc, locSrc: loc.src, ...(meshCodes(loc.lat, loc.lng) || {}),   // 区域は決め打ちをやめた(えさ場と地域メッシュで表す)。メッシュは端末の計算(送信後は受け付けの値になる)
      ...form, ...(form.pet === 'あり' ? { petReasons: form.petReasons || [], petOther: form.petReasons && form.petReasons.includes('その他') ? (form.petOther || '').trim().slice(0, PET_OTHER_MAX) : '' } : { petReasons: undefined, petOther: undefined }),
      collar: form.pet === 'あり' && (form.petReasons || []).includes('首輪がある') ? 'あり' : '',   // 首輪は理由「首輪がある」だけで表す
      neuter: form.neuter || NEUTER_UNKNOWN, hairLen: form.hairLen || HAIR_UNKNOWN,
      color: colorOf(form), colorOther: undefined,   // 毛色の「その他」は「その他:〇〇」にして残す
      feature: $('#feature').value.trim(), photos, status: 'pending' }]);
  } catch (e) { done(); return toast(dbErrText(e), 8000); }   // 入れた内容は消さない(もう一度押せる)
  Object.keys(form).forEach(k => delete form[k]); photos = [];   // 入れ物は作り直さない(項目の部品が同じ入れ物を持っている)
  renderThumbs(); $('#feature').value = '';
  if (optionsDirty) buildForm(); else { document.querySelectorAll('#fields .opts button.sel').forEach(b => b.classList.remove('sel')); form.neuter = NEUTER_UNKNOWN; form.hairLen = HAIR_UNKNOWN; [['neuter', NEUTER_UNKNOWN], ['hairLen', HAIR_UNKNOWN]].forEach(([k, v]) => { const nb = document.querySelector(`#fields .opts[data-k=${k}] button[data-v="${v}"]`); if (nb) nb.classList.add('sel'); }); formCtl.sync(); }
  hideSiteAsk(); renderSiteCands();
  $('#dup').classList.add('hidden'); done();
  await updateBadge(); toast(configured() && loggedIn() && navigator.onLine ? '保存しました。送っています…' : '保存しました(未送信)'); window.scrollTo(0, 0); getGps(); // 次の猫のために位置を取り直す
  maybeReload();
  syncQuiet().then(() => { if (!(configured() && loggedIn() && navigator.onLine)) return; updateBadge(); });
}

async function updateBadge() {
  let n;
  try { n = (await allRecords()).reduce((t, r) => t + (r.status === 'pending' && !r.deleted ? 1 : 0) + opsOf(r).length, 0) + (await allSites()).reduce((t, x) => t + (x.status === 'pending' && !x.deleted ? 1 : 0) + (x.ops || []).length, 0); }
  catch { return; }   // 保存の入れ物が使えない時は数えない(上に案内が出ている)
  $('#pending').textContent = n ? `未送信 ${n}` : '';
  $('#btn-send').classList.toggle('hidden', scope === 'all' || !n);
  renderHomeCounts(n);
}
// ホームの数(2026-10-27 nav-a): これまでの登録(みんな・自分)・まだ送れていない記録。数え方は集計の「合計」と同じ(削除した記録と、いなくなった猫を除く)
// 2026-10-27 nav-b: 受け付けが whoami・list の返事に数を付ける(counts: {all, mine}。数だけ)。来るまでは、自分は端末の記録から数え、みんなは「—」
// 来たら受け付けの数に入れ替え、まだ送れていない新しい記録(受け付けにはまだ無い)の分を足して出す。送れたら1つずつ受け付けの数へ移す(送った後の list の返事で取り直す)
let homeSrv = null;   // 受け付けの数 {all, mine}。ログアウトで消す
const homeCountOf = rs => rs.filter(r => !r.deleted && !isGone(r)).length;
function takeHomeCounts(r) { const c = r && r.counts; if (c && Number.isFinite(c.all) && Number.isFinite(c.mine)) { homeSrv = { all: c.all, mine: c.mine }; updateBadge(); } }
async function renderHomeCounts(n) {
  try { const rs = await allRecords(), add = homeCountOf(rs.filter(r => r.status === 'pending')), mine = homeSrv ? homeSrv.mine + add : homeCountOf(rs);
    $opt('#home-today').textContent = mine; $opt('#home-all').textContent = homeSrv ? homeSrv.all + add : '—';
    $opt('#home-pending').textContent = n || 0; $opt('#home-pending-btn').classList.toggle('zero', !n); $opt('#home-pending-btn').setAttribute('aria-label', n ? `まだ送れていない記録 ${n}件を送る` : 'すべて送れています'); } catch { /* 数えられない時は触らない */ }
}
function renderActiveTab() {
  const t = document.querySelector('.tab.active'); if (!t) return;
  if (t.id === 'tab-home') updateBadge(); if (t.id === 'tab-list') renderList(); if (t.id === 'tab-map') renderMap(); if (t.id === 'tab-stats') renderStats(); if (t.id === 'tab-sites') renderSites(); if (t.id === 'tab-record') renderSiteCands(); if (t.id === 'tab-admin') renderAdmin();
}

// ---- 見る範囲(自分の記録 / 全員の記録)。「全員」は受け付けの入力者シートで役割「全体を見る」になっている人だけ ----
// 全員の記録は端末に保存しない(画面を開いている間だけ持つ)。ほかの人の記録は入力者 ID(番号)だけで出て、メール・名前は来ない。
// showDeleted: 管理者の「削除済みも見る」(全員の記録の一覧・えさ場の画面だけ。地図・集計には出さない)
let scope = 'mine', allView = null, showDeleted = false;
function renderScopeBar() {
  const bar = $('#scopebar'); if (!bar) return;
  const tab = document.querySelector('.tab.active'), show = !!(auth && auth.viewAll && loggedIn() && tab && ['tab-list', 'tab-map', 'tab-stats', 'tab-sites'].includes(tab.id));
  bar.classList.toggle('hidden', !show);
  bar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
  const del = $('#delbar'); if (del) { del.classList.toggle('hidden', !(show && scope === 'all' && auth.admin && ['tab-list', 'tab-sites'].includes(tab.id))); $('#showdel').checked = showDeleted; }
  renderRelogin();
}
async function setScope(sc, quiet) {
  if (sc === 'all') {
    if (!(auth && auth.viewAll)) return;
    if (!navigator.onLine) return toast('電波がありません。「全員の記録」は電波がある所で見られます', 4000);
    if (!quiet && idValid()) toast('全員の記録を取っています…', 2000);   // 確かめが要る時は、取りに行かずに案内の箱を出す
    const r = await api('list', { scope: 'all', ...(showDeleted && auth.admin ? { includeDeleted: true } : {}) });
    if (!r.ok) {
      if (r.error === 'not_allowed') { auth.viewAll = false; saveAuth(); }
      if (r.error === 'id_needed') reauth = 'all';   // その場に Google のボタンを出す(確かめが済んだら、そのまま全員の記録を出す)
      else toast(errText(r.error), 5000);
      scope = 'mine'; allView = null; renderScopeBar(); renderActiveTab(); return;
    }
    allView = { records: r.records || [], sites: r.sites || [] }; scope = 'all';
  } else { scope = 'mine'; allView = null; if (!quiet) reauth = null; }
  renderScopeBar(); if (!quiet) renderActiveTab();
}
// 全員の写しに、端末の自分の物を重ねる(送っていない物・直した物・消した物も今の形で出る。前は切り替えた時の写しだけで、後から保存した猫が集計に入らなかった)
const mergeMine = (remote, local) => { const ids = new Set(local.map(x => x.id)); return [...remote.filter(x => !(x.mine && ids.has(x.id))), ...local.map(x => ({ ...x, mine: true }))]; };
const viewAllRecords = async () => scope === 'all' && allView ? mergeMine(allView.records, await allRecords()) : allRecords();   // 削除した物も含む
const viewAllSites = async () => scope === 'all' && allView ? mergeMine(allView.sites, await allSites()) : allSites();
const viewRecords = async () => (await viewAllRecords()).filter(r => !r.deleted);   // 一覧・地図・集計は、削除した物を出さない
const viewSites = async () => (await viewAllSites()).filter(x => !x.deleted);
// 削除から30日の間か(元に戻せるか)。受け付けの日時(日本時間の 'yyyy-MM-dd HH:mm:ss')と、端末の日時(ISO)のどちらも読む
const tms = t => /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(String(t || '')) ? Date.parse(String(t).replace(' ', 'T') + '+09:00') : Date.parse(t);
const RESTORE_DAYS = 30, canRestore = x => !!x.deleted && Date.now() - tms(x.deletedAt) <= RESTORE_DAYS * 864e5;
const delMark = x => `<span class="mark del">削除済み${x.deletedAt ? '(' + esc(fmtShort(x.deletedAt)) + ')' : ''}</span>`;
async function recById(id) {
  if (scope === 'all' && allView) { const a = allView.records.find(x => x.id === id && !x.mine) || allView.records.find(x => x.id === id); if (a) { if (a.mine) { const l = await getRecord(id); if (l) return l; } return a; } }
  return getRecord(id);
}
const siteNameOf = (id, sm) => id ? ((sm.get(id) || {}).name || 'えさ場(見つかりません)') : '';
const whoText = r => r.recorderId ? `入力者 ID ${String(r.recorderId).slice(0, 6)}` : '';

// ---- 一覧 ----
let listFilter = 'all', listUrls = [];   // 2026-10-26 0002: 開いた時は「すべて」(未送信は上の件数の印と、切り替えで見る)
// 一覧(2026-10-27 見本): えさ場ごとにまとめる(押すと開く・えさ場なしは最後)+絞り込み(さくら耳 あり/なし・飼い猫の可能性・いなくなった。件数つき)
// 毛色の絞り込みは無い(管理者の指示)。「いなくなった」を選んだ時だけ、いなくなった猫が出る
let listChip = 'all', listOpen = new Set(), listOpenInit = false;
const LCHIPS = [['all', 'すべて', r => true], ['ear', 'さくら耳 あり', r => hasEar(r)], ['noear', 'さくら耳 なし', r => r.ear === 'なし'], ['pet', '飼い猫の可能性', r => effPet(r) === 'あり'], ['gone', 'いなくなった', r => isGone(r)]];
async function renderList() {
  listUrls.forEach(u => URL.revokeObjectURL(u)); listUrls = [];
  const all = scope === 'all';
  const sm = new Map((await viewAllSites()).map(x => [x.id, x])), every = await viewAllRecords();
  const live = every.filter(r => (all ? !r.deleted || (showDeleted && auth.admin) : !r.deleted));
  const present = live.filter(r => !isGone(r) || r.deleted);
  const count = c => c[0] === 'gone' ? live.filter(r => !r.deleted && isGone(r)).length : present.filter(c[2]).length;
  $opt('#lchips').innerHTML = LCHIPS.map(c => `<button type="button" class="lchip${c[0] === listChip ? ' on' : ''}" data-chip="${c[0]}" aria-pressed="${c[0] === listChip}">${c[1]}<b>${count(c)}</b></button>`).join('');
  const cur = LCHIPS.find(c => c[0] === listChip) || LCHIPS[0];
  const rs = (listChip === 'gone' ? live.filter(r => !r.deleted && isGone(r)) : present.filter(cur[2])).sort((a, b) => b.time.localeCompare(a.time));
  // 自分の記録の時だけ: 送れていない記録があれば「送る」(ホームの「送る」と同じ)・取り直し(v25 までの機能を残す)
  $('#listmine').classList.toggle('hidden', all); $opt('#listrefresh').classList.toggle('hidden', all);
  $('#btn-send').classList.toggle('hidden', all || !/\d/.test($('#pending').textContent));
  const gone = all ? [] : every.filter(canRestore).sort((a, b) => tms(b.deletedAt) - tms(a.deletedAt));   // 自分が削除した物(30日の間)
  const itemHtml = r => {
    let img = ''; if (r.photos && r.photos[0]) { const u = URL.createObjectURL(r.photos[0]); listUrls.push(u); img = `<img src="${u}" class="zoomable" data-zoom-id="${esc(r.id)}" alt="写真(押すと大きく見られます)">`; }
    else if (phNeeds(r)) img = rphHtml(r, 1).replace('class="rph"', `class="rph" data-rph-count="${Number(r.photoCount)}"`);   // 他の端末の記録: 見えたら受け付けから小さい版を取る(1800)
    const nPhoto = r.photos && r.photos.length ? ` 写真${r.photos.length}枚` : (r.photoCount ? ` 写真${r.photoCount}枚(受け付け側)` : '');
    const st = all ? `<span class="st remote">${r.mine ? '自分の記録' : esc(whoText(r))}</span>` : `<span class="st ${r.status === 'sent' && !opsOf(r).length ? 'sent' : ''}">${r.status !== 'sent' ? '未送信' : opsOf(r).length ? `送信済み(直し・変化 ${opsOf(r).length}件が送信待ち)` : '送信済み'}</span>${r.remote ? ' <span class="st remote">(受け付けから取り直した記録)</span>' : ''}`;
    return `<div class="item${r.deleted ? ' gone' : ''}${isGone(r) ? ' away' : ''}" data-id="${esc(r.id)}" role="button" tabindex="0">${img}<div><b>${esc(colorText(r))}</b>${r.hairLen && r.hairLen !== HAIR_UNKNOWN ? ' ' + esc(r.hairLen) : ''} さくら耳:${esc(r.ear)}${!hasEar(r) && effNeuter(r) === NEUTER_DONE ? ' <span class="mark neu">手術済み</span>' : ''} ${esc(r.sex)} ${esc(r.age)} ${r.deleted ? delMark(r) : ''}${isGone(r) ? `<span class="mark away">${esc(goneText(r))}</span>` : ''}${marksHtml(r)}${petText(r) ? `<br><span class="pet">${esc(petText(r))}</span>` : ''}<br>
    <span class="note">${fmt(r.time)}${r.area ? ' ' + esc(r.area) : ''}${nPhoto}</span><br>
    ${st} ${esc(r.feature || '')}${!all && !r.deleted ? `<br><button type="button" class="small chgbtn" data-change="${esc(r.id)}"><svg class="ic sm" aria-hidden="true"><use href="#i-change"/></svg>この猫の状態を変える</button>` : ''}</div></div>`; };
  if (!listOpenInit && rs.length) { listOpenInit = true; listOpen.add(rs[0].siteId || ''); }   // 初めて開いた時は、いちばん新しい猫のいるえさ場を開いておく(状態を変えるまでが2回で済む)
  const groups = new Map();   // えさ場の id → 猫(えさ場が消えた/見つからない物も、その名前の組に入れる)
  rs.forEach(r => { const k = r.siteId || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const keys = [...groups.keys()].sort((a, b) => a === '' ? 1 : b === '' ? -1 : siteNameOf(a, sm).localeCompare(siteNameOf(b, sm), 'ja'));
  const gHtml = k => { const list = groups.get(k), name = k ? siteNameOf(k, sm) : 'えさ場なし';
    return `<details class="sgroup${k ? '' : ' sgnone'}" data-gk="${esc(k)}"${listOpen.has(k) ? ' open' : ''}><summary>${k ? '<span class="siteicon sm" aria-hidden="true"></span>' : '<svg class="ic md" aria-hidden="true"><use href="#i-map"/></svg>'}<span class="sgname">${esc(name)}</span><span class="sgn">${list.length}頭</span><svg class="ic chev" aria-hidden="true"><use href="#i-chev"/></svg></summary><div class="sgbody">${list.map(itemHtml).join('')}</div></details>`; };
  $('#list').innerHTML = (rs.length ? keys.map(gHtml).join('') : `<p>${listChip === 'all' ? '記録はまだありません' : '当てはまる猫はいません'}</p>`)
    + (gone.length ? `<details class="card gonebox"><summary>削除したもの(${gone.length}件)</summary><p class="note">削除してから30日の間は、元に戻せます。</p>${gone.map(r => `<div class="item gone"><div><b>${esc(colorText(r))}</b> さくら耳:${esc(r.ear)} ${delMark(r)}<br><span class="note">${fmt(r.time)}</span><br><button type="button" class="small" data-restore="${esc(r.id)}">元に戻す</button></div></div>`).join('')}</details>` : '');
  phWatch($('#list'));
}

// ---- 地図 ----
let map, layer, meLayer, picking = false, pickTarget = 'cat', pickPin = null, pickCtx = null, mapAuto = false, mapFocus = null;
// 地図で場所を選ぶ(2026-10-26 2105): 地図を押すとピンが立つ(押し直すと動く・ピンは指で動かせる)→「ここで確定」で決まる。確定するまで元の画面に戻らない
function setPicking(on) {
  picking = on; document.body.classList.toggle('picking', on); $('#pickmsg').classList.toggle('hidden', !on); $('#pickbtns').classList.toggle('hidden', !on); $('#pickwhat').textContent = pickTarget === 'site' ? 'えさ場にする場所' : '猫がいた場所';
  if (pickPin) { pickPin.remove(); pickPin = null; }
  $('#btn-pickok').disabled = true; $('#pickstate').textContent = 'まだ選んでいません';
  if (!on) pickCtx = null;
}
// ctx = { from: 前の場所 {lat,lng}(あれば地図をそこへ寄せる), ok(lat, lng): 確定した時, cancel(): やめた時 }
function startPick(target, ctx) {
  pickTarget = target; if (ctx.from && isFinite(ctx.from.lat)) mapFocus = { lat: ctx.from.lat, lng: ctx.from.lng };
  showTab('map'); setPicking(true); pickCtx = ctx;
}
const pinIcon = () => L.divIcon({ className: 'pickpin-wrap', html: '<span class="pickpin"></span>', iconSize: [36, 48], iconAnchor: [18, 46] });
function placePin(ll) {
  if (pickPin) pickPin.setLatLng(ll);
  else pickPin = L.marker(ll, { icon: pinIcon(), draggable: true, autoPan: true, keyboard: false, zIndexOffset: 10000, title: '選んだ場所(指で動かせます)' }).addTo(map);
  $('#btn-pickok').disabled = false; $('#pickstate').textContent = 'ピンの場所でよければ「ここで確定」を押してください';
}
// 選んだ場所を小さな地図にピンで出す(入力の画面・えさ場の登録の画面)。動かせない地図
function miniMap(el, lat, lng) {
  if (!el || typeof L === 'undefined') return;
  if (el._mm) { el._mm.remove(); el._mm = null; }
  const m = el._mm = L.map(el, { zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, attributionControl: false }).setView([lat, lng], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
  L.marker([lat, lng], { icon: pinIcon(), interactive: false, keyboard: false }).addTo(m);
  setTimeout(() => { m.invalidateSize(); m.setView([lat, lng], 17, { animate: false }); }, 60);
}
const siteIcon = () => L.divIcon({ className: 'siteicon-wrap', html: '<span class="siteicon"></span>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
// 猫の印(丸)。まとめの部品で扱えるよう、丸い形の印(divIcon)にした(2026-10-26 2105)
const catColor = r => isGone(r) ? '#bbb' : hasEar(r) ? '#d6336c' : r.ear === 'なし' ? '#1971c2' : '#888';
const catIcon = r => { const g = isGone(r), s = g ? 16 : 22; return L.divIcon({ className: 'catdot' + (g ? ' awaydot' : ''), html: `<span style="background:${catColor(r)}"></span>`, iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2] }); };
// 近い所の印をまとめる丸(2026-10-26 2105): 数字 = その中の猫の数。えさ場が入っている時は、ひし形の印(2か所以上なら数も)を右上に添える
function clusterIcon(c) {
  const ms = c.getAllChildMarkers(), cats = ms.filter(m => m.options.kind === 'cat').length, sites = ms.length - cats, sz = cats >= 100 ? 50 : cats >= 10 ? 44 : 38;
  const label = `${cats ? `猫${cats}頭` : ''}${cats && sites ? '・' : ''}${sites ? `えさ場${sites}か所` : ''}。押すと広がります`;
  return L.divIcon({ className: 'clu-wrap', iconSize: [sz, sz], html: `<div class="clu${cats ? '' : ' onlysite'}" data-cats="${cats}" data-sites="${sites}" role="button" aria-label="${label}" title="${label}"><b>${cats || ''}</b>${sites ? `<span class="clu-site"><i class="siteicon"></i>${sites > 1 ? `<em>${sites}</em>` : ''}</span>` : ''}</div>` });
}
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { maxZoom: 19 }).setView([35.155, 136.93], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  // 同じ場所(いちばん拡大しても分かれない)の物は、丸を押すと周りに広がる(spiderfy)
  layer = (L.markerClusterGroup ? L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false, spiderfyOnMaxZoom: true, zoomToBoundsOnClick: true, spiderfyDistanceMultiplier: 1.6, iconCreateFunction: clusterIcon }) : L.layerGroup()).addTo(map);
  meLayer = L.layerGroup().addTo(map);
  $('#map').addEventListener('click', e => { const b = e.target.closest('button[data-open]'); if (b) openDetail(b.dataset.open); });
  map.on('click', e => { if (picking) placePin(e.latlng); });
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
  document.querySelectorAll('.showgone').forEach(c => { c.checked = showGone; });
  (await viewRecords()).filter(r => showGone || !isGone(r)).forEach(r => L.marker([r.lat, r.lng], { icon: catIcon(r), kind: 'cat', keyboard: false, title: `猫: ${colorText(r)}` })
    .bindPopup(`<b>${esc(colorText(r))}</b>${r.hairLen && r.hairLen !== HAIR_UNKNOWN ? ' ' + esc(r.hairLen) : ''}${isGone(r) ? `<br><b class="pmark">${esc(goneText(r))}</b>` : ''}<br>さくら耳: ${esc(r.ear)}<br>不妊手術: ${esc(effNeuter(r))}<br>${petText(r) ? esc(petText(r)) + '<br>' : ''}${r.siteId ? 'えさ場: ' + esc(siteNameOf(r.siteId, sm)) + '<br>' : ''}${r.area ? esc(r.area) + '<br>' : ''}${fmt(r.time)}<br>${scope === 'all' ? (r.mine ? '自分の記録' : esc(whoText(r))) : r.status === 'sent' ? '送信済み' : '未送信'}${marksText(r) ? `<br><b class="pmark">${esc(marksText(r))}</b>` : ''}<br><button type="button" class="small popen" data-open="${esc(r.id)}">詳しく見る${r.mine === false ? '' : '・直す'}</button>`).addTo(layer));
  liveSites(sites).forEach(x => L.marker([x.lat, x.lng], { icon: siteIcon(), kind: 'site', title: `えさ場: ${x.name}`, keyboard: false })
    .bindPopup(`<b>えさ場: ${esc(x.name)}</b>${x.memo ? '<br>' + esc(x.memo) : ''}<br>メッシュ ${esc(x.mesh500 || '')}${scope === 'all' && x.mine === false ? '<br>' + esc(whoText(x)) : ''}`).addTo(layer));
  setTimeout(() => map.invalidateSize(), 50);
}

// ---- 集計(自分の記録だけ。全員の記録に切り替えた時は全員分)----
function tally(rs, keyFn) {
  const by = new Map();
  rs.forEach(r => { const k = keyFn(r), a = by.get(k) || { n: 0, ear: 0, no: 0, unk: 0, done: 0, nunk: 0, pet: 0, gone: 0 }; if (isGone(r)) { a.gone++; by.set(k, a); return; } a.n++; if (hasEar(r)) a.ear++; else if (r.ear === 'なし') a.no++; if (r.ear === UNKNOWN_EAR) a.unk++; const nu = effNeuter(r); if (nu === NEUTER_DONE) a.done++; else if (nu === NEUTER_UNKNOWN) a.nunk++; if (effPet(r) === 'あり') a.pet++; by.set(k, a); });
  return by;
}
// 集計の表(2026-10-26 作り直し): 1行=1つのえさ場(または区画)・いちばん下に合計。見出しは「何が」を必ず入れる
const STAT_COLS = ['今いる猫(頭)', 'さくら耳あり(頭)', 'さくら耳なし(頭)', 'さくら耳 確認できず(頭)', 'さくら耳ありの割合', '手術済み(頭)', '手術済みの割合', '飼い猫の可能性あり(頭)', 'いなくなった(頭)'];   // 2026-10-26 1355: 手術済み・その割合を足した。2026-10-26 0002: 今いる猫で数え、いなくなった猫は右の列だけ
const NO_SITE_ROW = 'えさ場に結び付いていない猫';
// 区画の名前: 地域メッシュ(500m)の番号 523667052 → 「区画 5236-6705-2(約500m)」
const meshLabel = m => /^\d{9}$/.test(m) ? `区画 ${m.slice(0, 4)}-${m.slice(4, 8)}-${m.slice(8)}(約500m)` : m ? `区画 ${m}(約500m)` : '区画(位置不明)';
function statTable(title, head, rows) {
  const row = (name, a, cls = '') => { const judged = a.n - a.unk; return `<tr${cls ? ` class="${cls}"` : ''}><th scope="row" class="nm">${esc(name)}</th><td>${a.n}</td><td>${a.ear}</td><td>${a.no}</td><td>${a.unk}</td><td>${judged ? Math.round(a.ear / judged * 100) + '%' : '—'}</td><td>${a.done}</td><td>${a.n - a.nunk ? Math.round(a.done / (a.n - a.nunk) * 100) + '%' : '—'}</td><td>${a.pet}</td><td>${a.gone}</td></tr>`; };
  const tot = rows.reduce((t, [, a]) => ({ n: t.n + a.n, ear: t.ear + a.ear, no: t.no + a.no, unk: t.unk + a.unk, done: t.done + a.done, nunk: t.nunk + a.nunk, pet: t.pet + a.pet, gone: t.gone + a.gone }), { n: 0, ear: 0, no: 0, unk: 0, done: 0, nunk: 0, pet: 0, gone: 0 });
  return `<div class="card"><h3>${esc(title)}</h3>${rows.length ? `<div class="statwrap"><table class="stat"><thead><tr><th scope="col" class="nm">${esc(head)}</th>${STAT_COLS.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(([k, a]) => row(k, a)).join('')}${row('合計', tot, 'total')}</tbody></table></div>
    <p class="note">さくら耳ありの割合 = さくら耳ありの頭数 ÷(今いる猫 − さくら耳 確認できず)。確認できなかった猫は割合の計算に入れていません。手術済み = 不妊手術が「済み」の猫(さくら耳が右か左の猫と、耳の印が無くても手術済みと分かった猫)。手術済みの割合 = 手術済みの頭数 ÷(今いる猫 − 手術が「分からない」猫)。いなくなった猫は「いなくなった(頭)」の列だけに数えます。</p>` : '<p>まだ記録がありません</p>'}</div>`;
}
async function renderStats() {
  const rs = await viewRecords(), sites = await viewAllSites(), sm = new Map(sites.map(x => [x.id, x])), who = scope === 'all' ? '全員' : '自分';
  const bySite = [...tally(rs, r => r.siteId || '').entries()].map(([k, a]) => [k ? siteNameOf(k, sm) + (sm.get(k) && sm.get(k).retired ? '(使っていない)' : '') : NO_SITE_ROW, a]).sort((a, b) => (a[0] === NO_SITE_ROW) - (b[0] === NO_SITE_ROW) || a[0].localeCompare(b[0], 'ja'));
  const byMesh = [...tally(rs, meshOf).entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, a]) => [meshLabel(k), a]);
  const gr = new Map(); rs.filter(isGone).forEach(r => { const k = goneReasonText(r.goneReason) || '理由なし'; gr.set(k, (gr.get(k) || 0) + 1); });
  const goneNote = gr.size ? `<p class="note gonereasons">いなくなった理由の内訳: ${[...gr.entries()].map(([k, n]) => `${esc(k)} ${n}頭`).join('、')}</p>` : '';
  $('#stats').innerHTML = `<p class="statwhat">${who}の記録で数えた表です(削除した記録は除く・今の状態で数える・今いる猫で数え、いなくなった猫は別の列)。</p>` +
    statTable(`えさ場ごと(${who}の記録)`, 'えさ場', bySite) + statTable(`区画(約500m四方)ごと(${who}の記録)`, '区画', byMesh) + goneNote +
    `<div class="card"><p class="note">頭数は記録の数です。同じ猫を二度記録していることがあるため、猫の頭数と同じとは限りません。さくら耳は不妊手術が済んだ印です。「飼い猫の可能性あり」は、飼い猫かもしれないと入力された数(首輪がある猫を含む)で、頭数の推定から外したいときは引いて考えます。区画は、緯度経度から自動で付く約500m四方の区画(地域メッシュ)で、番号はその区画の番号です。表は横にすべらせて見られます。${scope === 'all' ? '' : '全体の集計は受け付け側のスプレッドシートで見ます。'}</p></div>`;
}

// ---- えさ場の画面 ----
async function renderSites() {
  const all = scope === 'all', every = await viewAllSites(), sites = every.filter(x => !x.deleted), rs = await viewRecords(), cnt = new Map();
  rs.forEach(r => { if (r.siteId) cnt.set(r.siteId, (cnt.get(r.siteId) || 0) + 1); });
  $('#sitehead').classList.toggle('hidden', all);
  const card = x => {
    const own = !all || x.mine !== false, pend = x.status === 'pending' ? '未送信' : (x.ops || []).length ? '送信待ちの直しあり' : '送信済み';
    return `<div class="card site" data-id="${esc(x.id)}"><b>${esc(x.name)}</b>${x.retired ? ' <span class="mark">使っていない</span>' : ''}${x.memo ? `<br><span class="note">${esc(x.memo)}</span>` : ''}
    <br><span class="note">この場所の記録 ${cnt.get(x.id) || 0}件・メッシュ ${esc(x.mesh500 || '')}${all && !own ? '・' + esc(whoText(x)) : ''}</span>${all ? '' : `<br><span class="st ${x.status === 'sent' && !(x.ops || []).length ? 'sent' : ''}">${pend}</span>`}
    <div class="row">${own && !all ? `<button type="button" class="small" data-act="rename">名前を直す</button><button type="button" class="small" data-act="${x.retired ? 'restore' : 'retire'}">${x.retired ? 'また使う' : '使わない'}</button><button type="button" class="small danger" data-act="del">削除</button>` : ''}<button type="button" class="small" data-act="map">地図で見る</button></div></div>`; };
  // 削除したえさ場: 自分の物(30日の間)。管理者が「削除済みも見る」にした時は、全員の物も出る
  const gone = every.filter(x => x.deleted && (all ? showDeleted && auth.admin : canRestore(x))).sort((a, b) => tms(b.deletedAt) - tms(a.deletedAt));
  const goneCard = x => `<div class="card site gone" data-id="${esc(x.id)}" data-owner="${esc(x.mine === false ? x.recorderId : '')}"><b>${esc(x.name)}</b> ${delMark(x)}${all && x.mine === false ? `<br><span class="note">${esc(whoText(x))}</span>` : ''}
    <div class="row">${canRestore(x) ? '<button type="button" class="small" data-act="undel">元に戻す</button>' : '<span class="note">30日を過ぎたので戻せません</span>'}</div></div>`;
  const live = liveSites(sites).sort((a, b) => a.name.localeCompare(b.name, 'ja')), off = sites.filter(x => x.retired).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  $('#sitelist').innerHTML = (live.length ? live.map(card).join('') : `<p>${all ? 'えさ場はまだありません' : 'えさ場はまだありません。上のボタンで登録できます'}</p>`) + (off.length ? `<h3>使っていないえさ場</h3>${off.map(card).join('')}` : '')
    + (gone.length ? `<details class="card gonebox"${all ? ' open' : ''}><summary>削除したえさ場(${gone.length}か所)</summary><p class="note">削除してから30日の間は、元に戻せます(猫の結び付きは戻りません。「間違いを直す」で付け直せます)。</p>${gone.map(goneCard).join('')}</details>` : '');
}
async function startSiteHere(after) {
  toast('今の位置を取っています…', 2500); const g = await getPos();
  if (!g) return toast('位置を取れませんでした。位置情報の許可を確かめるか、「地図で場所を指定して登録」を使ってください', 5000);
  openSiteForm({ ...g, src: 'GPS' }, after);
}
// えさ場を登録する画面。pos = {lat,lng,acc,src}。保存後に after(site) を呼ぶ(無ければ、えさ場の画面に戻る)
// keep = { name, memo }(地図で選び直した後に、書きかけの名前・メモを戻す)
function openSiteForm(pos, after, keep) {
  const picked = pos.src === '地図';
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>えさ場を登録</b></div>
  <div class="sheetbody"><div class="warn">猫がよく集まる餌場・たまり場を、自分用に登録します。出るのは自分の一覧と地図だけです(管理者が「全体を見る」役割にした人は全員分を見られます)。<br>名前は短く。人の名前や住所は書かないでください。</div>
  <div class="card"><p class="note" id="sf-loc">位置: ${pos.src === 'GPS' ? `GPSで取得(誤差 約${pos.acc}m)` : picked ? '地図で選んだ場所(下の地図のピンの所)' : esc(pos.src || '')}　メッシュ ${esc((meshCodes(pos.lat, pos.lng) || {}).mesh500 || '')}</p>
  ${picked ? '<div id="sf-mini" class="locmini"></div>' : ''}<button type="button" id="sf-repick" class="small">${picked ? '地図で選び直す' : '地図で場所を選ぶ'}</button>
  <label class="fl">名前<input id="sf-name" type="text" maxlength="${SITE_NAME_MAX}" placeholder="例: 公園の東の入口"></label>
  <label class="fl">メモ(任意)<input id="sf-memo" type="text" maxlength="${SITE_MEMO_MAX}" placeholder="例: 朝に餌をあげる人が来る"></label></div>
  <button type="button" id="sf-save" class="primary">このえさ場を登録する</button><button type="button" id="sf-cancel" class="wide">やめる</button></div>`);
  if (keep) { $('#sf-name').value = keep.name || ''; $('#sf-memo').value = keep.memo || ''; }
  if (picked) miniMap($('#sf-mini'), pos.lat, pos.lng);
  $('#s-back').onclick = $('#sf-cancel').onclick = () => closeSheet();
  // 地図で選び直す: 確定したら新しい場所で、やめたら前の場所のまま、この画面に戻る(書きかけの名前・メモはそのまま)
  $('#sf-repick').onclick = () => {
    const back = ($('.tab.active') || { id: 'tab-sites' }).id.slice(4), k = { name: $('#sf-name').value, memo: $('#sf-memo').value };
    closeSheet();
    startPick('site', { from: pos, ok: (lat, lng) => { showTab(back); openSiteForm({ lat, lng, acc: null, src: '地図' }, after, k); }, cancel: () => { showTab(back); openSiteForm(pos, after, k); } });
  };
  const siteId = newId('s');   // この画面で登録するえさ場の ID は1つだけ(何度押しても同じ ID。受け付けも同じ ID は1回だけ受ける)
  $('#sf-save').onclick = e => busy(e.currentTarget, async () => {
    if (sheetBusy) return;
    if (dbNotUsable()) return toast(DB_TEXT[dbState], 8000);
    const name = $('#sf-name').value.replace(/\s+/g, ' ').trim().slice(0, SITE_NAME_MAX), memo = $('#sf-memo').value.replace(/\s+/g, ' ').trim().slice(0, SITE_MEMO_MAX);
    if (!name) return toast('名前を入れてください');
    sheetBusy = true;
    const site = { id: siteId, name, memo, lat: pos.lat, lng: pos.lng, acc: pos.acc ?? null, recorderId: auth && auth.recorderId || null,
      createdAt: new Date().toISOString(), retired: false, status: 'pending', ops: [], ...(meshCodes(pos.lat, pos.lng) || {}) };
    try { await putSites([site]); } catch (err) { sheetBusy = false; return toast(dbErrText(err), 8000); }
    sheetBusy = false; await updateBadge();
    toast(configured() && loggedIn() && navigator.onLine ? 'えさ場を登録しました。送っています…' : 'えさ場を登録しました(未送信。電波が戻ったら送ります)');
    closeSheet(); if (after) await after(site);
    syncQuiet().then(() => updateBadge().then(renderActiveTab));
  }, '登録しています…');
}
async function openSiteEdit(id) {
  const x = await getSite(id); if (!x) return;
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>えさ場の名前を直す</b></div>
  <div class="sheetbody"><div class="card"><label class="fl">名前<input id="se-name" type="text" maxlength="${SITE_NAME_MAX}"></label><label class="fl">メモ(任意)<input id="se-memo" type="text" maxlength="${SITE_MEMO_MAX}"></label>
  <p class="note">場所は直せません。場所が違う時は、「使わない」にして、新しく登録してください。</p></div>
  <button type="button" id="se-save" class="primary">この内容に直す</button><button type="button" id="se-cancel" class="wide">やめる</button></div>`);
  $('#se-name').value = x.name; $('#se-memo').value = x.memo || '';
  $('#s-back').onclick = $('#se-cancel').onclick = () => closeSheet();
  $('#se-save').onclick = e => busy(e.currentTarget, async () => {
    const name = $('#se-name').value.replace(/\s+/g, ' ').trim().slice(0, SITE_NAME_MAX), memo = $('#se-memo').value.replace(/\s+/g, ' ').trim().slice(0, SITE_MEMO_MAX);
    if (!name) return toast('名前を入れてください');
    const f = {}; if (name !== x.name) f.name = name; if (memo !== (x.memo || '')) f.memo = memo;
    if (!Object.keys(f).length) return toast('直した所がありません');
    try {
      const cur = await getSite(id); Object.assign(cur, f);
      if (cur.status === 'sent') cur.ops = [...(cur.ops || []), { opId: newId('o'), type: 'siteEdit', fields: f, queuedAt: new Date().toISOString() }];   // 未送信の登録は、送る時に新しい名前で出る
      await putSites([cur]);
    } catch (err) { return toast(dbErrText(err), 8000); }
    await updateBadge(); toast(x.status === 'sent' ? '直しました。送っています…' : '直しました'); closeSheet(); syncQuiet().then(() => updateBadge().then(renderActiveTab));
  }, '直しています…');
}
async function setSiteRetired(id, retired) {
  const x = await getSite(id); if (!x) return;
  if (retired && !confirm('このえさ場を「使っていない」にします。記録は消えません(行も残ります)。よろしいですか?')) return;
  x.retired = retired; if (x.status === 'sent') x.ops = [...(x.ops || []), { opId: newId('o'), type: 'siteEdit', fields: { retired }, queuedAt: new Date().toISOString() }];
  try { await putSites([x]); } catch (err) { return toast(dbErrText(err), 8000); }
  await updateBadge(); toast(retired ? '「使っていない」にしました' : 'また使えるようにしました'); renderSites(); syncQuiet().then(() => updateBadge().then(renderActiveTab));
}
// ---- 詳しい画面・間違いを直す・状態が変わった ----
// 画面全体にかぶせる「シート」(#sheet)。閉じると一覧・地図を描き直す。
const LABELS = { color: '毛色・模様', hairLen: '毛の長さ', ear: 'さくら耳', neuter: '不妊手術', managed: '地域猫として世話', feeder: '餌をあげている人', age: '年齢のめやす', sex: '性別', body: '体の様子', tail: '尻尾', tame: '人への慣れ', siteId: 'えさ場' };
let sheetUrls = [], sheetBusy = false, sheetId = null;
const fmtShort = t => { const d = new Date(t); return isNaN(d) ? String(t || '') : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const mine = r => r.mine !== false && (!r.recorderId || !auth || !auth.recorderId || r.recorderId === auth.recorderId);   // 自分の記録か(分からない時は受け付けが確かめる)
function showSheet(html) { const el = $('#sheet'); sheetUrls.forEach(u => URL.revokeObjectURL(u)); sheetUrls = []; el.innerHTML = html; el.classList.remove('hidden'); el.scrollTop = 0; document.body.classList.add('noscroll'); }
function closeSheet() {
  const el = $('#sheet'); sheetId = null; el.classList.add('hidden'); el.innerHTML = ''; sheetUrls.forEach(u => URL.revokeObjectURL(u)); sheetUrls = []; document.body.classList.remove('noscroll');
  renderActiveTab(); if (optionsDirty && !formTouched()) buildForm();
  maybeReload();
}
// ---- 他の端末で記録した写真を、受け付けから取る(2026-10-26 1800・管理者 msg 6763)----
// 端末に写真が無い記録(別のスマホで記録した自分の記録・管理者の全員の記録)だけ。見てよいかは受け付けが毎回確かめる(ファイルIDは受け取らない)。
// 小さい版(長辺320px・一覧と記録の画面)は見えた分だけ、6枚ずつまとめて取る。大きい版(長辺1600px まで)は拡大した時だけ。
// 取った写真は別の入れ物(catSurveyPhotos)に置き、次からは通信なしで出す。上限(PH_MAX_BYTES・PH_MAX_ITEMS)を超えたら、使った時が古い物から消す。
const PH_DB = 'catSurveyPhotos', PH_STORE = 'photos', PH_SMALL = 320, PH_BATCH = 6, PH_MAX_BYTES = 40 * 1024 * 1024, PH_MAX_ITEMS = 600, PH_LARGE_WAIT_MS = 30000;
const PH_FAIL = '写真を読み込めません';
let phDbp = null;
function phDb() {
  if (!phDbp) {
    phDbp = new Promise((ok, ng) => {
      let q; try { q = indexedDB.open(PH_DB, 1); } catch (e) { return ng(e); }
      q.onupgradeneeded = () => { const st = q.result.createObjectStore(PH_STORE, { keyPath: 'k' }); st.createIndex('at', 'at'); };
      q.onsuccess = () => { const db = q.result; db.onversionchange = () => { db.close(); phDbp = null; }; ok(db); };
      q.onerror = () => ng(q.error || new Error('photo db')); q.onblocked = () => ng(new Error('photo db blocked'));
    });
    phDbp.catch(() => { phDbp = null; });
  }
  return phDbp;
}
const phTx = (mode, fn) => phDb().then(db => new Promise((ok, ng) => { const t = db.transaction(PH_STORE, mode), r = fn(t.objectStore(PH_STORE)); t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => ng(t.error); }));
const phMaxItems = () => { const n = Number(localStorage.getItem('catSurvey.phMaxItems')); return n > 0 ? n : PH_MAX_ITEMS; };   // 試し用に上限を小さくできる(ふだんは使わない)
// 誰の記録か: 全員の記録の中の他の人の物だけ ownerId を付ける(自分の物は付けない=受け付けがログインから決める)
const phRef = r => ({ id: String(r.id), owner: scope === 'all' && r.mine === false && r.recorderId ? String(r.recorderId) : '' });
const phKey = (ref, n, size) => [auth && auth.recorderId || '', ref.owner, ref.id, n, size].join('|');   // ログインした人ごとに分ける(同じ端末で別の人がログインしても、前の人の控えは出ない)
const phNeeds = r => !(r.photos && r.photos.length) && Number(r.photoCount) > 0 && r.status !== 'pending';
async function phGet(k) {
  try { const e = await phTx('readonly', st => st.get(k)); if (!e) return null; phTx('readwrite', st => st.put({ ...e, at: Date.now() })).catch(() => {}); return e.blob; } catch { return null; }
}
async function phPut(k, blob) {
  try {
    await phTx('readwrite', st => st.put({ k, blob, size: blob.size, at: Date.now() }));
    const all = (await phTx('readonly', st => st.getAll())) || [], max = phMaxItems();
    let total = all.reduce((a, e) => a + (e.size || 0), 0), n = all.length; const old = [];
    for (const e of all.sort((a, b) => a.at - b.at)) { if (total <= PH_MAX_BYTES && n <= max) break; if (e.k === k) continue; old.push(e.k); total -= e.size || 0; n--; }
    if (old.length) await phTx('readwrite', st => { old.forEach(x => st.delete(x)); });
  } catch { /* 置けなくても、今回は出せる */ }
}
const b64Blob = d => { const t = atob(d), a = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return new Blob([a], { type: 'image/jpeg' }); };
async function phShrink(blob, side) {   // 受け付けが縮小版を作れなかった時(元の写真が来た時)だけ、端末で縮める
  try {
    const bm = await createImageBitmap(blob); if (Math.max(bm.width, bm.height) <= side) return blob;
    const s = side / Math.max(bm.width, bm.height), c = document.createElement('canvas'); c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s);
    c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(b => ok(b || blob), 'image/jpeg', 0.8));
  } catch { return blob; }
}
const phItem = (ref, n) => ({ recordId: ref.id, n, ...(ref.owner ? { ownerId: ref.owner } : {}) });
const phWait = new Map(); let phTimer = null;
function phSmall(ref, n) {
  const k = phKey(ref, n, 's');
  return phGet(k).then(b => b || new Promise((ok, ng) => {
    if (!phWait.has(k)) phWait.set(k, { item: phItem(ref, n), cbs: [] });
    phWait.get(k).cbs.push({ ok, ng }); if (!phTimer) phTimer = setTimeout(phFlush, 50);
  }));
}
async function phFlush() {
  phTimer = null; const all = [...phWait.entries()]; phWait.clear();
  for (let i = 0; i < all.length; i += PH_BATCH) {
    const part = all.slice(i, i + PH_BATCH); let res;
    try { res = await api('photo', { items: part.map(([, v]) => v.item), size: 'small' }); } catch { res = { ok: false, error: 'network' }; }
    await Promise.all(part.map(async ([k, v], j) => {
      const it = res && res.ok && Array.isArray(res.items) ? res.items[j] : null;
      if (!it || !it.ok || !it.data) return v.cbs.forEach(c => c.ng(new Error(it ? it.error : res && res.error || 'bad_response')));
      const b = it.scaled ? b64Blob(it.data) : await phShrink(b64Blob(it.data), PH_SMALL);
      await phPut(k, b); v.cbs.forEach(c => c.ok(b));
    }));
  }
}
async function phLarge(ref, n) {
  const k = phKey(ref, n, 'l'), hit = await phGet(k); if (hit) return hit;
  const res = await api('photo', { items: [phItem(ref, n)], size: 'large' }, PH_LARGE_WAIT_MS), it = res && res.ok && Array.isArray(res.items) ? res.items[0] : null;
  if (!it || !it.ok || !it.data) throw new Error(it ? it.error : res && res.error || 'bad_response');
  const b = b64Blob(it.data); await phPut(k, b); return b;
}
// 受け付けの写真の小さな絵の置き場(<span class="rph" data-rph-id data-rph-owner data-rph-n>)を埋める。見えた物だけ取る
let phObs = null;
function phFill(el) {
  const ref = { id: el.dataset.rphId, owner: el.dataset.rphOwner || '' }, n = Number(el.dataset.rphN) || 1;
  el.classList.remove('err', 'idwait'); el.classList.add('loading'); el.innerHTML = '<span class="rphmsg">写真を読み込み中…</span>';
  phSmall(ref, n).then(b => {
    const u = URL.createObjectURL(b); (el.closest('#sheet') ? sheetUrls : listUrls).push(u);
    el.classList.remove('loading'); el.innerHTML = `<img src="${u}" class="zoomable" data-rph-zoom="${n}" alt="写真${n}(押すと大きく見られます)" role="button" tabindex="0">`;
  }).catch(err => {
    el.classList.remove('loading'); el.classList.add('err');
    if (err && err.message === 'id_needed') { el.classList.add('idwait'); el.innerHTML = '<span class="rphmsg">Google で確かめると出ます</span><button type="button" class="small rphretry" data-rph-relogin="1">確かめる</button>'; return phNeedId(el); }
    el.innerHTML = `<span class="rphmsg">${PH_FAIL}</span><button type="button" class="small rphretry" data-rph-retry="1">再読み込み</button>`;
  });
}
// ---- 写真を開く時の「Google でもう一度確かめる」(20261028-0140。全員の記録の他の人の写真・管理の不具合の知らせの写し)----
// ID トークンが切れていた時だけ、その場に案内と Google のボタンを出す(v32 の全員の記録・管理と同じ形)。確かめが済んだら(reconfirm)、待っていた写真をそのまま出す。
// 電波が無い・写真が無い等は、今まで通り「読み込めません」と再読み込み。photoWaits: 確かめが済んだら続けること(不具合の知らせの写し)
const photoWaits = new Set();
const photoReloginHtml = what => `<div class="card relogin relogin-photo" role="status"><p><b>${what}を見るには、Google でもう一度確かめます。</b></p><p class="note">下の Google のボタンを押して、いつもの Google アカウントを選んでください。確かめが済むと、そのまま${what}が出ます(ログアウトはしません。この端末の記録も消えません)。</p><div class="gsi-spot"></div><button type="button" class="small regsi hidden">Google のボタンを出し直す</button><p class="note gsi-msg"></p></div>`;
// 小さな絵(一覧・記録を見る画面)が確かめ待ちになった: 記録を見る画面なら写真のすぐ上、一覧なら一覧のいちばん上に、案内を1つだけ出す
function phNeedId(el) {
  const root = el.closest('#sheet') || el.closest('#list'); if (!root) return;
  if (!root.querySelector('.relogin-photo')) { const th = el.closest('.rthumbs'); if (th) th.insertAdjacentHTML('beforebegin', photoReloginHtml('この記録の写真')); else root.insertAdjacentHTML('afterbegin', photoReloginHtml('他の人の写真')); }
  gsiSpot(root.querySelector('.relogin-photo'));
}
function photoResume() {
  document.querySelectorAll('#sheet .relogin-photo, #list .relogin-photo').forEach(c => c.remove());
  document.querySelectorAll('.rph.idwait').forEach(phFill);
  if (viewer && viewer.idwait) { viewer.idwait = false; viewerShow(); }
  const w = [...photoWaits]; photoWaits.clear(); w.forEach(f => { try { f(); } catch { /* 画面が閉じた */ } });
}
function phWatch(root) {
  const els = [...root.querySelectorAll('.rph[data-rph-id]:not(.watched)')]; if (!els.length) return;
  if (typeof IntersectionObserver !== 'function') return els.forEach(el => { el.classList.add('watched'); phFill(el); });
  if (!phObs) phObs = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { phObs.unobserve(e.target); phFill(e.target); } }), { rootMargin: '200px 0px' });
  els.forEach(el => { el.classList.add('watched'); phObs.observe(el); });
}
const rphHtml = (r, n) => { const ref = phRef(r); return `<span class="rph" data-rph-id="${esc(ref.id)}" data-rph-owner="${esc(ref.owner)}" data-rph-n="${n}"><span class="rphmsg">写真</span></span>`; };
// 受け付けの写真を拡大で見る(押した写真から。前後の写真も、送った時に読み込む)
function openRemoteViewer(ref, count, start) { openViewer(Array.from({ length: count }, (_, i) => () => phLarge(ref, i + 1)), start); }
// 小さな絵の「再読み込み」・押して拡大(一覧・記録を見る画面の共通)。押した物を扱ったら true
function phClick(e) {
  const rb = e.target.closest('[data-rph-retry]'); if (rb) { e.stopPropagation(); phFill(rb.closest('.rph')); return true; }
  const rl = e.target.closest('[data-rph-relogin]'); if (rl) { e.stopPropagation(); const c = (rl.closest('#sheet') || rl.closest('#list') || document).querySelector('.relogin-photo'); if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }   // 案内の Google のボタンの所へ
  const zi = e.target.closest('img[data-rph-zoom]'); if (!zi) return false;
  const box = zi.closest('.rph'), ref = { id: box.dataset.rphId, owner: box.dataset.rphOwner || '' }, cnt = Number(box.dataset.rphCount) || Number((zi.closest('[data-rph-total]') || {}).dataset?.rphTotal) || 1;
  e.stopPropagation(); openRemoteViewer(ref, cnt, Number(zi.dataset.rphZoom) - 1); return true;
}

// ---- 写真を大きく見る(2026-10-26 1355・管理者 msg 6754)----
// 端末の中にある写真(撮った時に長辺1600pxに縮めて位置情報を消した物)は、そのまま出す(通信は使わない)。
// 端末に無い写真(他の端末で記録した物)は、受け付けから大きい版を取って出す(1800。上の phLarge・取った物は端末に控える)。
// 2本指で広げる・ダブルタップで拡大/元に戻す・広げている時は1本指で動かす・広げていない時は左右にすべらせて次/前の写真。
// ×・背景を押す・戻るボタン(端末の)・Esc で閉じる。←→ キーでも送れる
let viewer = null;
function openViewer(blobs, start) {
  const list = (blobs || []).filter(Boolean); if (!list.length) return;
  if (viewer) closeViewer(true);
  const el = $('#viewer'), urls = list.map(b => typeof b === 'function' ? null : URL.createObjectURL(b));
  viewer = { el, urls, src: list, i: Math.max(0, Math.min(start || 0, list.length - 1)), s: 1, x: 0, y: 0, pts: new Map(), g: null, lastTap: 0 };
  el.innerHTML = `<div class="vwbar"><span class="vwcount" aria-live="polite"></span><button type="button" class="vwclose" aria-label="閉じる">✕</button></div>
    <div class="vwstage"><img class="vwimg" alt=""><div class="vwload">読み込み中…</div></div>
    ${list.length > 1 ? '<button type="button" class="vwnav vwprev" aria-label="前の写真">‹</button><button type="button" class="vwnav vwnext" aria-label="次の写真">›</button>' : ''}
    <p class="vwhint">2本指で広げる・ダブルタップで拡大${list.length > 1 ? '・左右にすべらせて次の写真' : ''}・✕ か まわりを押すと閉じます</p>`;
  el.classList.remove('hidden'); document.body.classList.add('noscroll');
  try { history.pushState({ viewer: 1 }, ''); viewer.pushed = true; } catch { /* 戻るボタンで閉じられないだけ */ }
  el.querySelector('.vwclose').onclick = () => closeViewer();
  if (list.length > 1) { el.querySelector('.vwprev').onclick = () => viewerGo(-1); el.querySelector('.vwnext').onclick = () => viewerGo(1); }
  const stage = el.querySelector('.vwstage');
  stage.onpointerdown = viewerDown; stage.onpointermove = viewerMove; stage.onpointerup = stage.onpointercancel = viewerUp;
  viewerShow();
  el.querySelector('.vwclose').focus();
}
function viewerShow() {
  const v = viewer, img = v.el.querySelector('.vwimg'), load = v.el.querySelector('.vwload');
  v.s = 1; v.x = 0; v.y = 0; viewerApply();
  load.classList.remove('hidden'); load.textContent = '読み込み中…'; img.classList.add('loading');
  img.onload = () => { load.classList.add('hidden'); img.classList.remove('loading'); };
  img.onerror = () => { load.textContent = 'この写真は開けませんでした'; };
  img.alt = `写真${v.i + 1}`;
  if (v.urls[v.i]) img.src = v.urls[v.i];
  else {   // 受け付けから取る(1800)。取っている間に別の写真へ移ったら、出さない
    const i = v.i; img.removeAttribute('src'); load.textContent = '読み込み中…';
    v.src[i]().then(b => { if (viewer !== v) return; v.urls[i] = URL.createObjectURL(b); if (v.i === i) img.src = v.urls[i]; })
      .catch(err => { if (viewer !== v || v.i !== i) return;
        if (err && err.message === 'id_needed') { v.idwait = true; load.innerHTML = photoReloginHtml('この写真'); const c = load.firstElementChild; c.onpointerdown = c.onpointerup = c.onpointermove = e => e.stopPropagation(); return gsiSpot(c); }   // 20261028-0140: 押しても「まわりを押した」(閉じる)にしない
        load.innerHTML = `${PH_FAIL}<br><button type="button" class="small vwretry">再読み込み</button>`; const rb = load.querySelector('.vwretry'); rb.onpointerdown = rb.onpointerup = rb.onpointermove = e => e.stopPropagation(); rb.onclick = e => { e.stopPropagation(); viewerShow(); }; });   // 押しても「まわりを押した」(閉じる)にしない
  }
  v.el.querySelector('.vwcount').textContent = v.urls.length > 1 ? `${v.i + 1} / ${v.urls.length}` : '';
  if (v.urls.length > 1) { v.el.querySelector('.vwprev').disabled = v.i === 0; v.el.querySelector('.vwnext').disabled = v.i === v.urls.length - 1; }
}
function viewerGo(d) { const v = viewer; if (!v) return; const n = v.i + d; if (n < 0 || n >= v.urls.length) return; v.i = n; viewerShow(); }
function viewerApply() { const v = viewer, img = v.el.querySelector('.vwimg'); img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`; v.el.classList.toggle('zoomed', v.s > 1.01); }
function viewerZoomAt(s, cx, cy) {   // 画面の (cx, cy) の所を動かさずに、倍率を s にする
  const v = viewer, r = v.el.querySelector('.vwstage').getBoundingClientRect(), ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
  s = Math.max(1, Math.min(5, s)); v.x = ox - (ox - v.x) * s / v.s; v.y = oy - (oy - v.y) * s / v.s; v.s = s;
  if (s <= 1.01) { v.s = 1; v.x = 0; v.y = 0; }
  viewerApply();
}
function viewerDown(e) {
  const v = viewer; if (!v) return; e.preventDefault();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 無くても動く */ }
  v.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const p = [...v.pts.values()];
  if (p.length === 2) v.g = { kind: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, s: v.s, moved: true };
  else if (p.length === 1) v.g = { kind: 'one', sx: e.clientX, sy: e.clientY, x: v.x, y: v.y, moved: false, onImg: e.target.classList.contains('vwimg') };
}
function viewerMove(e) {
  const v = viewer; if (!v || !v.pts.has(e.pointerId)) return;
  v.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const p = [...v.pts.values()], g = v.g; if (!g) return;
  if (g.kind === 'pinch' && p.length >= 2) { const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); viewerZoomAt(g.s * d / g.d, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2); return; }
  if (g.kind !== 'one') return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy; if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;
  if (v.s > 1) { v.x = g.x + dx; v.y = g.y + dy; viewerApply(); }   // 広げている時は動かす
  else if (v.urls.length > 1) { v.x = dx; viewerApply(); }        // 広げていない時は、すべらせている分だけずらして見せる
}
function viewerUp(e) {
  const v = viewer; if (!v) return;
  const g = v.g; v.pts.delete(e.pointerId);
  if (v.pts.size) { if (g && g.kind === 'pinch') v.g = { kind: 'none' }; return; }   // 2本指の片方を離した: 残りの指では何もしない
  v.g = null; if (!g || g.kind !== 'one') return;
  const dx = e.clientX - g.sx;
  if (v.s <= 1 && g.moved) { if (dx < -50 && v.i < v.urls.length - 1) return viewerGo(1); if (dx > 50 && v.i > 0) return viewerGo(-1); v.x = 0; viewerApply(); return; }
  if (g.moved) return;
  const now = Date.now();
  if (g.onImg && now - v.lastTap < 320) { v.lastTap = 0; viewerZoomAt(v.s > 1 ? 1 : 2.5, e.clientX, e.clientY); return; }   // ダブルタップ
  v.lastTap = now;
  if (!g.onImg && v.s <= 1) closeViewer();   // 写真のまわり(背景)を押した
}
function closeViewer(quiet) {
  const v = viewer; if (!v) return; viewer = null;
  v.el.classList.add('hidden'); v.el.innerHTML = ''; v.urls.forEach(u => u && URL.revokeObjectURL(u));
  if ($('#sheet').classList.contains('hidden')) document.body.classList.remove('noscroll');
  if (v.pushed && !quiet && history.state && history.state.viewer) { v.skipPop = true; history.back(); }
}
addEventListener('popstate', () => { if (viewer) { viewer.pushed = false; closeViewer(true); } });   // 端末の「戻る」で閉じる(画面は移らない)
addEventListener('keydown', e => { if (!viewer) return; if (e.key === 'Escape') closeViewer(); else if (e.key === 'ArrowRight') viewerGo(1); else if (e.key === 'ArrowLeft') viewerGo(-1); });

const rowLine = (label, v) => v ? `<div class="line2"><span class="lbl">${esc(label)}</span><span>${esc(v)}</span></div>` : '';

async function openDetail(id) {
  const r = await recById(id); if (!r) return; sheetId = id;
  const sm = new Map((await viewSites()).map(x => [x.id, x])), all = scope === 'all';
  let img = ''; if (r.photos && r.photos[0]) {   // 2026-10-26 1355: 押すと大きく見られる(2枚目からは小さな絵を並べる)
    const us = r.photos.map(p => { const u = URL.createObjectURL(p); sheetUrls.push(u); return u; });
    img = `<img class="dphoto zoomable" src="${us[0]}" data-zoom="0" alt="写真1(押すと大きく見られます)" role="button" tabindex="0">` + (us.length > 1 ? `<div class="dthumbs">${us.map((u, i) => `<img src="${u}" class="zoomable" data-zoom="${i}" alt="写真${i + 1}(押すと大きく見られます)" role="button" tabindex="0">`).join('')}</div>` : '') + '<p class="note">写真を押すと、大きく見られます。</p>';
  } else if (phNeeds(r)) {   // 他の端末で記録した写真: 受け付けから取る(1800)
    const cnt = Number(r.photoCount);
    img = `<div class="dthumbs rthumbs" data-rph-total="${cnt}">${Array.from({ length: cnt }, (_, i) => rphHtml(r, i + 1)).join('')}</div><p class="note">この記録の写真は、受け付けから読み込みます(通信を使います。一度見た写真は、次から通信なしで出ます)。押すと、大きく見られます。</p>`;
  }
  const ops = opsOf(r), pendingChanges = ops.filter(o => o.type === 'change'), pendingEdits = ops.filter(o => o.type === 'edit').length;
  const chItems = (items, wait) => items.map(i => `<div class="chg-line">${esc(i.label)}: ${esc(i.from || '(未入力)')} → <b>${esc(i.to || '(なし)')}</b>${wait ? ' <span class="st">(送信待ち)</span>' : ''}</div>`).join('');
  const hist = [...(r.changes || []).map(e => `<div class="chg"><div class="note">${fmtShort(e.time)}</div>${chItems(e.items, false)}</div>`),
    ...pendingChanges.map(o => `<div class="chg"><div class="note">${fmtShort(o.time)}</div>${Object.entries(o.changes).map(([k, v]) => `<div class="chg-line">${esc(k === 'pet' ? '飼い猫の可能性' : k === 'neuter' ? '不妊手術' : k === 'hairLen' ? '毛の長さ' : k === 'gone' ? 'いる/いない' : LABELS[k] || k)} → <b>${esc(k === 'siteId' ? (siteNameOf(v, sm) || '(なし)') : k === 'gone' ? (v === 'いる' ? 'いる(また見かけた)' : goneText({ goneAt: o.goneDate, goneReason: o.goneReason === 'その他' && o.goneOther ? 'その他:' + o.goneOther : o.goneReason })) : v)}</b> <span class="st">(送信待ち)</span></div>`).join('')}</div>`)];
  const own = mine(r), unsent = r.status !== 'sent', admin = !!(auth && auth.admin && !isCard());
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>記録の詳しい内容</b></div>
  <div class="sheetbody">
  <div class="card">${img}<h3>${esc(colorText(r))}　さくら耳: ${esc(r.ear)} ${marksHtml(r)}</h3>
    ${isGone(r) ? `<p class="warn away">${esc(goneText(r))}。一覧と地図は、ふだん出しません(「いなくなった猫も見る」で出ます)。</p>` : ''}
    ${rowLine('毛の長さ', effHair(r))}${rowLine('記録した日時', fmt(r.time))}${all && !own ? rowLine('入力した人', whoText(r)) : ''}${rowLine('えさ場', siteNameOf(r.siteId, sm))}${rowLine('地域メッシュ', meshOf(r))}${rowLine('区域', r.area)}${rowLine('世話', r.managed)}${rowLine('餌をあげる人', r.feeder)}${rowLine('年齢', r.age)}${rowLine('性別', r.sex)}${rowLine('体の様子', r.body)}${rowLine('尻尾', r.tail)}${rowLine('人への慣れ', r.tame)}${rowLine('不妊手術', neuterText(r))}${rowLine('飼い猫の可能性', petText(r).replace('飼い猫の可能性: ', ''))}${rowLine('特徴', r.feature)}
    ${rowLine('写真', r.photos && r.photos.length ? r.photos.length + '枚' : r.photoCount ? r.photoCount + '枚(受け付け側)' : '')}
    ${all && !own ? '' : `<div class="line2"><span class="lbl">送信</span><span class="st ${unsent ? '' : 'sent'}">${unsent ? '未送信' : '送信済み'}</span></div>`}</div>
  <div class="card"><h3>これまでの変化(${hist.length}回)</h3>${hist.length ? hist.join('') : '<p class="note">状態の変化はまだ記録されていません。</p>'}
    ${editMarks(r) ? `<p class="note">この記録は、入力のまちがいを${editMarks(r)}回直しています${r.editedAt ? '(最後に直した日時: ' + esc(fmtShort(r.editedAt)) + ')' : ''}${pendingEdits ? `。うち${pendingEdits}回は送信待ちです` : ''}。</p>` : ''}</div>
  ${r.deleted ? `<div class="warn">この記録は削除されています(${esc(fmtShort(r.deletedAt))})。一覧・地図・集計には出ません。${canRestore(r) ? '' : '削除してから30日を過ぎたので、元に戻せません。'}</div>
  ${canRestore(r) && (own || admin) ? '<button type="button" id="s-undel" class="act">元に戻す<small>一覧・地図・集計にまた出します</small></button>' : ''}`
  : own ? `<button type="button" id="s-edit" class="act">間違いを直す<small>入力をまちがえた時。この記録をそのまま書き換えます</small></button>
  <button type="button" id="s-change" class="act orange"${unsent ? ' disabled' : ''}>状態が変わった<small>未手術→手術済み・さくら耳が付いた・えさ場が変わった・いなくなった・また見かけた など。履歴に足していきます</small></button>
  ${unsent ? '<p class="note">まだ送っていない記録です。「状態が変わった」は、送ってから使えます(間違いは今すぐ直せます)。</p>' : ''}
  <button type="button" id="s-del" class="wide danger">この記録を削除する</button><p class="note">削除しても、受け付けのシートの行は残ります(「削除済み」の印が付きます)。30日の間は元に戻せます。</p>`
    : '<p class="warn">この記録は別の人の物なので、直せません。</p>'}
  </div>`);
  $('#s-back').onclick = closeSheet;
  $('#sheet').querySelectorAll('img[data-zoom]').forEach(im => { im.onclick = () => openViewer(r.photos, +im.dataset.zoom); im.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); im.click(); } }; });
  const rt = $('#sheet').querySelector('.rthumbs'); if (rt) { rt.onclick = phClick; rt.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('img[data-rph-zoom]')) { e.preventDefault(); e.target.click(); } }; phWatch(rt); }
  if (own && !r.deleted) { $('#s-edit').onclick = () => openEdit(id); $('#s-change').onclick = () => openChange(id); $('#s-del').onclick = e => busy(e.currentTarget, () => deleteRecord(id), '削除しています…'); }
  if ($('#s-undel')) $('#s-undel').onclick = e => busy(e.currentTarget, () => restoreRecord(id, own ? '' : r.recorderId), '戻しています…');
}

// ---- 削除・元に戻す(2026-10-25 2332)。自分の物だけ消せる。消した物は一覧・地図・集計に出さない。30日の間は本人と管理者が元に戻せる ----
// 送った物は、受け付けへ「削除」「元に戻す」を貯めて送る(電波が無くても貯まる)。まだ送っていない物は、端末の中だけで印を付ける(送らない)
const pushOp = (x, op) => { const ops = opsOf(x), last = ops[ops.length - 1], undo = { delete: 'restore', restore: 'delete', siteDelete: 'siteRestore', siteRestore: 'siteDelete' };
  return last && undo[last.type] === op.type ? ops.slice(0, -1) : [...ops, op]; };   // まだ送っていない「削除」を戻した時は、貯めた「削除」を取り下げるだけ
async function deleteRecord(id) {
  const r = await getRecord(id); if (!r || r.deleted) return;
  if (!confirm('本当に消しますか?\nこの猫の記録を、一覧・地図・集計から外します(受け付けのシートの行は残ります)。30日の間は、一覧の下の「削除したもの」から元に戻せます。')) return;
  const now = new Date().toISOString(), nr = { ...r, deleted: true, deletedAt: now };
  if (r.status === 'sent') nr.ops = pushOp(r, { type: 'delete', opId: newId('o'), queuedAt: now });
  try { await putAll([nr]); } catch (e) { return toast(dbErrText(e), 8000); }
  closeSheet(); await updateBadge(); toast('削除しました。30日の間は、一覧の下の「削除したもの」から元に戻せます', 6000);
  syncQuiet().then(() => updateBadge());
}
// ownerId: 管理者が他人の物を戻す時(全員の記録の「削除済みも見る」)。その時は端末に無いので、受け付けへすぐ送る(電波が要る)
async function restoreRecord(id, ownerId) {
  if (ownerId) {
    const res = await api('restore', { recordId: id, ownerId }); if (!res.ok) return toast(errText(res.error), 6000);
    toast('元に戻しました'); closeSheet(); await setScope('all', true); return renderActiveTab();
  }
  const r = await getRecord(id); if (!r || !r.deleted) return;
  if (!canRestore(r)) return toast(errText('restore_expired'), 6000);
  const nr = { ...r, deleted: false, deletedAt: '' };
  if (r.status === 'sent') nr.ops = pushOp(r, { type: 'restore', opId: newId('o'), queuedAt: new Date().toISOString() });
  try { await putAll([nr]); } catch (e) { return toast(dbErrText(e), 8000); }
  closeSheet(); await updateBadge(); toast('元に戻しました'); syncQuiet().then(() => updateBadge());
}
// えさ場の削除: 結び付いた猫は「えさ場なし」にする(猫の記録は消さない。受け付けも同じことをして、変化シートに付け替えの1行を残す)
async function deleteSite(id) {
  const x = await getSite(id); if (!x || x.deleted) return;
  const linked = (await allRecords()).filter(r => r.siteId === id), n = linked.filter(r => !r.deleted).length;
  if (!confirm(`本当に消しますか?\nえさ場「${x.name}」を削除します。${n ? `結び付いている猫 ${n} 頭は「えさ場なし」になります(猫の記録は消えません)。` : ''}30日の間は「削除したえさ場」から元に戻せます(猫の結び付きは戻りません)。`)) return;
  const now = new Date().toISOString(); x.deleted = true; x.deletedAt = now;
  if (x.status === 'sent') x.ops = pushOp(x, { type: 'siteDelete', opId: newId('o'), queuedAt: now });
  try { await putSites([x]); if (linked.length) await putAll(linked.map(r => ({ ...r, siteId: '' }))); } catch (e) { return toast(dbErrText(e), 8000); }
  await updateBadge(); toast(`えさ場を削除しました${n ? `(猫 ${n} 頭は「えさ場なし」になりました)` : ''}。30日の間は元に戻せます`, 6000); renderSites();
  syncQuiet().then(() => updateBadge().then(renderActiveTab));
}
async function restoreSite(id, ownerId) {
  if (ownerId) {
    const res = await api('siteRestore', { siteId: id, ownerId }); if (!res.ok) return toast(errText(res.error), 6000);
    toast('元に戻しました'); await setScope('all', true); return renderActiveTab();
  }
  const x = await getSite(id); if (!x || !x.deleted) return;
  if (!canRestore(x)) return toast(errText('restore_expired'), 6000);
  x.deleted = false; x.deletedAt = '';
  if (x.status === 'sent') x.ops = pushOp(x, { type: 'siteRestore', opId: newId('o'), queuedAt: new Date().toISOString() });
  try { await putSites([x]); } catch (e) { return toast(dbErrText(e), 8000); }
  await updateBadge(); toast('えさ場を元に戻しました(猫の結び付きは戻りません)', 5000); renderSites(); syncQuiet().then(() => updateBadge().then(renderActiveTab));
}

async function openEdit(id) {
  const r = await getRecord(id); if (!r) return;
  const st = {}; EDIT_FIELD_KEYS.forEach(k => { if (r[k]) st[k] = r[k]; });
  delete st.color; splitColor(r.color, st); st.hairLen = effHair(r);   // 「その他:〇〇」は「その他」と欄の文字に分けて出す・毛の長さが空の前の記録は「分からない」
  st.petReasons = [...(r.petReasons || [])]; st.petOther = r.petOther || ''; st.siteId = r.siteId || '';
  st.neuter = effNeuter(r);   // 空の古い記録は、今の数え方の値を選んだ形で出す(変えなければ送らない)
  const sites = await allSites(), here = siteCands(sites, r), curSite = sites.find(x => x.id === r.siteId);
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>間違いを直す</b></div>
  <div class="sheetbody"><div class="warn">入力をまちがえた所だけ直してください。この記録がそのまま書き換わり、シートに「直した日時」が残ります。<br>写真と場所は、ここでは直せません。猫の状態が変わったときは、「状態が変わった」を使ってください。</div>
  <div class="card"><h3>えさ場</h3><p class="hint">この猫が来ているえさ場(自分のえさ場だけ。この記録の場所から近い順。100mより遠いえさ場も下の「そのほかの自分のえさ場」から選べます)</p><select id="e-site" class="sitesel" aria-label="えさ場"></select></div>
  <div id="e-fields"></div>
  <div class="card"><h3>目立つ特徴(任意)</h3><textarea id="e-feature" rows="2"></textarea></div>
  <button type="button" id="e-save" class="primary">この内容に直す</button>
  <button type="button" id="e-cancel" class="wide">やめる</button></div>`);
  const eSel = $('#e-site'); eSel.innerHTML = siteOptions(here, { none: 'えさ場なし(外す)', head: curSite && curSite.retired && !curSite.deleted ? [{ ...curSite, d: Math.round(distM(r, curSite)) }] : [] });
  eSel.value = st.siteId; if (eSel.value !== st.siteId) eSel.value = '';   // 削除したえさ場などで候補に無い時は「えさ場なし」
  eSel.onchange = () => { st.siteId = eSel.value; };
  mountFields($('#e-fields'), st, { keys: EDIT_FIELD_KEYS, optional: ['pet'], idp: 'e-' });
  $('#e-feature').value = r.feature || '';
  $('#s-back').onclick = $('#e-cancel').onclick = () => openDetail(id);
  $('#e-save').onclick = e => busy(e.currentTarget, async () => {
    if (sheetBusy) return;
    const miss = FIELDS.filter(f => REQUIRED.includes(f[0]) && !st[f[0]]).map(f => f[1]).concat(colorOtherMissing(st));
    if (miss.length) return toast('まだ選んでいない項目があります:\n' + miss.join('、'), 5000);
    const fields = {}, feature = $('#e-feature').value.trim();
    EDIT_FIELD_KEYS.forEach(k => { const nv = k === 'color' ? colorOf(st) : st[k] ?? ''; if (nv !== (k === 'neuter' ? effNeuter(r) : k === 'hairLen' ? effHair(r) : r[k] ?? '')) fields[k] = nv; });
    if ('neuter' in fields || ('ear' in fields && !r.neuter)) fields.neuter = st.neuter;   // 前の記録で不妊手術が空のままさくら耳を直した時も、画面に出ていた値をはっきり送る
    if ((st.siteId || '') !== (r.siteId || '')) fields.siteId = st.siteId || '';
    if (feature !== (r.feature || '')) fields.feature = feature;
    const reasons = st.pet === 'あり' ? [...(st.petReasons || [])] : [], other = reasons.includes('その他') ? (st.petOther || '').trim().slice(0, PET_OTHER_MAX) : '';
    if ('pet' in fields ? st.pet === 'あり' : (JSON.stringify(reasons) !== JSON.stringify(r.petReasons || []) || other !== (r.petOther || ''))) { fields.petReasons = reasons; fields.petOther = other; }
    if (!Object.keys(fields).length) return toast('直した所がありません');
    sheetBusy = true;
    try {
      const nr = { ...r, ...fields };
      if ('pet' in fields || 'petReasons' in fields) { nr.petReasons = fields.petReasons || []; nr.petOther = fields.petOther || ''; if (r.pet || !r.collar) nr.collar = nr.pet === 'あり' && nr.petReasons.includes('首輪がある') ? 'あり' : ''; }   // 首輪は理由に合わせる(古い形の首輪は消さない)
      if (r.status === 'sent') nr.ops = [...opsOf(r), { type: 'edit', opId: newId('o'), queuedAt: new Date().toISOString(), fields }];   // 送った記録は、直しを貯めて送る(電波が無くても貯まる)
      await putAll([nr]);
    } catch (err) { sheetBusy = false; return toast(dbErrText(err), 8000); }
    sheetBusy = false; await updateBadge();
    toast(r.status === 'sent' ? (configured() && loggedIn() && navigator.onLine ? '直しました。送っています…' : '直しました(送信待ち。電波が戻ったら送ります)') : '直しました(まだ送っていない記録なので、そのまま書き換えました)');
    await openDetail(id); syncQuiet().then(async () => { await updateBadge(); if (sheetId === id && $('#s-edit')) openDetail(id); });
  }, '直しています…');
}

const getPos = () => new Promise(ok => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }), () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }) : ok(null));
async function openChange(id) {
  const r = await getRecord(id); if (!r || r.status !== 'sent') return;
  const st = {}, cur = {}; CHANGE_ITEMS.forEach(k => { cur[k] = r[k] || ''; }); cur.neuter = effNeuter(r); cur.hairLen = effHair(r);
  const sites = await allSites(), sm = new Map(sites.map(x => [x.id, x])), curSite = r.siteId || '';
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>状態が変わった</b></div>
  <div class="sheetbody"><div class="warn">変わった項目だけ選んでください。選ばなかった項目は、そのままです。<br>記録は書き換えず、「いつ・何が変わったか」を履歴に足します。日時は今の時刻が自動で入ります。<br>手術が済んだと分かったときは、「不妊手術」の「済み」を選んでください(さくら耳が付いていれば、さくら耳の右か左も)。</div>
  <div id="c-fields"></div>
  <div class="card"><h3>えさ場</h3><p class="now">今: ${esc(curSite ? siteNameOf(curSite, sm) : 'えさ場なし')}</p><p class="hint">えさ場が変わった時だけ選び直してください(自分のえさ場だけ。この記録の場所から近い順。100mより遠いえさ場も下の「そのほかの自分のえさ場」から選べます)</p><select id="c-site" class="sitesel" aria-label="えさ場"></select></div>
  <div class="card" id="c-gonecard"><h3>いる/いない</h3><p class="now">今: ${esc(isGone(r) ? goneText(r) : 'いる')}</p>
    ${isGone(r) ? `<label class="line chk"><input type="checkbox" id="c-back"><span>また見かけた(「いる」に戻す)</span></label>`
    : `<p class="hint">見かけなくなった・保護された など、この場所にいなくなった時だけ。記録は消えません(入力の間違いは「削除」の方です)</p><label class="line chk"><input type="checkbox" id="c-gone"><span>いなくなった</span></label>
    <div id="c-gonebox" class="hidden"><p class="hint">理由(任意・1つ)</p><div class="opts" id="c-goneopts">${GONE_REASONS.map(o => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    <input id="c-goneother" class="petother hidden" type="text" maxlength="${GONE_OTHER_MAX}" placeholder="その他の理由(短く・名前や住所は書かない)" aria-label="その他の理由">
    <label class="line">いなくなったと分かった日 <input type="date" id="c-gonedate" value="${todayText()}" max="${todayText()}"></label></div>`}</div>
  <div class="card"><label class="line chk"><input type="checkbox" id="c-loc"><span>今いる場所も一緒に記録する(任意)</span></label><p class="note">変化に気づいた場所の目安です。この猫の記録の場所は変わりません。</p></div>
  <button type="button" id="c-save" class="primary">この変化を記録する</button>
  <button type="button" id="c-cancel" class="wide">やめる</button></div>`);
  mountFields($('#c-fields'), st, { keys: CHANGE_ITEMS, optional: CHANGE_ITEMS, idp: 'c-', current: cur });
  const cSel = $('#c-site'), cList = siteCands(sites, r), curLive = !curSite || cList.some(x => x.id === curSite);
  cSel.innerHTML = siteOptions(cList, { none: 'えさ場なし(外す)', cur: curSite, head: curLive ? [] : [{ id: curSite, name: siteNameOf(curSite, sm), d: null }] });
  cSel.value = curSite;   // 今のえさ場が選ばれた形で始まる。違う物を選んだ時だけ「変わった」
  cSel.onchange = () => { if (cSel.value === curSite) delete st.siteId; else st.siteId = cSel.value; };
  $('#s-back').onclick = $('#c-cancel').onclick = () => openDetail(id);
  let goneReason = '';
  if ($('#c-gone')) {
    $('#c-gone').onchange = () => $('#c-gonebox').classList.toggle('hidden', !$('#c-gone').checked);
    $('#c-goneopts').onclick = e => { const b = e.target.closest('button[data-v]'); if (!b) return; goneReason = goneReason === b.dataset.v ? '' : b.dataset.v;
      $('#c-goneopts').querySelectorAll('button').forEach(x => x.classList.toggle('sel', x.dataset.v === goneReason)); $('#c-goneother').classList.toggle('hidden', goneReason !== 'その他'); };
  }
  const changeId = newId('c');   // この画面の変化の ID は1つだけ(受け付けは同じ ID を1回だけ受ける)
  $('#c-save').onclick = e => busy(e.currentTarget, async () => {
    if (sheetBusy) return;
    const changes = {}; CHANGE_ITEMS.forEach(k => { if (st[k] && st[k] !== cur[k]) changes[k] = st[k]; });
    if (st.siteId !== undefined && st.siteId !== curSite) changes.siteId = st.siteId;
    let gone = null;
    if ($('#c-gone') && $('#c-gone').checked) {
      const d = $('#c-gonedate').value;
      if (!/^\d{4}-\d\d-\d\d$/.test(d) || d > todayText()) return toast('いなくなったと分かった日を、今日までの日で選んでください');
      changes.gone = 'いなくなった'; gone = { goneReason, goneOther: goneReason === 'その他' ? $('#c-goneother').value.replace(/[\r\n\t:]+/g, ' ').trim().slice(0, GONE_OTHER_MAX) : '', goneDate: d };
    } else if ($('#c-back') && $('#c-back').checked) changes.gone = 'いる';
    if (!Object.keys(changes).length) return toast('変わった項目を選んでください');
    sheetBusy = true;
    const op = { type: 'change', opId: newId('o'), id: changeId, queuedAt: new Date().toISOString(), time: new Date().toISOString(), changes, ...(gone || {}) };
    if (changes.pet === 'あり') { op.petReasons = [...(st.petReasons || [])]; op.petOther = op.petReasons.includes('その他') ? (st.petOther || '').trim().slice(0, PET_OTHER_MAX) : ''; }
    if ($('#c-loc').checked) { toast('位置を取っています…'); const g = await getPos(); if (g) Object.assign(op, g); else toast('位置は取れなかったので、位置なしで記録します', 4000); }
    try {
      const { gone: gch, ...rest } = changes, fresh = await getRecord(id), nr = { ...fresh, ...rest, ops: [...opsOf(fresh), op] };
      if (gch === 'いなくなった') { nr.goneAt = gone.goneDate; nr.goneReason = gone.goneReason === 'その他' && gone.goneOther ? 'その他:' + gone.goneOther : gone.goneReason; }
      else if (gch === 'いる') { nr.goneAt = ''; nr.goneReason = ''; }
      if ('pet' in changes) { nr.petReasons = changes.pet === 'あり' ? (op.petReasons || []) : []; nr.petOther = changes.pet === 'あり' ? (op.petOther || '') : ''; if (fresh.pet || !fresh.collar) nr.collar = nr.petReasons.includes('首輪がある') ? 'あり' : ''; }
      await putAll([nr]);
    } catch (err) { sheetBusy = false; return toast(dbErrText(err), 8000); }
    sheetBusy = false; await updateBadge();
    toast(configured() && loggedIn() && navigator.onLine ? '変化を記録しました。送っています…' : '変化を記録しました(送信待ち。電波が戻ったら送ります)');
    await openDetail(id); syncQuiet().then(async () => { await updateBadge(); if (sheetId === id && $('#s-edit')) openDetail(id); });
  }, '記録しています…');
}

// ---- 管理の画面(役割「管理者」の Google の人だけ。受け付けも毎回「管理者か」で照らす)----
const ROLE_LABEL = r => r === '管理者' ? '管理者' : r === '全体を見る' ? '全体を見る' : '入力者';
const ROLE_OPTIONS = sel => ['', '全体を見る', '管理者'].map(r => `<option value="${r}"${r === sel ? ' selected' : ''}>${ROLE_LABEL(r)}</option>`).join('');
let adminData = null, adminShow = new Set();   // adminShow: メールを全部見せている人の鍵
async function renderAdmin() {
  const box = $('#admin'); if (!box) return;
  if (!(loggedIn() && auth.admin && !isCard())) { box.innerHTML = '<div class="card"><p class="note">この画面は、「管理者」の役割になっている Google アカウントの人だけが使えます。</p></div>'; return; }
  if (!navigator.onLine) { box.innerHTML = '<div class="card"><p class="warn">電波がありません。管理の画面は電波がある所で使えます。</p></div>'; return; }
  box.innerHTML = '<div class="card"><p class="note">読み込んでいます…</p></div>';
  const r = await api('adminList');
  if (!r.ok && r.error === 'id_needed') {   // 20261027-2326: 通行証だけの時は、その場に Google のボタンを出す(確かめが済んだら、そのまま管理の画面を出す)
    reauth = 'admin';
    box.innerHTML = `<div class="card relogin" id="relogin-admin"><p><b>管理の画面を使うには、Google でもう一度確かめます。</b></p><p class="note">下の Google のボタンを押して、いつもの Google アカウントを選んでください。確かめが済むと、そのまま管理の画面が出ます(ログアウトはしません。この端末の記録も消えません)。</p><div class="gsi-spot"></div><button type="button" class="small regsi hidden">Google のボタンを出し直す</button><p class="note gsi-msg"></p></div>`;
    return gsiSpot($('#relogin-admin'));
  }
  if (!r.ok) { box.innerHTML = `<div class="card"><p class="warn">${esc(errText(r.error))}</p></div>`; if (r.error === 'not_allowed') { auth.admin = false; saveAuth(); renderAuth(); } return; }
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
    <div class="card"><p class="note">カードの人は、入力と自分の記録だけができます(役割は付けられません)。「止める」は記録を消しません。カードを止めると、その人の端末のログインも使えなくなります。なくした時は「カードを作り直す」(前のカードは使えなくなり、記録はつながります)。番号を忘れた時・5回まちがえて止まった時は「番号を戻す」。管理の操作はシートの「管理の記録」に残ります。</p></div>
    <div class="card"><h3>不具合の知らせ</h3><p class="note">入力する人がアプリから送った不具合と、アプリが自分で気付いた誤り(自動)。中身と画面の写しは管理者だけが見られます。</p>
      <button type="button" id="ad-bugs" class="wide">不具合の知らせを開く</button></div>
    <div class="card wipecard"><h3>試しの記録をすべて消す</h3><p class="note">本番の調査を始める前に、試しに入れた猫の記録・変化・えさ場と写真を、全員の分まとめて消します。入力者・カード・設定・選択肢は残ります。<b>元には戻せません</b>(写真はドライブのごみ箱に30日残ります)。</p>
      <button type="button" id="ad-wipe" class="wide danger">試しの記録をすべて消す…</button></div>`;
  $('#ad-pin').oninput = () => { $('#ad-pin').value = $('#ad-pin').value.replace(/[^0-9]/g, '').slice(0, 4); };
}
// ---- 試しの記録をすべて消す(2026-10-26 0821。管理者だけ)。2回確かめる(2回目は「消す」と打つ)。押した端末の記録も消す(未送信の物は既定で捨てる・残すも選べる)。ほかの端末は次の取り直しで消えた形になる ----
async function openWipe() {
  if (!(loggedIn() && auth.admin && !isCard())) return;
  let pend = 0; try { pend = (await allRecords()).filter(r => r.status === 'pending' && !r.deleted).length + (await allSites()).filter(x => x.status === 'pending' && !x.deleted).length; } catch { /* 数えられない時は 0 */ }
  showSheet(`<div class="sheethead"><b>試しの記録をすべて消す(1/2)</b></div><div class="sheetbody"><div class="card">
    <p><b>全員の</b>猫の記録・状態の変化・えさ場を消し、写真をドライブのごみ箱へ入れます。</p>
    <p class="note">消えるもの: シートの「記録」「変化」「えさ場」の2行目から下(見出しの行は残ります)・写真のフォルダの中の写真(フォルダは残ります)。<br>残るもの: 「入力者」(登録とカード)・「設定」・「選択肢」・「通行証」(ログインはそのまま)・「管理の記録」。</p>
    ${pend ? `<p class="warn">この端末に、未送信の記録が ${pend} 件あります(まだ受け付けへ届いていません)。次の画面で、捨てるか残すかを選べます。</p>` : ''}
    <p class="warn">元には戻せません。本番の記録が入っていないことを確かめてから進んでください。</p>
    <button type="button" id="wipe-go" class="wide danger">わかった。次へ</button><button type="button" id="wipe-cancel" class="wide">やめる</button></div></div>`);
  $('#wipe-cancel').onclick = () => closeSheet();
  $('#wipe-go').onclick = () => {
    showSheet(`<div class="sheethead"><b>試しの記録をすべて消す(2/2)</b></div><div class="sheetbody"><div class="card">
      <p>本当に消すなら、下の欄に <b>消す</b> と打ってから押してください。</p>
      <input id="wipe-word" type="text" autocomplete="off" aria-label="確かめの文字" placeholder="消す">
      ${pend ? `<label class="fl"><input id="wipe-discard" type="checkbox" checked> この端末の未送信の記録 ${pend} 件も、送らずに捨てる(印を外すと、端末に残して、あとで送ります)</label>` : ''}
      <p id="wipemsg" class="warn hidden"></p>
      <button type="button" id="wipe-final" class="wide danger">すべて消す</button><button type="button" id="wipe-cancel2" class="wide">やめる</button></div></div>`);
    const msg = t => { const el = $('#wipemsg'); el.textContent = t; el.classList.toggle('hidden', !t); };
    $('#wipe-cancel2').onclick = () => closeSheet();
    $('#wipe-final').onclick = e => busy(e.currentTarget, async () => {
      if ($('#wipe-word').value.trim() !== '消す') return msg('「消す」と打ってください(違う文字では消しません)');
      const discard = !$('#wipe-discard') || $('#wipe-discard').checked;
      msg(''); sheetBusy = true;
      try {
        const r = await adminApi('adminWipeTest', { confirm: '消す' });
        if (!r.ok) return msg(r.error === 'already_done' ? 'もう消してあります(前に押した時の返事が届かなかったようです)。' : errText(r.error));
        await wipeLocal(discard);
        closeSheet(); scope = 'mine'; allView = null; renderScopeBar(); await updateBadge(); renderAdmin();
        toast(`消しました: 記録 ${r.records}件・変化 ${r.changes}件・えさ場 ${r.sites}件・写真 ${r.photos}枚(ごみ箱へ)。ほかの端末は、次に取り直した時に消えます`, 9000);
      } finally { sheetBusy = false; }
    }, '消しています…');
  };
}
// 押した端末の控えを消す。discard=false なら、未送信の記録・えさ場は残す(あとで送る)
async function wipeLocal(discard) {
  if (discard) return clearAll();
  await run('readwrite', s => { const q = s.getAll(); q.onsuccess = () => q.result.forEach(r => { if (r.status === 'sent') s.delete(r.id); else if (opsOf(r).length) { r.ops = []; s.put(r); } }); });
  await run('readwrite', s => { const q = s.getAll(); q.onsuccess = () => q.result.forEach(x => { if (x.status === 'sent') s.delete(x.id); }); }, SITES);
  // 残した記録が、消したえさ場に結び付いていれば外す
  const ids = new Set((await allSites()).map(x => x.id));
  await run('readwrite', s => { const q = s.getAll(); q.onsuccess = () => q.result.forEach(r => { if (r.siteId && !ids.has(r.siteId)) { r.siteId = ''; s.put(r); } }); });
}
// 管理の操作の ID(reqId): 押した時に1つ作る。返事が来なかった(電波・時間切れ)のあとに同じ内容で押し直したら、同じ ID で送る(受け付けは2回目を行わない)
let lastReq = null;
async function adminApi(action, extra) {
  const key = action + JSON.stringify(extra);
  if (!lastReq || lastReq.key !== key) lastReq = { key, id: newId('q') };
  const r = await api(action, { ...extra, reqId: lastReq.id });
  if (!noAnswer(r.error)) lastReq = null;
  if (r.error === 'id_needed') adminRelogin();   // 20261027-2340: 管理の画面を開いたまま切れた時も、知らせだけで終わらずにその場に Google のボタンを出す
  return r;
}
function adminRelogin() { const t = document.querySelector('.tab.active'); if (sheetId) closeSheet(); else if (t && t.id === 'tab-admin') renderAdmin(); }
// 管理の画面の押し物(登録・カードを作る・一覧の操作)。押したボタンは、終わるまで押せない
function onAdminClick(e) {
  const b = e.target.closest('button'); if (!b || sheetBusy || b.classList.contains('regsi')) return;
  if (b.dataset.act === 'peek') return adminClick(b, e);   // メールを見せる・隠すは画面の中だけ
  return busy(b, () => adminClick(b, e));
}
async function adminClick(b, e) {
  if (b.id === 'ad-wipe') return openWipe();
  if (b.id === 'ad-bugs') return openBugAdmin();
  if (b.id === 'ad-add') {
    const email = $('#ad-email').value.trim(), role = $('#ad-role').value; if (!email) return toast('メールアドレスを入れてください');
    const r = await adminApi('adminAddGoogle', { email, role }); if (!r.ok) { if (r.error === 'already_done') renderAdmin(); return toast(errText(r.error), 6000); }
    toast(`登録しました(${r.recorder.masked})`); return renderAdmin();
  }
  if (b.id === 'ad-card') {
    const name = $('#ad-name').value.replace(/\s+/g, ' ').trim(), pin = $('#ad-pin').value;
    if (!name) return toast('呼び名を入れてください'); if (!/^[0-9]{4}$/.test(pin)) return toast('暗証番号は数字4つです');
    const r = await adminApi('adminCardCreate', { name, pin });
    if (!r.ok) { if (r.error === 'already_done') { renderAdmin(); return toast('このカードは、もう作られています(前に押した時の返事が届かなかったようです)。一覧のその人の「カードを作り直す」で QR を出してください。', 9000); } return toast(errText(r.error), 5000); }
    $('#ad-name').value = ''; $('#ad-pin').value = '';
    return showCardResult({ secret: r.secret, name: r.recorder.name, pin, fresh: true });
  }
  const card = e.target.closest('.person'); if (!card || !adminData) return; const key = card.dataset.key, x = adminData.recorders.find(p => p.key === key); if (!x) return;
  const act = b.dataset.act, label = x.type === 'card' ? x.name : x.masked;
  if (act === 'peek') { if (adminShow.has(key)) adminShow.delete(key); else adminShow.add(key); return renderAdmin(); }
  if (act === 'stop' || act === 'restore') {
    const stopped = act === 'stop';
    if (stopped && !confirm(`${label} を止めます。記録は消えません。${x.type === 'card' ? 'この人の端末のログインも使えなくなります。' : ''}よろしいですか?`)) return;
    const r = await adminApi('adminSetState', { key, stopped }); if (!r.ok) return toast(errText(r.error), 5000);
    toast(stopped ? '止めました' : 'また使えるようにしました'); return renderAdmin();
  }
  if (act === 'resetpin') return openPinForm({ title: `${label} の番号を戻す`, note: 'この人に伝える新しい暗証番号(数字4つ)を入れてください。カードはそのまま使えます。この人の端末では、もう一度カードをかざして新しい番号を入れることになります。', button: 'この番号にする',
    onsubmit: async pin => { const r = await adminApi('adminCardResetPin', { key, pin }); if (!r.ok) return toast(errText(r.error), 5000); closeSheet(); toast('番号を戻しました。新しい番号をその人に伝えてください', 5000); renderAdmin(); } });
  if (act === 'reissue') return openPinForm({ title: `${label} のカードを作り直す`, note: '前のカードは使えなくなります(記録はつながります)。新しいカードの暗証番号(数字4つ)を入れてください。', button: '作り直す(QR を出す)',
    onsubmit: async pin => { const r = await adminApi('adminCardReissue', { key, pin }); if (!r.ok) return toast(errText(r.error), 5000); showCardResult({ secret: r.secret, name: r.recorder.name, pin, fresh: false }); } });
}
// 一覧の「役割」の選択肢を変えた時
async function onAdminChange(e) {
  const sel = e.target.closest('select[data-act=role]'), card = e.target.closest('.person'); if (!sel || !card || !adminData) return;
  const key = card.dataset.key, x = adminData.recorders.find(p => p.key === key); if (!x) return;
  sel.disabled = true; const r = await adminApi('adminSetRole', { key, role: sel.value }); sel.disabled = false;   // 返事が来るまで選び直せない
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
  $('#pf-go').onclick = e => busy(e.currentTarget, async () => { const pin = $('#pf-pin').value; if (!/^[0-9]{4}$/.test(pin)) return toast('暗証番号は数字4つです'); await onsubmit(pin); });
}
// カードを作った直後の画面: QR(端末の中で作る)・印刷・NFC タグに書き込む(Android の Chrome)・URL をコピー。合言葉が出るのはこの画面の1回だけ
const cardUrl = secret => `${location.origin}${location.pathname}#card=${secret}`;
function showCardResult({ secret, name, pin, fresh }) {
  const url = cardUrl(secret), nfc = 'NDEFReader' in window;
  showSheet(`<div class="sheethead noprint"><b>${fresh ? 'カードを作りました' : 'カードを作り直しました'}</b></div>
  <div class="sheetbody">
  <div class="warn noprint">この画面を閉じると、このカードの合言葉は<b>二度と出ません</b>。印刷か NFC の書き込みを済ませてから閉じてください。失くした時は「カードを作り直す」で新しいカードにします。</div>
  <div class="card printcard"><div class="pc-title">まちねこ帳 ログインカード</div><div class="pc-name">${esc(name)}</div>
    <canvas id="qr" class="qr" aria-label="ログイン用の QR コード"></canvas>
    <p class="pc-note">スマホのカメラでこの QR コードを読むと、調査のアプリが開きます。はじめの1回だけ、管理者から伝えられた4けたの暗証番号を入れてください。<br>このカードは他の人に渡さないでください。</p></div>
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

// ---- 不具合の知らせ(2026-10-27 0607・管理者 msg 6788〜6790)----
// 設定の「不具合を知らせる」: 文(画面・何をしたら・どうなった)と画面の写し(任意・2枚まで・縮めて位置情報を消す)を受け付けへ。電波が無ければ端末に残して後で送る。
// 自動で添えるのは、版・端末の種類(OS とブラウザの大まかな名前)・画面の名前・直前の誤り(最大5件)だけ。場所・記録の中身・記録の ID・名前・メールは入れない。
// アプリが自分で気付いた誤り(画面の誤り・保存や送信の失敗・受け付けの断り)は、端末に最大20件控え、1日1回まとめて送る(設定で止められる)。
const APP_VER = 'cat-survey-v33';   // sw.js のキャッシュの名前と同じにする
const BUG_SCREENS = ['猫の入力', 'えさ場', '一覧', '地図', '集計', '設定', '管理', 'ログイン', 'その他'];
const TAB_SCREEN = { record: '猫の入力', sites: 'えさ場', list: '一覧', map: '地図', stats: '集計', settings: '設定', admin: '管理' };
const BUG_TEXT_MAX = 500, BUG_PHOTOS = 2, BUG_SIDE = 1280, ERR_KEY = 'catSurvey.errlog', ERR_BATCH = 'catSurvey.errBatch', ERR_DAY = 'catSurvey.errSentDay', ERR_MAX = 20;
let lastScreen = 'record';
const screenName = t => !loggedIn() ? 'ログイン' : TAB_SCREEN[t] || 'その他';
// 端末の種類: OS とブラウザの名前と大きい版の数だけ(細かい型番・言語・画面の大きさは送らない)
function deviceText() {
  const u = navigator.userAgent || '', m = (re, i = 1) => { const x = re.exec(u); return x ? x[i] : ''; };
  const os = /iPhone|iPad|iPod/.test(u) ? 'iOS ' + m(/OS (\d+)_/) : /Android/.test(u) ? 'Android ' + m(/Android (\d+)/) : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'その他';
  const br = /EdgA?\//.test(u) ? 'Edge ' + m(/EdgA?\/(\d+)/) : /SamsungBrowser/.test(u) ? 'Samsung ' + m(/SamsungBrowser\/(\d+)/) : /CriOS/.test(u) ? 'Chrome ' + m(/CriOS\/(\d+)/) : /FxiOS|Firefox/.test(u) ? 'Firefox ' + m(/(?:FxiOS|Firefox)\/(\d+)/)
    : /Chrome\//.test(u) ? 'Chrome ' + m(/Chrome\/(\d+)/) : /Safari\//.test(u) ? 'Safari ' + m(/Version\/(\d+)/) : 'その他';
  return (os.trim() + '・' + br.trim()).slice(0, 60);
}
// 誤りの文から、記録の中身・座標・メール・トークンらしい物を消す(受け付けの scrubText と同じ消し方。受け付けも書く前にもう一度通す)
function scrubText(s, max = 200) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  s = s.replace(/(https?:\/\/[^\s?#'"<>]*)[?#][^\s'"<>]*/g, '$1?[略]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[メール]')
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]*)?/g, '[トークン]')
    .replace(/\b(ya29|Bearer)[ .][A-Za-z0-9._-]+/g, '[トークン]')
    .replace(/[A-Za-z0-9_+\/=-]{20,}/g, '[長い文字列]')
    .replace(/\b(?=[0-9a-z]*[0-9])(?=[0-9a-z]*[a-z])[0-9a-z]{8,19}\b/g, '[ID]')
    .replace(/-?\d{1,3}\.\d{3,}/g, '[数]')
    .replace(/\+?\d[\d -]{7,}\d/g, '[数字]')
    .replace(/(["'「『])[^"'」』]{1,}?(["'」』])/g, '$1…$2')
    .replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
const autoErrOn = () => cfg().autoErr !== false;
// 誤りを1件控える(同じ文は回数を足す)。最大 ERR_MAX 件(古い物から捨てる)
function logErr(msg) {
  try {
    const m = scrubText(msg); if (!m) return;
    const log = lsGet(ERR_KEY, []), now = new Date().toISOString(), x = log.find(e => e.msg === m);
    if (x) { x.n = (x.n || 1) + 1; x.last = now; x.screen = screenName(lastScreen); }
    else log.push({ msg: m, n: 1, first: now, last: now, screen: screenName(lastScreen) });
    log.sort((a, b) => a.last.localeCompare(b.last)); while (log.length > ERR_MAX) log.shift();
    localStorage.setItem(ERR_KEY, JSON.stringify(log));
  } catch { /* 控えられなくても、アプリは止めない */ }
}
const recentErrs = () => [...lsGet(ERR_BATCH, { items: [] }).items, ...lsGet(ERR_KEY, [])].sort((a, b) => String(b.last || '').localeCompare(String(a.last || ''))).slice(0, 5).map(e => ({ msg: e.msg, n: e.n || 1 }));
window.addEventListener('error', e => { if (e && e.message) logErr('画面の誤り: ' + e.message + (e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + (e.lineno || 0) + ')' : '')); });
window.addEventListener('unhandledrejection', e => { const r = e && e.reason; logErr(r && DB_TEXT[r.code] ? '保存の入れ物: ' + r.code : '処理の誤り: ' + (r && (r.message || r.name) || String(r))); });
// 1日1回、控えた誤りをまとめて送る。送る前のまとめ(番号つき)は残し、返事が届かなければ同じ番号で送り直す(受け付けが二重にしない)
async function autoErrFlush() {
  if (!autoErrOn() || !configured() || !loggedIn() || !navigator.onLine) return { sent: false, why: 'off' };
  let batch = lsGet(ERR_BATCH, null);
  if (!batch) {
    if (localStorage.getItem(ERR_DAY) === todayText()) return { sent: false, why: 'today' };
    const log = lsGet(ERR_KEY, []); if (!log.length) return { sent: false, why: 'empty' };
    batch = { items: log.map(e => ({ ...e, cid: newId('e') })) }; localStorage.setItem(ERR_BATCH, JSON.stringify(batch)); localStorage.removeItem(ERR_KEY);
  }
  const ver = APP_VER, device = deviceText();
  const r = await api('bugAuto', { items: batch.items.map(e => ({ msg: scrubText(e.msg), n: e.n, screen: e.screen, ver, device, cid: e.cid })) });
  if (!r.ok && (noAnswer(r.error) || ['busy', 'not_logged_in', 'id_needed'].includes(r.error))) return { sent: false, why: r.error };   // 次の回にまた
  localStorage.removeItem(ERR_BATCH); localStorage.setItem(ERR_DAY, todayText());   // 断られた(形が違う等)時も、繰り返さない
  return { sent: !!r.ok, added: r.added };
}
// 手で送る知らせ: 別の入れ物(catSurveyBugs)に置き、送れたら外す
let bugDbp = null;
// 開けない・止まった(blocked)・時間切れ(8秒)の時は待ち続けず失敗にする(送信や起動を止めない。20261027-0731)。別の画面が版を上げる時は閉じて譲る
const bugDb = () => bugDbp || (bugDbp = new Promise((ok, ng) => {
  let done = false; const fail = e => { if (done) return; done = true; clearTimeout(tm); bugDbp = null; ng(e || dbErr('failed')); }, tm = setTimeout(() => fail(dbErr('timeout')), DB_WAIT_MS);
  let q; try { q = indexedDB.open('catSurveyBugs', 1); } catch (e) { return fail(e); }
  q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('bugs')) q.result.createObjectStore('bugs', { keyPath: 'cid' }); };
  q.onsuccess = () => { const db = q.result; db.onversionchange = () => { db.close(); bugDbp = null; }; if (done) { db.close(); return; } done = true; clearTimeout(tm); ok(db); };
  q.onerror = () => fail(q.error); q.onblocked = () => fail(dbErr('blocked'));
}));
const bugTx = (mode, fn) => bugDb().then(db => new Promise((ok, ng) => { const t = db.transaction('bugs', mode), r = fn(t.objectStore('bugs')); t.oncomplete = () => ok(r && r.result); t.onerror = t.onabort = () => ng(t.error); }));
const bugAll = () => bugTx('readonly', s => s.getAll()).catch(() => []);
async function renderBugPend() { const el = $('#bugpend'); if (!el) return; const n = (await bugAll()).filter(b => !auth || b.owner === (auth.recorderId || '')).length; el.textContent = n ? `まだ送れていない知らせが ${n} 件あります(電波が戻ったら送ります)` : ''; }
let bugSending = false;
async function bugFlush(quiet) {
  if (bugSending || !configured() || !loggedIn() || !navigator.onLine) return { sent: 0 };
  bugSending = true; let sent = 0, last = null;
  try {
    for (const b of (await bugAll()).filter(b => b.owner === (auth.recorderId || '')).sort((a, c) => a.at.localeCompare(c.at))) {
      const r = await api('bugAdd', { bug: b.bug, photos: b.photos }, b.photos.length ? API_WAIT_PHOTO_MS : API_WAIT_MS);
      if (!r.ok && (noAnswer(r.error) || r.error === 'busy')) { last = r; break; }   // 端末に残して、後で
      await bugTx('readwrite', s => s.delete(b.cid));
      if (r.ok) { sent++; const mineList = lsGet('catSurvey.myBugs', []); mineList.unshift(r.no); localStorage.setItem('catSurvey.myBugs', JSON.stringify(mineList.slice(0, 50))); toast(`受け付けました(番号 ${r.no})`, 6000); }
      else toast(r.error === 'bug_limit' ? `不具合の知らせは、1日に ${r.max || 10} 件までです。明日また送ってください(この知らせは送れませんでした)` : `知らせを送れませんでした(${errText(r.error)})`, 8000);
      last = r;
    }
  } finally { bugSending = false; renderBugPend(); }
  return { sent, last };
}
// 画面の写しを縮める(長辺 1280px・canvas に描き直すので位置情報などの付属情報は落ちる)
const shrinkShot = async file => blobToB64(await cleanImage(file, BUG_SIDE, 0.75));
function openBugForm() {
  if (!loggedIn()) return toast('ログインしてから送ってください');
  const shots = [], from = screenName(lastScreen);
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>不具合を知らせる</b></div><div class="sheetbody"><div class="card">
    <p class="warn">人の名前・住所・電話は書かないでください。</p>
    <label class="fl">どの画面で<select id="bug-screen">${BUG_SCREENS.map(s => `<option${s === from ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
    <label class="fl">何をしたら(${BUG_TEXT_MAX}字まで)<textarea id="bug-what" rows="3" maxlength="${BUG_TEXT_MAX}" placeholder="例: 一覧で猫を押した"></textarea></label>
    <label class="fl">どうなった(${BUG_TEXT_MAX}字まで)<textarea id="bug-result" rows="3" maxlength="${BUG_TEXT_MAX}" placeholder="例: 画面が白くなった"></textarea></label>
    <p class="note">画面の写し(なくてもよい・${BUG_PHOTOS}枚まで。送る前に縮めて、位置情報を消します)</p>
    <label class="small filebtn">写しを選ぶ<input type="file" id="bug-shot" accept="image/*" multiple hidden></label><div id="bug-thumbs" class="thumbs"></div>
    <p class="note">一緒に送るもの: アプリの版(${esc(APP_VER)})・端末の種類(${esc(deviceText())})・直前の誤り(${recentErrs().length}件)・送った時刻。場所・記録の中身・メールは送りません。送った人は入力者の番号で残ります。</p>
    <p id="bug-msg" class="warn hidden"></p>
    <button type="button" id="bug-send" class="primary">送る</button><button type="button" id="bug-cancel" class="wide">やめる</button></div></div>`);
  const msg = t => { const el = $('#bug-msg'); el.textContent = t; el.classList.toggle('hidden', !t); };
  const thumbs = () => { $('#bug-thumbs').innerHTML = shots.map((s, i) => `<span class="thumb"><img src="data:image/jpeg;base64,${s}" alt="写し${i + 1}"><button type="button" data-i="${i}" aria-label="外す">×</button></span>`).join(''); };
  $('#s-back').onclick = $('#bug-cancel').onclick = () => closeSheet();
  $('#bug-thumbs').onclick = e => { const b = e.target.closest('button[data-i]'); if (b) { shots.splice(+b.dataset.i, 1); thumbs(); } };
  $('#bug-shot').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) { if (shots.length >= BUG_PHOTOS) { msg(`画面の写しは ${BUG_PHOTOS} 枚までです`); break; } try { shots.push(await shrinkShot(f)); } catch { msg('この写しは読み込めませんでした'); } }
    thumbs();
  };
  $('#bug-send').onclick = e => busy(e.currentTarget, async () => {
    const what = $('#bug-what').value.trim(), result = $('#bug-result').value.trim();
    if (!what && !result) return msg('「何をしたら」か「どうなった」を書いてください');
    msg('');
    const item = { cid: newId('b'), owner: auth.recorderId || '', at: new Date().toISOString(), photos: shots.slice(),
      bug: { screen: $('#bug-screen').value, what: what.slice(0, BUG_TEXT_MAX), result: result.slice(0, BUG_TEXT_MAX), ver: APP_VER, device: deviceText(), errors: recentErrs(), cid: '' } };
    item.bug.cid = item.cid;
    try { await bugTx('readwrite', s => s.put(item)); } catch { return msg('この端末に控えられませんでした。もう一度押してください'); }
    closeSheet();
    if (!navigator.onLine) { toast('電波がありません。この端末に残して、電波が戻ったら送ります', 6000); return renderBugPend(); }
    const r = await bugFlush(false);
    if (!r.sent && r.last && (noAnswer(r.last.error) || r.last.error === 'busy')) toast(sendErrText(r.last.error).replace('記録は', '知らせは'), 7000);
  }, '送っています…');
}
// 送った知らせの状態(自分の分だけ)
async function openBugMine() {
  if (!navigator.onLine) return toast('電波がある所で開いてください');
  const r = await api('bugMine'); if (!r.ok) return toast(errText(r.error), 5000);
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>送った知らせ</b></div><div class="sheetbody">
    ${r.items.length ? r.items.map(x => `<div class="card bugitem"><b>番号 ${esc(x.no)}</b> <span class="mark ${x.state === '済み' ? 'edit' : 'chg'}">${esc(x.state)}</span><div class="note">${esc(fmtShort(tms(x.time)))}・${esc(x.screen)}</div></div>`).join('') : '<div class="card"><p class="note">まだ送った知らせはありません</p></div>'}
    <div class="card"><p class="note">状態は「新しい」→「対応中」→「済み」と変わります。中身は管理者だけが見られます。</p></div></div>`);
  $('#s-back').onclick = () => closeSheet();
}
// 管理者: 不具合の知らせの一覧(新しい順・状態で絞る)・中身と画面の写し・状態とメモを変える
let bugFilter = '';
async function openBugAdmin() {
  if (!(loggedIn() && auth.admin && !isCard())) return;
  const r = await api('adminBugList'); if (!r.ok) { if (r.error === 'id_needed') adminRelogin(); return toast(errText(r.error), 5000); }
  const items = r.items.filter(x => !bugFilter || x.state === bugFilter);
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← もどる</button><b>不具合の知らせ(${r.items.length}件)</b></div><div class="sheetbody">
    <div class="row seg" id="bugfilter">${['', '新しい', '対応中', '済み'].map(s => `<button type="button" class="small${s === bugFilter ? ' on' : ''}" data-f="${s}">${s || 'すべて'}(${r.items.filter(x => !s || x.state === s).length})</button>`).join('')}</div>
    ${items.map(x => `<div class="card bugitem" data-no="${esc(x.no)}" role="button" tabindex="0"><b>番号 ${esc(x.no)}</b> <span class="mark ${x.state === '済み' ? 'edit' : 'chg'}">${esc(x.state)}</span>${x.kind === '自動' ? ' <span class="mark del">自動</span>' : ''}${x.photoCount ? ` <span class="note">写し ${x.photoCount}枚</span>` : ''}
      <div class="note">${esc(fmtShort(tms(x.time)))}・${esc(x.screen)}・入力者 ID ${esc(x.recorderId.slice(0, 6))}</div><div class="bugtext">${esc((x.kind === '自動' ? x.errors + (x.count > 1 ? `(${x.count}回)` : '') : x.result || x.what).slice(0, 80))}</div></div>`).join('') || '<div class="card"><p class="note">ありません</p></div>'}</div>`);
  $('#s-back').onclick = () => closeSheet();
  $('#bugfilter').onclick = e => { const b = e.target.closest('button[data-f]'); if (b) { bugFilter = b.dataset.f; busy(b, openBugAdmin); } };
  $('#sheet .sheetbody').onclick = e => { const c = e.target.closest('.bugitem'); if (c) { const x = r.items.find(y => y.no === c.dataset.no); if (x) openBugDetail(x); } };
}
async function openBugDetail(x) {
  const line = (l, v) => v ? `<div class="line2"><span class="lbl">${esc(l)}</span><span class="pre">${esc(v)}</span></div>` : '';
  showSheet(`<div class="sheethead"><button type="button" id="s-back" class="small">← 一覧へ</button><b>番号 ${esc(x.no)}</b></div><div class="sheetbody"><div class="card">
    ${line('受付日時', fmtShort(tms(x.time)))}${line('種類', x.kind)}${line('入力者の番号', x.recorderId)}${line('画面', x.screen)}${line('何をしたら', x.what)}${line('どうなった', x.result)}${line('版', x.ver)}${line('端末', x.device)}${line('誤り', x.errors)}${x.kind === '自動' ? line('回数', String(x.count)) : ''}
    <div id="bug-shots" class="thumbs">${Array.from({ length: x.photoCount }, (_, i) => `<span class="rph" data-n="${i + 1}"><span class="rphmsg">写し ${i + 1} 読み込み中…</span></span>`).join('')}</div></div>
    <div class="card"><label class="fl">状態<select id="bug-state">${['新しい', '対応中', '済み'].map(s => `<option${s === x.state ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
    <label class="fl">管理者のメモ(500字まで)<textarea id="bug-memo" rows="3" maxlength="500">${esc(x.memo)}</textarea></label>
    <button type="button" id="bug-save" class="primary">状態とメモを保存</button></div></div>`);
  $('#s-back').onclick = () => openBugAdmin();
  const blobs = [];
  $('#bug-save').onclick = e => busy(e.currentTarget, async () => {
    const r = await adminApi('adminBugSet', { no: x.no, state: $('#bug-state').value, memo: $('#bug-memo').value });
    if (!r.ok) return toast(errText(r.error), 5000);
    x.state = r.state; x.memo = r.memo; toast(`番号 ${x.no} を「${r.state}」にしました`);
  }, '保存しています…');
  $('#bug-shots').onclick = e => { const im = e.target.closest('img[data-bugshot]'); if (im) openViewer(blobs.filter(Boolean), +im.dataset.bugshot); };
  const shots = async ns => {
    const wait = [];
    for (const n of ns) {
      const el = $(`#bug-shots .rph[data-n="${n}"]`), r = await api('adminBugPhoto', { no: x.no, n }, API_WAIT_PHOTO_MS);
      if (!el || !el.isConnected) return;
      if (!r.ok && r.error === 'id_needed') { el.querySelector('.rphmsg').textContent = `写し ${n}: Google で確かめると出ます`; wait.push(n); continue; }
      if (!r.ok) { el.querySelector('.rphmsg').textContent = '写しを読み込めません'; continue; }
      const b = b64Blob(r.data), u = URL.createObjectURL(b); sheetUrls.push(u); blobs[n - 1] = b;
      el.innerHTML = `<img src="${u}" alt="画面の写し ${n}" data-bugshot="${n - 1}">`;
    }
    if (!wait.length) return;
    // 20261028-0140: ID トークンが切れていた時は、写しのすぐ上に Google のボタンを出す(確かめが済んだら、この画面のまま写しを出す)
    const box = $('#bug-shots');
    if (!document.getElementById('relogin-bugshot')) { box.insertAdjacentHTML('beforebegin', photoReloginHtml('画面の写し').replace('relogin-photo"', 'relogin-photo" id="relogin-bugshot"')); }
    gsiSpot(document.getElementById('relogin-bugshot'));
    photoWaits.add(() => {
      if (!box.isConnected) return;
      const c = document.getElementById('relogin-bugshot'); if (c) c.remove();
      wait.forEach(n => { const el = box.querySelector(`.rph[data-n="${n}"] .rphmsg`); if (el) el.textContent = `写し ${n} 読み込み中…`; });
      shots(wait);
    });
  };
  shots(Array.from({ length: x.photoCount }, (_, i) => i + 1));
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

// 画面の名前(上の名前)と、下の4つ以外の画面(上に「← ホーム」が出る)
const TITLES = { home: 'まちねこ帳 <small>試用版</small>', record: '猫を記録する', list: '記録の一覧', map: '地図', sites: 'えさ場', stats: '集計', settings: '設定', admin: '管理', bug: '不具合を知らせる' };
const MAIN_TABS = ['home', 'record', 'list', 'map'];
// 戻る: スマホの戻るボタン・端から払う操作は、ブラウザの履歴で受ける。下の4つの間の行き来は履歴を積まず(replaceState)、戻るとホームへ。ホームから入る画面だけ積む(pushState)
function showTab(t, fromPop) {
  if (!loggedIn() && t !== 'record') t = 'record';   // ログインしていない人は、ログインの画面(入力の欄)にしか行けない
  if (!document.getElementById('tab-' + t)) t = 'record';   // 20261027-1050c: 古い index.html(HTTP の控え)に無い画面(ホームなど)は、入力の画面を出す(真っ白にしない)
  if (t !== 'map' && picking) setPicking(false); // 地図指定の途中で離れたら取り消す
  if (t !== 'settings' && t !== 'bug' && t !== 'home') lastScreen = t;   // 不具合の知らせの「どの画面で」の初めの選び(0607)
  document.querySelectorAll('#bottomnav button').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + t));
  $opt('#screen-title').innerHTML = TITLES[t] || t; document.title = (t === 'home' ? '' : $opt('#screen-title').textContent + ' - ') + 'まちねこ帳';
  $opt('#btn-back').classList.toggle('hidden', MAIN_TABS.includes(t));
  if (!fromPop) { try { const cur = history.state || { tab: 'home', d: 0 };
    if (cur.tab === t) { /* 同じ画面 */ } else if (t === 'home') { if (cur.d > 0) history.go(-cur.d); else history.replaceState({ tab: 'home', d: 0 }, ''); }
    else if (cur.tab !== 'home' && MAIN_TABS.includes(cur.tab) && MAIN_TABS.includes(t)) history.replaceState({ tab: t, d: cur.d }, '');   // 下の4つの間: 積まない
    else history.pushState({ tab: t, d: cur.d + 1 }, '');   // ホームから入る・ホーム以外の画面から入る: 積む(戻るで1つ前)
  } catch { /* 履歴が使えない時は戻る操作だけ効かない */ } }
  window.scrollTo(0, 0);
  renderScopeBar();
  if (t === 'home') updateBadge(); if (t === 'bug') renderBugPend(); if (t === 'list') renderList(); if (t === 'stats') renderStats(); if (t === 'sites') renderSites(); if (t === 'settings') renderAuth(); if (t === 'record') renderSiteCands(); if (t === 'admin') renderAdmin();
  if (t === 'map') {
    renderMap();
    if (mapFocus) { initMap(); map.invalidateSize(); map.setView([mapFocus.lat, mapFocus.lng], 17, { animate: false }); mapFocus = null; mapAuto = true; }
    else if (!mapAuto && !picking) { mapAuto = true; locateMe(true); }   // 地図を最初に開いた時: 位置が取れれば今の場所を中心に(取れなければ自分の記録の範囲)
  }
}

// ---- 新しい版の知らせ(20261027-0734)----
// 開いた時・前に出した時・30分ごとに、置き場に新しい版(sw.js)があるか確かめる。新しい版が入って待っていたら、上に「新しい版があります。」と「更新」を出す。
// 「更新」を押すと、待っている版に入れ替えて1回だけ読み込み直す。入力の途中(保存していない入力がある)なら、読み込み直さずに案内だけ出す。
// 画面そのもの(index.html・app.js)が、すでに待っている版と同じなら(サービスワーカーが毎回置き場に確かめるため)、知らせを出さずに黙って入れ替える。
// 20261027-0851: 起動の直後(開いてから10秒の間で、まだ何も触っていない)に新しい版が入ったら、押さなくても自動で1回だけ読み込み直す。
// それ以外(使っている途中)は、自動では読み込み直さず、知らせを出して「更新」が押されるまで待つ(ほかの画面で更新された時も同じ)。自動の読み込み直しは60秒に1回まで。
const UPD_EVERY_MS = 30 * 60 * 1000, STARTUP_MS = 10000, AUTO_UPD_KEY = 'catSurvey.autoUpd';
let swReg = null, updAsked = false, updReloaded = false, updQuiet = false, lastUpdCheck = 0, userTouched = false;
['pointerdown', 'keydown', 'input'].forEach(t => window.addEventListener(t, () => { userTouched = true; }, { capture: true, once: true }));
function inStartup() {   // 起動の直後で、まだ何も触っていない・入力も無い
  return !userTouched && Date.now() - bootT0 < STARTUP_MS && !typingNow() && Date.now() - Number(sessionStorage.getItem(AUTO_UPD_KEY) || 0) > 60000;
}
function autoUpdate(w) {   // 起動の直後だけ: 押さなくても1回だけ入れ替えて読み込み直す
  sessionStorage.setItem(AUTO_UPD_KEY, String(Date.now())); bootMark('新しい版に自動で入れ替え');
  updAsked = true;
  if (w) { w.postMessage({ type: 'skipWaiting' }); setTimeout(() => { if (!updReloaded) { updReloaded = true; location.reload(); } }, 5000); }
  else { updReloaded = true; location.reload(); }
}
function showUpdMsg() { const m = document.getElementById('updmsg'); if (m) m.classList.remove('hidden'); }
function swVer(w) {   // 待っている版の名前を聞く(答えが無ければ '')
  return new Promise(ok => { try { const ch = new MessageChannel(); const t = setTimeout(() => ok(''), 3000); ch.port1.onmessage = e => { clearTimeout(t); ok(String(e.data || '')); }; w.postMessage({ type: 'ver' }, [ch.port2]); } catch { ok(''); } });
}
async function onWaiting(w) {
  if (!w || !navigator.serviceWorker.controller) return;
  const v = await swVer(w);
  if (v && v === APP_VER) { updQuiet = true; w.postMessage({ type: 'skipWaiting' }); return; }   // 画面はもう新しい版。黙って入れ替える
  if (inStartup()) return autoUpdate(w);
  showUpdMsg();
}
function watchSw(reg) {
  if (reg.waiting) onWaiting(reg.waiting);
  reg.addEventListener('updatefound', () => { const w = reg.installing; if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed') onWaiting(w); }); });
}
async function checkUpdate(byHand) {   // byHand: 設定の「新しい版を確かめる」
  lastUpdCheck = Date.now();
  if (!swReg) { if (byHand) toast('この画面では新しい版を確かめられません', 5000); return; }
  if (!navigator.onLine) { if (byHand) toast('電波が無いので、新しい版を確かめられません', 5000); return; }
  try { await swReg.update(); } catch { if (byHand) toast('新しい版を確かめられませんでした。電波のある所でもう一度押してください', 6000); return; }
  if (!byHand) return;
  if (swReg.installing) await new Promise(ok => { const w = swReg.installing, t = setTimeout(ok, 15000); w.addEventListener('statechange', () => { if (w.state !== 'installing') { clearTimeout(t); ok(); } }); });
  if (swReg.waiting) await onWaiting(swReg.waiting);
  const m = document.getElementById('updmsg');
  if (m && !m.classList.contains('hidden')) toast('新しい版があります。上の「更新」を押してください', 6000);
  else toast('今の版が新しい版です(' + APP_VER.replace('cat-survey-', '') + ')');
}
function doUpdate() {
  if (typingNow()) return toast('入力の途中です。保存してから「更新」を押してください(入力は消えていません)', 6000);
  const w = swReg && swReg.waiting;
  if (w) { updAsked = true; w.postMessage({ type: 'skipWaiting' }); setTimeout(() => { if (!updReloaded) { updReloaded = true; location.reload(); } }, 5000); }   // 入れ替わりの知らせが来なければ5秒で読み込み直す
  else { updReloaded = true; location.reload(); }   // もう入れ替わっている(ほかの画面で更新された)
}

// ---- 起動の記録(20261027-0820)----
// 起動の段ごとに、開いてからの秒数を控える。設定の画面の「起動の記録」に、今回と前回の分を出す(困った時に写真で送れるように)
const BOOTLOG_KEY = 'catSurvey.bootlog', bootT0 = window.catT0 || Date.now(), bootMarks = [];
function bootMark(name) {
  if (bootMarks.length > 40 || bootMarks.some(x => x[0] === name)) return;
  bootMarks.push([name, Date.now() - bootT0]);
  try { const all = JSON.parse(localStorage.getItem(BOOTLOG_KEY) || '[]'); const cur = { at: bootT0, ver: APP_VER, m: bootMarks };
    if (all.length && all[0].at === bootT0) all[0] = cur; else all.unshift(cur); localStorage.setItem(BOOTLOG_KEY, JSON.stringify(all.slice(0, 3))); } catch { /* 保存できない時 */ }
  renderBootLog();
}
function renderBootLog() {
  const el = document.getElementById('bootlog'); if (!el) return;
  let all = []; try { all = JSON.parse(localStorage.getItem(BOOTLOG_KEY) || '[]'); } catch { all = []; }
  const two = n => String(n).padStart(2, '0'), when = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
  el.textContent = all.slice(0, 2).map((x, i) => `${i ? '前回' : '今回'} ${when(x.at)} ${String(x.ver || '').replace('cat-survey-', '')}\n` + x.m.map(([k, t]) => `  ${(t / 1000).toFixed(1)}秒 ${k}`).join('\n')).join('\n') || '(まだありません)';
}
// ---- 起動(20261027-0731)----
// 起動を段に分け、どの段が失敗しても残りの段は続ける(前は1か所の誤りで、その後の送信・未送信の数・選択肢の取り直し・サービスワーカーの登録が止まった)。
// 失敗した段があれば、上に案内と「開き直す」を出し、自動の誤りに控える。最後まで来たら catBooted の印(index.html の見張りが12秒で案内を出す)。
function showBootMsg(text) {
  const m = document.getElementById('bootmsg'); if (!m) return;
  m.querySelector('.boottext').textContent = text || '起動の途中で、一部がうまく動きませんでした。おかしな所があれば「開き直す」を押してください(この端末の記録は消えていません)。';
  m.classList.remove('hidden');
}
function bootFail(name, e) { logErr('起動の誤り: ' + name + ' ' + (e && (e.message || e.name) || String(e))); showBootMsg(); }
function bootStep(name, fn) { try { const r = fn(); return r && typeof r.catch === 'function' ? r.catch(e => bootFail(name, e)) : r; } catch (e) { bootFail(name, e); } }
// 公開の直後は、ブラウザの控え(最大10分)で index.html と app.js の版が食い違うことがある。食い違ったら1回だけ読み込み直す(続けては直さない)
function bootVersionOk() {
  const meta = document.querySelector('meta[name="app-ver"]'), v = meta ? meta.content : '';
  if (v === APP_VER) return true;
  const last = Number(sessionStorage.getItem('catSurvey.verReload') || 0);
  if (Date.now() - last > 60000) { sessionStorage.setItem('catSurvey.verReload', String(Date.now())); logErr('版の食い違い: ' + (v || '無し') + ' / ' + APP_VER); location.reload(); return false; }
  showBootMsg('アプリの新しい版の読み込みが揃っていません。少し待ってから「開き直す」を押してください(この端末の記録は消えていません)。');
  return true;   // 読み込み直した後もまだ食い違う時は、案内を出して、そのまま先へ進む
}
bootMark('app.js:読めた');
dbp.then(() => bootMark('端末の入れ物を開いた'), () => bootMark('端末の入れ物を開けない'));
document.addEventListener('DOMContentLoaded', async () => {
  bootMark('画面の部品が揃った');
  if (!bootStep('版の確かめ', bootVersionOk)) return;
  bootStep('サービスワーカー', () => {   // 先に登録する(後の段が失敗しても、新しい版に入れ替われるように)
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
    // サービスワーカーが新しい版に替わったら、「新しい版があります。更新」を出す。「更新」を押した時だけ、すぐ1回読み込み直す。
    // ほかの画面で更新された時は、起動の直後なら1回だけ読み込み直す。使っている途中なら知らせだけ出して「更新」を待つ(20261027-0851)。初めて入った時(前の控えが無い)は読み込み直さない
    const hadCtl = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updAsked) { if (!updReloaded) { updReloaded = true; location.reload(); } return; }
      if (!hadCtl || updQuiet) { updQuiet = false; return; }
      if (inStartup()) return autoUpdate(null);
      showUpdMsg();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => { swReg = reg; watchSw(reg); }).catch(() => {});
    setInterval(() => checkUpdate(false), UPD_EVERY_MS);   // 開いたままでも30分ごとに確かめる
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastUpdCheck > 60000) checkUpdate(false); });   // 前に出した時
  });
  bootStep('入力の欄', buildForm); bootStep('位置', getGps); bootStep('ログインの表示', renderAuth); bootMark(loggedIn() ? 'ログイン済み(通行証あり)' : 'ログインの画面を出した'); bootStep('ログインの部品', loadGsi);
  bootStep('出し直し', () => { const rg = document.getElementById('btn-regsi'); if (rg) rg.onclick = () => { loadGsi(); renderAuth(); };
    document.addEventListener('click', e => { if (e.target.closest('button.regsi')) { loadGsi(); renderAuth(); } }); });   // その場の「Google のボタンを出し直す」(全員の記録・管理・設定)
  bootStep('ボタン', () => {
  let wasOn = loggedIn();   // 通行証・ID トークンの期限が切れた時に、画面を閉じる(開いたままでも、期限が切れたら使えない)
  setInterval(() => { quietRefresh(); renderRelogin(); const on = loggedIn(); if (on === wasOn) return; wasOn = on; renderAuth(); if (!on && auth && !isCard() && navigator.onLine) { try { google.accounts.id.prompt(); } catch { /* 部品が無い時 */ } } }, 20000);
  readCardFromUrl();   // カードの URL(#card=…)で開かれたら、合言葉を URL から消して、暗証番号を聞く
  window.addEventListener('hashchange', readCardFromUrl);   // 開いたままの画面で、もう一度カードをかざした(# だけ変わった)時も同じ
  $('#tab-admin').onclick = onAdminClick; $('#tab-admin').onchange = onAdminChange;
  document.querySelectorAll('#bottomnav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showTab(b.dataset.go));
  $opt('#btn-back').onclick = () => { if (history.state && history.state.d > 0) history.back(); else showTab('home'); };
  $opt('#home-pending-btn').onclick = e => e.currentTarget.classList.contains('zero') ? undefined : busy(e.currentTarget, () => sendPending(false), '送っています…');
  try { history.replaceState({ tab: 'home', d: 0 }, ''); } catch { /* */ }
  window.addEventListener('popstate', e => { if (coatSkipPop) { coatSkipPop = false; return; } const t = (e.state && e.state.tab) || 'home'; showTab(t, true); });
  $('#btn-gps').onclick = getGps;
  $('#btn-pick').onclick = () => startPick('cat', { from: loc, ok: (lat, lng) => { showTab('record'); setLoc(lat, lng, null, '地図'); }, cancel: () => showTab('record') });
  $('#btn-pickok').onclick = () => { if (!pickPin) return; const p = pickPin.getLatLng(), c = pickCtx; setPicking(false); if (c) c.ok(p.lat, p.lng); };
  $('#btn-pickcancel').onclick = () => { const c = pickCtx, back = pickTarget === 'site' ? 'sites' : 'record'; setPicking(false); if (c) c.cancel(); else showTab(back); };
  $('#btn-here').onclick = () => locateMe(false);
  $('#scopebar').onclick = e => { const b = e.target.closest('button[data-scope]'); if (b) busy(b, () => setScope(b.dataset.scope), b.textContent); };
  $('#showdel').onchange = e => { showDeleted = e.target.checked; setScope('all'); };   // 管理者の「削除済みも見る」
  $('#sitesel').onchange = e => onSitePick(e.target.value);
  $('#btn-site-new').onclick = () => {
    if (!loc) return toast('位置が決まってから押してください', 4000);
    openSiteForm({ lat: loc.lat, lng: loc.lng, acc: loc.acc, src: loc.src === 'GPS' ? 'GPS' : '地図' }, async site => { form.siteId = site.id; await renderSiteCands(); });
  };
  $('#btn-site-here').onclick = () => startSiteHere();
  $('#btn-site-pick').onclick = () => startPick('site', { ok: (lat, lng) => { showTab('sites'); openSiteForm({ lat, lng, acc: null, src: '地図' }); }, cancel: () => showTab('sites') });
  $('#sitelist').onclick = e => {
    const b = e.target.closest('button[data-act]'), card = e.target.closest('.site'); if (!b || !card) return; const id = card.dataset.id, a = b.dataset.act;
    if (a === 'rename') openSiteEdit(id); else if (a === 'retire') busy(b, () => setSiteRetired(id, true)); else if (a === 'restore') busy(b, () => setSiteRetired(id, false));
    else if (a === 'del') busy(b, () => deleteSite(id), '削除しています…'); else if (a === 'undel') busy(b, () => restoreSite(id, card.dataset.owner || ''), '戻しています…');
    else if (a === 'map') viewSites().then(ss => { const x = ss.find(y => y.id === id); if (x) { mapFocus = { lat: x.lat, lng: x.lng }; showTab('map'); } });
  };
  $('#photo-cam').onchange = $('#photo-pick').onchange = onPhoto;
  $('#thumbs').onclick = e => { const im = e.target.closest('img[data-zoom]'); if (im) return openViewer(photos, +im.dataset.zoom); const b = e.target.closest('button'); if (!b) return; photos.splice(+b.dataset.i, 1); renderThumbs(); };
  $('#btn-save').onclick = saveRecord;
  $opt('#lchips').onclick = e => { const b = e.target.closest('button[data-chip]'); if (b) { listChip = b.dataset.chip; renderList(); } };
  $('#list').addEventListener('toggle', e => { const d = e.target; if (d.classList && d.classList.contains('sgroup')) { if (d.open) listOpen.add(d.dataset.gk); else listOpen.delete(d.dataset.gk); } }, true);
  document.querySelectorAll('.showgone').forEach(c => c.onchange = () => { showGone = c.checked; renderActiveTab(); });
  $('#list').onclick = e => {
    const cb = e.target.closest('button[data-change]'); if (cb) return openChange(cb.dataset.change);
    const rb = e.target.closest('button[data-restore]'); if (rb) return busy(rb, () => restoreRecord(rb.dataset.restore), '戻しています…');
    if (phClick(e)) return;   // 受け付けの写真の再読み込み・拡大(1800)
    const zi = e.target.closest('img[data-zoom-id]'); if (zi) return recById(zi.dataset.zoomId).then(r => r && r.photos && r.photos.length && openViewer(r.photos, 0));   // 一覧の小さな絵: 押すと大きく(記録は開かない)
    const it = e.target.closest('.item[data-id]'); if (it) openDetail(it.dataset.id);
  };
  $('#list').onkeydown = e => { if (e.key !== 'Enter' && e.key !== ' ') return; const it = e.target.closest('.item'); if (it) { e.preventDefault(); openDetail(it.dataset.id); } };
  $('#btn-send').onclick = e => busy(e.currentTarget, () => sendPending(false), '送っています…');
  $('#btn-refresh').onclick = e => busy(e.currentTarget, () => refreshFromServer(false).catch(err => toast(dbErrText(err), 6000)), '取り直しています…');
  $('#btn-logout').onclick = logout;
  });
  bootStep('版の知らせ', () => {
  $opt('#btn-update').onclick = doUpdate;
  $opt('#appver').textContent = APP_VER.replace('cat-survey-', '');
  $opt('#btn-vercheck').onclick = e => busy(e.currentTarget, () => checkUpdate(true), '確かめています…');
  });
  bootStep('不具合の知らせ', () => {
  $opt('#btn-bug').onclick = () => openBugForm();
  $opt('#btn-bugmine').onclick = e => busy(e.currentTarget, openBugMine, '読み込んでいます…');
  $opt('#autoerr').checked = autoErrOn(); $opt('#autoerr').onchange = e => { saveCfg({ autoErr: e.target.checked }); toast(e.target.checked ? 'アプリの誤りを自動で知らせます' : 'アプリの誤りを自動で知らせるのを止めました'); };
  });
  bootStep('そのほかのボタン', () => {
  if (CONF.SHOW_DEMO || new URLSearchParams(location.search).has('demo')) $('#btn-demo').classList.remove('hidden');
  $('#btn-demo').onclick = demo;
  $('#btn-clear').onclick = async () => { if (confirm('この端末の記録を、すべて消します。よろしいですか?')) { await clearAll(); await updateBadge(); renderList(); toast('消しました'); } };
  window.addEventListener('online', () => { toast('電波が戻りました。未送信を送ります'); syncQuiet(); refreshMeta(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !autoP && Date.now() - lastRefreshAt >= AUTO_REFRESH_MS) syncQuiet(); });   // 画面に戻ってきた時(前の取り直しから5分以上)
  });
  try { const n = await migrateOld(); if (n) toast(`以前の版の記録${n}件を引き継ぎました`); } catch { toast('以前の記録を引き継げませんでした(元の記録は残してあります)', 6000); }
  bootStep('未送信の数', () => Promise.resolve(updateBadge()).then(() => bootMark('未送信の数を数えた')));
  bootStep('選択肢と役割', () => { bootMark('受け付け:初めの呼び出し'); return Promise.resolve(refreshMeta()).then(() => bootMark('受け付け:初めの返事')); });   // 開いた時に、選択肢と役割を取り直す(次に開いた時から新しい選択肢が出る)
  bootStep('送信', syncQuiet); // 開いた時に、未送信があって電波があれば送る
  window.catBooted = true; bootMark('起動の終わり'); renderBootLog();
});
