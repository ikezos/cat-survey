/* qr.js — QR コードの符号化(ISO/IEC 18004。バイトモード・型番 1〜10・誤り訂正 L/M/Q/H)。
 * 外部のサービスや他のライブラリに頼らず、端末の中だけで QR を作る(ログインカードの合言葉を外に出さないため)。
 * 使い方: const q = QR.encode('https://…', 'M'); → { size, get(x, y) → true=黒 }  / QR.draw(canvas, text, { ecl:'M', scale:6, quiet:4 })
 * 試し: tools/qr-check.py が、ここで作った画像を OpenCV の QRCodeDetector で読み戻し、元の文字と一致するかを確かめる。
 * 2026-10-25 バークレー。参考にした構成: 仕様書の手順(データ符号化 → RS 符号 → ブロックの交互配置 → 配置 → マスク評価 → 形式情報)。 */
(function (root) {
  'use strict';
  var ECL = { L: 1, M: 0, Q: 3, H: 2 };   // 形式情報に入れる値
  // 誤り訂正の表(型番 1〜10)。[L, M, Q, H] の順。(仕様書の表 9 から)
  var EC_PER_BLOCK = {   // 1ブロックあたりの誤り訂正コード語の数
    L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24], H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28] };
  var NUM_BLOCKS = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5], Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8], H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8] };
  var MAX_VERSION = 10;

  // 型番 → 一辺のモジュール数・データ領域のビット数
  function sizeOf(ver) { return ver * 4 + 17; }
  function rawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(ver, ecl) { return Math.floor(rawDataModules(ver) / 8) - EC_PER_BLOCK[ecl][ver - 1] * NUM_BLOCKS[ecl][ver - 1]; }

  // UTF-8 のバイト列
  function utf8(s) { var out = [], e = unescape(encodeURIComponent(s)); for (var i = 0; i < e.length; i++) out.push(e.charCodeAt(i)); return out; }

  /* ---- GF(256)(原始多項式 0x11D)と Reed-Solomon ---- */
  function gfMul(a, b) { var r = 0; while (b) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11D; b >>= 1; } return r & 0xFF; }
  function rsGenerator(deg) {
    var g = [1], root = 1;
    for (var i = 0; i < deg; i++) {
      var ng = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) { ng[j] ^= gfMul(g[j], root); ng[j + 1] ^= g[j]; }
      g = ng; root = gfMul(root, 2);
    }
    // g は低い次数から並んでいる(g[deg] = 1 が最高次)。割り算で使うため、最高次の 1 を除いて高い次数から並べ直す(長さ deg)
    return g.slice(0, deg).reverse();
  }
  function rsRemainder(data, gen) {
    var res = new Array(gen.length).fill(0);
    for (var i = 0; i < data.length; i++) {
      var f = data[i] ^ res.shift(); res.push(0);
      for (var j = 0; j < res.length; j++) res[j] ^= gfMul(gen[j], f);
    }
    return res;
  }

  /* ---- データの符号化(バイトモード)---- */
  function pickVersion(nBytes, ecl) {
    for (var v = 1; v <= MAX_VERSION; v++) { var bits = 4 + (v <= 9 ? 8 : 16) + nBytes * 8; if (bits <= dataCodewords(v, ecl) * 8) return v; }
    return 0;
  }
  function buildCodewords(bytes, ver, ecl) {
    var bits = [], push = function (val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach(function (b) { push(b, 8); });
    var cap = dataCodewords(ver, ecl) * 8;
    push(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    var data = []; for (var i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    // ブロックに分けて RS、交互配置
    var nb = NUM_BLOCKS[ecl][ver - 1], ecLen = EC_PER_BLOCK[ecl][ver - 1], total = Math.floor(rawDataModules(ver) / 8);
    var shortLen = Math.floor(total / nb) - ecLen, nShort = nb - (total % nb), gen = rsGenerator(ecLen), blocks = [], k = 0;
    for (var b = 0; b < nb; b++) { var len = shortLen + (b < nShort ? 0 : 1), d = data.slice(k, k + len); k += len; blocks.push({ d: d, e: rsRemainder(d, gen) }); }
    var out = [];
    for (var i2 = 0; i2 <= shortLen; i2++) blocks.forEach(function (bl) { if (i2 < bl.d.length) out.push(bl.d[i2]); });
    for (var j = 0; j < ecLen; j++) blocks.forEach(function (bl) { out.push(bl.e[j]); });
    return out;
  }

  /* ---- モジュールの配置 ---- */
  function Matrix(size) { this.size = size; this.m = new Array(size * size).fill(0); this.fixed = new Array(size * size).fill(false); }
  Matrix.prototype.set = function (x, y, v, fixed) { if (x < 0 || y < 0 || x >= this.size || y >= this.size) return; this.m[y * this.size + x] = v ? 1 : 0; if (fixed) this.fixed[y * this.size + x] = true; };
  Matrix.prototype.get = function (x, y) { return this.m[y * this.size + x] === 1; };
  Matrix.prototype.isFixed = function (x, y) { return this.fixed[y * this.size + x]; };

  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2, size = sizeOf(ver), step = ver === 32 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2, out = [6];
    for (var p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
    return out;
  }
  function drawFinder(M, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var d = Math.max(Math.abs(dx), Math.abs(dy)); M.set(cx + dx, cy + dy, d !== 2 && d !== 4, true);
    }
  }
  function drawFunctionPatterns(M, ver, ecl, mask) {
    var s = M.size;
    for (var i = 0; i < s; i++) { M.set(6, i, i % 2 === 0, true); M.set(i, 6, i % 2 === 0, true); }   // タイミング
    drawFinder(M, 3, 3); drawFinder(M, s - 4, 3); drawFinder(M, 3, s - 4);
    var ap = alignPositions(ver);
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === ap.length - 1) || (a === ap.length - 1 && b === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) M.set(ap[a] + dx, ap[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, true);
    }
    drawFormat(M, ecl, mask);
    if (ver >= 7) drawVersion(M, ver);
  }
  // 形式情報: 5 ビット(誤り訂正 2 + マスク 3)+ BCH(15,5) の 10 ビット、0x5412 でマスク
  function drawFormat(M, ecl, mask) {
    var data = (ECL[ecl] << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, s = M.size, bit = function (i) { return ((bits >>> i) & 1) === 1; };
    for (var j = 0; j <= 5; j++) M.set(8, j, bit(j), true);
    M.set(8, 7, bit(6), true); M.set(8, 8, bit(7), true); M.set(7, 8, bit(8), true);
    for (var k = 9; k < 15; k++) M.set(14 - k, 8, bit(k), true);
    for (var l = 0; l < 8; l++) M.set(s - 1 - l, 8, bit(l), true);
    for (var n = 8; n < 15; n++) M.set(8, s - 15 + n, bit(n), true);
    M.set(8, s - 8, true, true);   // 常に黒
  }
  // 型番情報(型番 7 以上): 6 ビット + BCH(18,6) の 12 ビット
  function drawVersion(M, ver) {
    var rem = ver; for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (ver << 12) | rem, s = M.size;
    for (var j = 0; j < 18; j++) { var b = ((bits >>> j) & 1) === 1, a = s - 11 + j % 3, c = Math.floor(j / 3); M.set(a, c, b, true); M.set(c, a, b, true); }
  }
  // データのビットを、右下から2列ずつジグザグに置く(機能パターンの所は飛ばす)
  function drawData(M, codewords) {
    var s = M.size, i = 0, total = codewords.length * 8;
    for (var right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < s; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, up = ((right + 1) & 2) === 0, y = up ? s - 1 - vert : vert;
          if (!M.isFixed(x, y) && i < total) { M.set(x, y, (codewords[i >>> 3] >>> (7 - (i & 7))) & 1); i++; }
        }
      }
    }
  }
  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x, y) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; }, function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
    function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; }, function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }];
  function applyMask(M, mask) { for (var y = 0; y < M.size; y++) for (var x = 0; x < M.size; x++) if (!M.isFixed(x, y) && MASKS[mask](x, y)) M.m[y * M.size + x] ^= 1; }
  // マスクの評価(仕様書の 4 つの減点)
  function penalty(M) {
    var s = M.size, p = 0, x, y, run, prev, dark = 0;
    var finderLike = function (hist) { var n = hist[1]; return n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n && (hist[0] >= n * 4 || hist[6] >= n * 4) ? 1 : 0; };
    var line = function (getter) {
      var hist = [0, 0, 0, 0, 0, 0, 0], color = false, cnt = 0, pen = 0;
      var addRun = function (c, n) { hist.shift(); hist.push(n); if (!c) pen += finderLike(hist); };
      for (var i = 0; i < s; i++) { var c = getter(i); if (c === color) { cnt++; if (cnt === 5) pen += 3; else if (cnt > 5) pen++; } else { addRun(color, cnt); color = c; cnt = 1; } }
      addRun(color, cnt); if (color) { addRun(false, 0); }   // 終端
      hist.shift(); hist.push(4); if (!color) pen += finderLike(hist); // 外側の白い余白(4 以上)を見立てる
      return pen;
    };
    for (y = 0; y < s; y++) p += line(function (i) { return M.get(i, y); });
    for (x = 0; x < s; x++) p += line(function (i) { return M.get(x, i); });
    for (y = 0; y < s - 1; y++) for (x = 0; x < s - 1; x++) { var c = M.get(x, y); if (c === M.get(x + 1, y) && c === M.get(x, y + 1) && c === M.get(x + 1, y + 1)) p += 3; }
    for (y = 0; y < s; y++) for (x = 0; x < s; x++) if (M.get(x, y)) dark++;
    var k = Math.ceil(Math.abs(dark * 20 - s * s * 10) / (s * s)) - 1; p += Math.max(0, k) * 10;
    return p;
  }

  function encode(text, ecl, forceMask) {
    ecl = ecl || 'M'; if (!(ecl in ECL)) throw new Error('bad ecl');
    var bytes = utf8(String(text)), ver = pickVersion(bytes.length, ecl);
    if (!ver) throw new Error('too long for QR version ' + MAX_VERSION);
    var cw = buildCodewords(bytes, ver, ecl), best = null, bestPen = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      if (forceMask != null && mask !== forceMask) continue;
      var M = new Matrix(sizeOf(ver)); drawFunctionPatterns(M, ver, ecl, mask); drawData(M, cw); applyMask(M, mask);
      var pen = penalty(M); if (pen < bestPen) { bestPen = pen; best = M; best.mask = mask; }
    }
    return { size: best.size, version: ver, ecl: ecl, mask: best.mask, get: function (x, y) { return best.get(x, y); }, matrix: best };
  }
  // canvas に描く(scale = 1モジュールのピクセル・quiet = 余白のモジュール数)
  function draw(canvas, text, opt) {
    opt = opt || {}; var q = encode(text, opt.ecl || 'M'), scale = opt.scale || 6, quiet = opt.quiet == null ? 4 : opt.quiet, px = (q.size + quiet * 2) * scale;
    canvas.width = px; canvas.height = px;
    var ctx = canvas.getContext('2d'); ctx.fillStyle = opt.light || '#fff'; ctx.fillRect(0, 0, px, px); ctx.fillStyle = opt.dark || '#000';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    return q;
  }
  // 試し用: PBM(P1)の文字列(OpenCV で読み戻す)
  function toPBM(q, quiet) {
    quiet = quiet == null ? 4 : quiet; var n = q.size + quiet * 2, lines = ['P1', n + ' ' + n];
    for (var y = -quiet; y < q.size + quiet; y++) { var row = []; for (var x = -quiet; x < q.size + quiet; x++) row.push(x >= 0 && y >= 0 && x < q.size && y < q.size && q.get(x, y) ? '1' : '0'); lines.push(row.join(' ')); }
    return lines.join('\n') + '\n';
  }
  var QR = { encode: encode, draw: draw, toPBM: toPBM, MAX_VERSION: MAX_VERSION, _encodeWithMask: function (t, e, m) { return encode(t, e, m); } };   // _encodeWithMask は試し(別実装との突き合わせ)用
  if (typeof module !== 'undefined' && module.exports) module.exports = QR; else root.QR = QR;
})(typeof window !== 'undefined' ? window : this);
