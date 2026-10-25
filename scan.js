// ホーム画面への追加の案内 と アプリの中で読むカードの QR 読み取り(jsQR=lib/jsQR.js を端末の中で使う。外のサービスは使わない)。
// app.js より前に読み込む。showSheet・closeSheet・cardSecret・openCardPin・loggedIn・esc・$ は app.js のものを、呼ばれた時に使う。
(function () {
  const UA = navigator.userAgent || '';
  const iOS = () => /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = () => /Android/.test(UA);
  const standalone = () => { try { return !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; } catch { return navigator.standalone === true; } };
  // 開いている所: standalone(ホーム画面のアプリ)/ safari / inapp(QR リーダー・LINE などの中の小さなブラウザ)/ other(Chrome など)
  function envKind() {
    if (standalone()) return 'standalone';
    if (iOS()) {
      if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(UA)) return 'other';
      if (/Line\/|FBAN|FBAV|Instagram|MicroMessenger|Twitter|KAKAOTALK|; wv\)/.test(UA) || !/Safari\//.test(UA)) return 'inapp';
      return 'safari';
    }
    return 'other';
  }
  const CARD_ORIGIN = 'https://cats.ikezos.com';
  // QR の文字がこのアプリのカードの URL なら合言葉を返す(違えば null)
  function parseCard(text) {
    let u; try { u = new URL(String(text).trim()); } catch { return null; }
    if (u.origin !== location.origin && u.origin !== CARD_ORIGIN) return null;
    const m = /^#card=([^&]+)$/.exec(u.hash || ''); if (!m) return null;
    let s = m[1]; try { s = decodeURIComponent(s); } catch { /* そのまま */ }
    return /^[A-Za-z0-9_-]{20,64}$/.test(s) ? s : null;
  }

  // ---- 絵(SVG) ----
  const SHARE = '<svg class="gi" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="18" width="32" height="26" rx="4" fill="none" stroke="#0a60ff" stroke-width="3"/><path d="M24 30V5M15 13l9-9 9 9" fill="none" stroke="#0a60ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ADDROW = '<svg class="gi wide" viewBox="0 0 200 48" aria-hidden="true"><rect x="1" y="1" width="198" height="46" rx="8" fill="#fff" stroke="#999"/><text x="14" y="30" font-size="16" fill="#222">ホーム画面に追加</text><rect x="160" y="10" width="28" height="28" rx="6" fill="none" stroke="#222" stroke-width="2.5"/><path d="M174 17v14M167 24h14" stroke="#222" stroke-width="2.5" stroke-linecap="round"/></svg>';
  const COMPASS = '<svg class="gi" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="none" stroke="#0a60ff" stroke-width="3"/><path d="M33 15l-6 12-12 6 6-12z" fill="#0a60ff"/></svg>';
  const MENU3 = '<svg class="gi" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="10" r="3.5"/><circle cx="24" cy="24" r="3.5"/><circle cx="24" cy="38" r="3.5"/></svg>';
  const ICONS = { SHARE, ADDROW, COMPASS, MENU3 };

  // ---- iPhone の案内(カードの URL が、ホーム画面のアプリでない所で開かれた時) ----
  function needsHomeGuide() { return iOS() && envKind() !== 'standalone'; }
  function showHomeGuide(onGo) {
    const inapp = envKind() === 'inapp';
    showSheet(`<div class="sheethead"><b>先にホーム画面に追加してください</b></div>
    <div class="sheetbody"><div class="card homeguide" id="homeguide">
    <h3 class="big">iPhone の方は、先に「ホーム画面に追加」をしてください</h3>
    <p>このまま番号を入れてログインしても、<b>次に開く時にまたログインが必要</b>になります(iPhone は、カメラから開いた画面とホーム画面のアプリで、ログインを引き継げないためです)。</p>
    ${inapp ? `<div class="gstep"><span class="gn">1</span>${COMPASS}<p><b>右下の Safari のマーク</b>で、Safari で開き直してください。(開けない時は、このページの URL を Safari に貼ります)</p></div>` : ''}
    <div class="gstep"><span class="gn">${inapp ? 2 : 1}</span>${SHARE}<p>Safari の下(または右上)の<b>共有ボタン</b>を押します。</p></div>
    <div class="gstep"><span class="gn">${inapp ? 3 : 2}</span>${ADDROW}<p>出てきた一覧を下にすべらせ、<b>「ホーム画面に追加」</b>を押して、右上の「追加」を押します。</p></div>
    <div class="gstep"><span class="gn">${inapp ? 4 : 3}</span><p>ホーム画面にできた<b>アプリのアイコン</b>を開き、<b>「カードの QR を読む」</b>を押して、カードの QR を読みます。(カードは手元に置いたままにしてください)</p></div>
    <button type="button" id="hg-cancel" class="primary">わかった(閉じる)</button>
    <button type="button" id="hg-go" class="wide">このままログインする</button>
    <p class="note">「このままログイン」を選ぶと、次にこのアプリを開いた時に、もう一度カードの QR を読む必要が出ることがあります。</p>
    </div></div>`);
    $('#hg-cancel').onclick = () => { closeSheet(); };
    $('#hg-go').onclick = () => { onGo(); };
  }

  // ---- カードの QR を読む ----
  let stream = null, timer = 0, scanning = false;
  function stopCamera() {
    scanning = false; clearTimeout(timer); timer = 0;
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch { /* 済み */ } stream = null; }
    const v = document.getElementById('scan-video'); if (v) { try { v.srcObject = null; } catch { /* 無い時 */ } }
  }
  function setMsg(t, warn) { const el = document.getElementById('scan-msg'); if (!el) return; el.textContent = t || ''; el.classList.toggle('hidden', !t); el.classList.toggle('warn', !!warn); }
  function failView(kind) {
    const iosT = iOS();
    const body = kind === 'denied'
      ? `<h3>カメラが許可されていません</h3><p>QR を読むには、カメラを使う許可が要ります。</p>
         ${iosT ? '<p><b>iPhone:</b> 「設定」アプリ →「Safari」→「カメラ」を「確認」か「許可」にします。そのあと、このアプリを一度閉じて開き直し、もう一度「カードの QR を読む」を押してください。(許可の画面で「許可しない」を押した時も、同じ手順です)</p>'
         : '<p><b>Android:</b> アドレスバー左の鍵(または設定)のマークから「権限」→「カメラ」を「許可」にして、開き直してください。ホーム画面のアプリの時は、「設定」→「アプリ」→ このアプリ →「権限」→「カメラ」です。</p>'}`
      : kind === 'secure' ? '<h3>ここではカメラを使えません</h3><p>安全な接続(https)のページでだけ、カメラが使えます。カードをスマホにかざすか、Safari で開き直してください。</p>'
      : '<h3>カメラが見つかりません</h3><p>この端末ではカメラを開けませんでした。カードをスマホの裏にかざす(NFC)か、スマホのカメラ(標準アプリ)でカードの QR を読んでください。</p>';
    showSheet(`<div class="sheethead"><b>カードの QR を読む</b></div><div class="sheetbody"><div class="card" id="scan-fail" data-kind="${kind}">${body}
      <button type="button" id="scan-retry" class="primary">もう一度ためす</button><button type="button" id="scan-close" class="wide">閉じる</button></div></div>`);
    $('#scan-retry').onclick = () => openScanner(); $('#scan-close').onclick = () => closeSheet();
  }
  async function openScanner() {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return failView(window.isSecureContext === false ? 'secure' : 'nocam');
    showSheet(`<div class="sheethead"><b>カードの QR を読む</b></div><div class="sheetbody"><div class="card">
      <p class="note">カードの QR コードが、四角い枠の中に入るようにしてください。読めると自動で次へ進みます。映像は端末の中だけで使い、送りません。</p>
      <div class="scanbox"><video id="scan-video" playsinline muted autoplay></video><div class="scanframe"></div></div>
      <p id="scan-msg" class="hidden" role="status"></p>
      <button type="button" id="scan-cancel" class="wide">やめる</button></div></div>`);
    $('#scan-cancel').onclick = () => { stopCamera(); closeSheet(); };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      stream = null;
      return failView(e && /NotAllowed|Security|Permission/i.test(e.name || '') ? 'denied' : 'nocam');
    }
    const v = document.getElementById('scan-video');
    if (!v) { stopCamera(); return; }   // 待っている間に閉じられた
    v.srcObject = stream; try { await v.play(); } catch { /* 自動再生 */ }
    scanning = true; const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    let lastBad = '', badAt = 0;
    const tick = () => {
      if (!scanning) return;
      if (!document.getElementById('scan-video')) return stopCamera();   // 画面が閉じられた
      if (v.videoWidth > 0 && v.readyState >= 2) {
        const sc = Math.min(1, 640 / v.videoWidth); cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc);
        cx.drawImage(v, 0, 0, cv.width, cv.height);
        let r = null; try { r = jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, { inversionAttempts: 'dontInvert' }); } catch { /* 読めない枠 */ }
        if (r && r.data) {
          const secret = parseCard(r.data);
          if (secret) { stopCamera(); closeSheet(); cardSecret = secret; openCardPin(); return; }
          if (r.data !== lastBad || Date.now() - badAt > 4000) { lastBad = r.data; badAt = Date.now(); setMsg('このアプリのカードではありません。ログインカードの QR を読んでください', true); }
        } else if (badAt && Date.now() - badAt > 4000) { setMsg(''); badAt = 0; lastBad = ''; }
      }
      timer = setTimeout(tick, 120);
    };
    tick();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && scanning) { stopCamera(); if (document.getElementById('scan-video')) closeSheet(); } });
  window.addEventListener('pagehide', stopCamera);

  // ---- Android: ログインの後に「ホーム画面に追加」を1回 ----
  let deferred = null, hintShown = false, hintDone = false; const HK = 'catSurvey.installHinted';
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; refresh(); });
  window.addEventListener('appinstalled', () => { try { localStorage.setItem(HK, '1'); } catch { /* 保存できない */ } deferred = null; hintDone = true; refresh(); });
  function wantInstallHint() {
    if (!(typeof loggedIn === 'function' && loggedIn())) return false;
    if (standalone() || iOS()) return false;
    if (!(android() || deferred)) return false;
    if (hintDone) return false; if (hintShown) return true;   // 出している間は出したまま(閉じた・追加した後は出さない)
    try { return !localStorage.getItem(HK); } catch { return false; }
  }
  function renderInstallHint() {
    let box = document.getElementById('installhint');
    if (!wantInstallHint()) { if (box) box.classList.add('hidden'); return; }
    if (!box) { box = document.createElement('div'); box.id = 'installhint'; box.className = 'card installhint'; const t = document.getElementById('tab-record'); t.insertBefore(box, t.firstChild); }
    box.classList.remove('hidden');
    box.innerHTML = `<h3>ホーム画面に追加すると、次から開きやすくなります</h3>
      ${deferred ? '<button type="button" id="ih-add" class="primary">ホーム画面に追加する</button>' : `<div class="gstep"><span class="gn">1</span>${MENU3}<p>Chrome の右上の<b>「︙」</b>を押します。</p></div><div class="gstep"><span class="gn">2</span><p><b>「ホーム画面に追加」</b>(または「アプリをインストール」)を押します。</p></div>`}
      <button type="button" id="ih-later" class="wide">閉じる</button>`;
    hintShown = true; try { localStorage.setItem(HK, '1'); } catch { /* 保存できない */ }   // 1回だけ出す(この画面を閉じるまでは出たまま)
    const ad = document.getElementById('ih-add');
    if (ad) ad.onclick = async () => { const d = deferred; deferred = null; try { d.prompt(); await d.userChoice; } catch { /* 断られた */ } hintDone = true; box.classList.add('hidden'); };
    document.getElementById('ih-later').onclick = () => { hintDone = true; box.classList.add('hidden'); };
  }

  // ---- ログインの画面の「カードの QR を読む」ボタンの置き場所: ホーム画面のアプリでは一番上、それ以外はカードの欄 ----
  function placeScanButton() {
    const b = document.getElementById('scanbox-btn'); if (!b) return;
    const lc = document.getElementById('logincard'), cl = document.getElementById('cardlogin');
    if (standalone()) { if (b.parentNode !== lc || lc.firstElementChild !== b) lc.insertBefore(b, lc.firstChild); b.classList.add('first'); }
    else { if (b.parentNode !== cl) cl.appendChild(b); b.classList.remove('first'); }
    const btn = document.getElementById('btn-scan'); if (btn && !btn.onclick) btn.onclick = openScanner;
  }
  function refresh() { placeScanButton(); renderInstallHint(); }

  window.CardKit = { envKind, parseCard, needsHomeGuide, showHomeGuide, openScanner, stopCamera, refresh, ICONS };
  document.addEventListener('DOMContentLoaded', placeScanButton);
})();
