'use strict';
// =====================================================================
// ブラックボックスの表示: Canvas 2D で描く小さな 3D エンジンと、5 種類の表示
//
// 座標はバイク基準: x = 前, y = 左, z = 上 (右手系)
// 解析結果 (blackbox.js の analyzeLog) を受け取って描く。
// =====================================================================

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180;
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vLen = a => Math.hypot(a[0], a[1], a[2]);
const vNorm = a => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ロール(x)・ピッチ(y)・ヨー(z) から回転行列 (R = Rz * Ry * Rx)
function eulerMatrix(r, p, y) {
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp,     cp * sr,                cp * cr],
  ];
}
const mulMV = (m, v) => [vDot(m[0], v), vDot(m[1], v), vDot(m[2], v)];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 時間の経過で色を変える (青 → 赤)
function timeColor(f) {
  return `hsl(${Math.round(220 - 220 * f)}, 75%, 52%)`;
}

// ---------------------------------------------------------------------
// 3D 描画 (透視投影・ドラッグで回転・ホイール/ピンチで拡大)
// ---------------------------------------------------------------------
class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.az = 200 * DEG;
    this.el = 20 * DEG;
    this.dist = 4;
    this.target = [0, 0, 0];
    this.fov = 45 * DEG;
    this.enabled = true;     // false のときドラッグで回さない (グラフ表示)
    this.onChange = null;
    this._initPointer();
  }

  setCamera(azDeg, elDeg, dist, target) {
    this.az = azDeg * DEG;
    this.el = elDeg * DEG;
    this.dist = dist;
    this.target = target;
  }

  _initPointer() {
    const c = this.canvas;
    const pts = new Map();
    let pinch = 0;
    c.addEventListener('pointerdown', e => {
      if (!this.enabled) return;
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    c.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) {
        this.az -= (e.clientX - p.x) * 0.01;
        this.el = clamp(this.el + (e.clientY - p.y) * 0.01, -1.5, 1.5);
      }
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.dist = clamp(this.dist * pinch / d, 0.5, 60);
        pinch = d;
      }
      if (this.onChange) this.onChange();
    });
    const up = e => { pts.delete(e.pointerId); pinch = 0; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      if (!this.enabled) return;
      e.preventDefault();
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), 0.5, 60);
      if (this.onChange) this.onChange();
    }, { passive: false });
  }

  begin() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.w = w; this.h = h;

    const ce = Math.cos(this.el);
    this.cam = vAdd(this.target, vScale([ce * Math.cos(this.az), ce * Math.sin(this.az), Math.sin(this.el)], this.dist));
    this.f = vNorm(vSub(this.target, this.cam));
    let r = vCross(this.f, [0, 0, 1]);
    if (vLen(r) < 1e-6) r = [0, -1, 0];
    this.r = vNorm(r);
    this.u = vCross(this.r, this.f);
    // 縦長の画面 (スマホ) でも左右が切れないよう、短い辺に合わせる
    this.focal = (Math.min(w, h) / 2) / Math.tan(this.fov / 2);
  }

  project(p) {
    const d = vSub(p, this.cam);
    const z = vDot(d, this.f);
    if (z < 0.05) return null;
    return [this.w / 2 + this.focal * vDot(d, this.r) / z, this.h / 2 - this.focal * vDot(d, this.u) / z, z];
  }

  line(a, b, color, width = 1) {
    const pa = this.project(a), pb = this.project(b);
    if (!pa || !pb) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.stroke();
  }

  polyline(points, color, width = 1, closed = false) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let open = false;
    for (const p of points) {
      const q = this.project(p);
      if (!q) { open = false; continue; }
      if (open) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); open = true; }
    }
    if (closed && points.length) {
      const q = this.project(points[0]);
      if (q && open) ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
  }

  dot(p, radius, color) {
    const q = this.project(p);
    if (!q) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(q[0], q[1], radius, 0, Math.PI * 2);
    ctx.fill();
  }

  label(p, text, color, align = 'center') {
    const q = this.project(p);
    if (!q) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, q[0], q[1]);
  }

  arrow(from, to, color, width = 3) {
    const a = this.project(from), b = this.project(to);
    if (!a || !b) return;
    const ctx = this.ctx;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const head = Math.min(12, len * 0.4);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0] - Math.cos(ang) * head * 0.6, b[1] - Math.sin(ang) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - Math.cos(ang - 0.45) * head, b[1] - Math.sin(ang - 0.45) * head);
    ctx.lineTo(b[0] - Math.cos(ang + 0.45) * head, b[1] - Math.sin(ang + 0.45) * head);
    ctx.closePath();
    ctx.fill();
  }

  // 画面左上に文字を重ねる
  hud(lines, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((t, i) => ctx.fillText(t, 10, 8 + i * 18));
  }
}

// ---------------------------------------------------------------------
// バイクの形 (バイク基準の座標, 単位はおおよそメートル・ホイールベース 1.24)
// 接地点が原点。ライダーはシートの位置を中心に、サーボ角ぶん内側へ傾ける。
// ---------------------------------------------------------------------
function wheelPoints(cx, cz, r, y, n = 24) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n * Math.PI * 2;
    pts.push([cx + r * Math.cos(t), y, cz + r * Math.sin(t)]);
  }
  return pts;
}

const BIKE = {
  wheels: [
    wheelPoints(0.62, 0.3, 0.3, 0.06), wheelPoints(0.62, 0.3, 0.3, -0.06),
    wheelPoints(-0.62, 0.3, 0.3, 0.07), wheelPoints(-0.62, 0.3, 0.3, -0.07),
  ],
  frame: [
    [[-0.62, 0, 0.3], [-0.12, 0, 0.42], [0.42, 0, 0.88], [0.62, 0, 0.3]],          // スイングアーム・フレーム・フォーク
    [[-0.12, 0, 0.42], [0.3, 0, 0.32], [0.5, 0, 0.62]],                             // エンジン下・カウル
    [[-0.55, 0, 0.82], [-0.08, 0, 0.8], [0.22, 0, 0.92], [0.42, 0, 0.88]],          // シート・タンク
    [[-0.55, 0, 0.82], [-0.12, 0, 0.42]],
    [[0.4, 0.26, 0.93], [0.4, -0.26, 0.93]],                                        // ハンドル
    [[0.42, 0, 0.88], [0.6, 0, 0.75], [0.5, 0, 0.62]],                              // フロントカウル
  ],
  seat: [-0.2, 0, 0.84],
  rider: {
    body:  [[-0.2, 0, 0.84], [0.12, 0, 1.18]],
    arms:  [[[0.12, 0, 1.18], [0.4, 0.24, 0.95]], [[0.12, 0, 1.18], [0.4, -0.24, 0.95]]],
    legs:  [[[-0.2, 0, 0.84], [0.12, 0.26, 0.62], [-0.12, 0.17, 0.42]], [[-0.2, 0, 0.84], [0.12, -0.26, 0.62], [-0.12, -0.17, 0.42]]],
    head:  [0.24, 0, 1.3],
  },
};

// ---------------------------------------------------------------------
// 表示本体
// ---------------------------------------------------------------------
const CAMERAS = {
  // 表示ごとに [方位角, 仰角, 距離, 注視点]
  pose:   { rear: [180, 10, 2.8, [0, 0, 0.6]], side: [90, 6, 3.0, [0, 0, 0.6]], front: [0, 10, 2.8, [0, 0, 0.6]], top: [180, 82, 3.2, [0, 0, 0.4]], iso: [215, 22, 3.0, [0, 0, 0.6]] },
  gg:     { rear: [180, 8, 4.2, [0, 0, 0]], side: [90, 8, 4.2, [0, 0, 0]], front: [0, 8, 4.2, [0, 0, 0]], top: [180, 85, 4.2, [0, 0, 0]], iso: [215, 25, 4.4, [0, 0, 0]] },
  sphere: { rear: [180, 12, 3.6, [0, 0, 0.3]], side: [90, 12, 3.6, [0, 0, 0.3]], front: [0, 12, 3.6, [0, 0, 0.3]], top: [180, 85, 3.6, [0, 0, 0]], iso: [215, 30, 3.8, [0, 0, 0.3]] },
  ribbon: { rear: [180, 15, 5.5, [0, 0, 0]], side: [90, 10, 5.5, [0, 0, 0]], front: [0, 15, 5.5, [0, 0, 0]], top: [90, 80, 5.5, [0, 0, 0]], iso: [235, 25, 6, [0, 0, 0]] },
};

const VIEW_HELP = {
  pose:   '記録した傾き・ピッチでバイクを再生します。オレンジの矢印はボードが感じた力（重力と遠心力などの合計）、ライダーはサーボ角ぶん内側に傾きます。ドラッグで回転、ホイールかピンチで拡大。',
  gg:     '全サンプルの「前後G・横G・上下G」を点で並べた図です。色は時間（青→赤）、大きい点が今の位置です。ブレーキしながら曲がったところなどが一目で分かります。',
  sphere: 'バイクの「上」の向きを球の上に描いた軌跡です。中心から右へ伸びるほど右に深く傾き、前後はピッチ（ウィリー・ジャックナイフ）を表します。',
  ribbon: '横軸が時間、奥行きが傾き、高さが前後G の 3D の線です。床の影が傾き、壁の影が前後Gです。前後 10 秒をスクロール表示します。',
  chart:  '各値の時間変化のグラフです。タップ（クリック）した位置へ移動します。表示幅で拡大できます。',
};

class Viewer {
  constructor() {
    this.canvas = $('vCanvas');
    this.scene = new Scene3D(this.canvas);
    this.scene.onChange = () => { this.dirty = true; };
    this.view = 'pose';
    this.A = null;
    this.pos = 0;           // 再生位置 (サンプル番号, 小数あり)
    this.playing = false;
    this.speed = 1;
    this.dirty = true;
    this.onFlip = null;     // 前後反転の切り替え時 (blackbox.js が再解析する)
    this._wire();
    this.setView('pose');
    const loop = ts => { this._tick(ts); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _wire() {
    document.querySelectorAll('#vTabs button').forEach(b => b.addEventListener('click', () => this.setView(b.dataset.view)));
    document.querySelectorAll('#vCams button').forEach(b => b.addEventListener('click', () => this.setCamera(b.dataset.cam)));
    $('vPlay').addEventListener('click', () => this.setPlaying(!this.playing));
    $('vSlider').addEventListener('input', e => { this.setPlaying(false); this.setPos(Number(e.target.value)); });
    $('vSpeed').addEventListener('change', e => { this.speed = Number(e.target.value); });
    $('vYaw').addEventListener('change', () => { this.dirty = true; });
    $('vSpan').addEventListener('change', () => { this.dirty = true; });
    $('vFlip').addEventListener('change', e => { if (this.onFlip) this.onFlip(e.target.checked); });
    window.addEventListener('resize', () => { this.dirty = true; });

    // グラフ表示ではタップした時刻へ移動
    const seek = e => {
      if (this.view !== 'chart' || !this.A || !this._chartX) return;
      const rect = this.canvas.getBoundingClientRect();
      const t = this._chartX.toTime(e.clientX - rect.left);
      this.setPlaying(false);
      this.setPos(clamp(Math.round(t * this.A.rate), 0, this.A.n - 1));
    };
    let seeking = false;
    this.canvas.addEventListener('pointerdown', e => { if (this.view === 'chart') { seeking = true; this.canvas.setPointerCapture(e.pointerId); seek(e); } });
    this.canvas.addEventListener('pointermove', e => { if (seeking) seek(e); });
    this.canvas.addEventListener('pointerup', () => { seeking = false; });
  }

  setData(A) {
    this.A = A;
    const slider = $('vSlider');
    slider.max = String(Math.max(0, A.n - 1));
    this.setPos(clamp(Math.round(this.pos), 0, A.n - 1));
    this.dirty = true;
  }

  setView(view) {
    this.view = view;
    document.querySelectorAll('#vTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    const is3d = view !== 'chart';
    this.scene.enabled = is3d;
    $('vCams').hidden = !is3d;
    $('vYawWrap').hidden = view !== 'pose';
    $('vSpanWrap').hidden = view !== 'chart';
    this.canvas.style.cursor = is3d ? 'grab' : 'crosshair';
    $('vHelp').textContent = VIEW_HELP[view];
    if (is3d) this.setCamera('iso');
    this.dirty = true;
  }

  setCamera(name) {
    const c = CAMERAS[this.view] && CAMERAS[this.view][name];
    if (!c) return;
    this.scene.setCamera(c[0], c[1], c[2], c[3]);
    this.dirty = true;
  }

  setPlaying(on) {
    if (!this.A) on = false;
    if (on && this.pos >= this.A.n - 1) this.pos = 0;
    this.playing = on;
    $('vPlay').textContent = on ? '❚❚' : '▶';
    $('vPlay').setAttribute('aria-label', on ? '一時停止' : '再生');
    this._lastTs = null;
  }

  setPos(p) {
    this.pos = p;
    this.dirty = true;
  }

  _tick(ts) {
    if (this.playing && this.A) {
      if (this._lastTs != null) {
        this.pos += (ts - this._lastTs) / 1000 * this.A.rate * this.speed;
        if (this.pos >= this.A.n - 1) { this.pos = this.A.n - 1; this.setPlaying(false); }
      }
      this._lastTs = ts;
      this.dirty = true;
    }
    if (!this.dirty || this.canvas.offsetParent === null) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    const A = this.A;
    this.colors = {
      text: cssVar('--text'), muted: cssVar('--muted'), line: cssVar('--line'), accent: cssVar('--accent'),
      s1: cssVar('--s1'), s2: cssVar('--s2'), s3: cssVar('--s3'),
    };
    if (!A) { this.scene.begin(); return; }
    const i = clamp(Math.round(this.pos), 0, A.n - 1);
    $('vSlider').value = String(i);
    $('vTime').textContent = `${(i / A.rate).toFixed(2)} / ${((A.n - 1) / A.rate).toFixed(2)} s`;
    this._readouts(i);

    switch (this.view) {
      case 'pose':   this._drawPose(i); break;
      case 'gg':     this._drawGG(i); break;
      case 'sphere': this._drawSphere(i); break;
      case 'ribbon': this._drawRibbon(i); break;
      case 'chart':  this._drawChart(i); break;
    }
  }

  _readouts(i) {
    const A = this.A;
    const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
    $('rLean').textContent  = `${sgn(A.lean[i])}°`;
    $('rPitch').textContent = `${sgn(A.pitch[i])}°`;
    $('rRider').textContent = `${sgn(A.rider[i])}°`;
    $('rTotal').textContent = `${A.gTotal[i].toFixed(2)} G`;
    $('rLong').textContent  = `${sgn(A.gLong[i], 2)} G`;
    $('rLat').textContent   = `${sgn(A.gLat[i], 2)} G`;
    $('rVert').textContent  = `${A.gVert[i].toFixed(2)} G`;
    $('rRate').textContent  = `${sgn(A.rollRate[i], 0)}°/s`;
  }

  // ---- 姿勢再生 ----
  _drawPose(i) {
    const A = this.A, s = this.scene, C = this.colors;
    const yaw = $('vYaw').checked ? A.yawRad[i] : 0;
    const R = eulerMatrix(A.rollRad[i], A.pitchRad[i], yaw);
    s.begin();

    // 地面 (走った向きに関係なく固定)
    for (let k = -4; k <= 4; k++) {
      s.line([k * 0.5, -2, 0], [k * 0.5, 2, 0], C.line, 1);
      s.line([-2, k * 0.5, 0], [2, k * 0.5, 0], C.line, 1);
    }
    s.line([0, 0, 0], [2.2, 0, 0], C.muted, 1.5);
    s.label([2.4, 0, 0], '進行方向', C.muted);

    const T = p => mulMV(R, p);
    // 影 (真上から地面に落とした形)
    const shadow = p => { const q = T(p); return [q[0], q[1], 0.002]; };
    for (const w of BIKE.wheels.filter((_, k) => k % 2 === 0)) s.polyline(w.map(shadow), C.line, 4);

    for (const w of BIKE.wheels) s.polyline(w.map(T), C.text, 2.5);
    for (const f of BIKE.frame) s.polyline(f.map(T), C.muted, 3);

    // ライダー: シートを中心にサーボ角ぶん x 軸まわりに回す
    const rr = A.rider[i] * DEG;
    const cr = Math.cos(rr), sr = Math.sin(rr);
    const S = BIKE.seat;
    const riderT = p => {
      const d = vSub(p, S);
      return T(vAdd(S, [d[0], d[1] * cr - d[2] * sr, d[1] * sr + d[2] * cr]));
    };
    const rd = BIKE.rider;
    s.polyline(rd.body.map(riderT), C.s2, 7);
    for (const a of rd.arms) s.polyline(a.map(riderT), C.s2, 4);
    for (const l of rd.legs) s.polyline(l.map(riderT), C.s2, 5);
    const head = riderT(rd.head);
    const hp = s.project(head);
    if (hp) s.dot(head, Math.max(4, s.focal * 0.1 / hp[2]), C.text);

    // ボードが感じた力 (比力) をワールド座標で
    const com = T([0, 0, 0.6]);
    const fW = mulMV(R, [A.fx[i], A.fy[i], A.fz[i]]);
    s.arrow(com, vAdd(com, vScale(fW, 0.6)), C.accent, 3.5);
    s.label(vAdd(com, vScale(fW, 0.68)), `${A.gTotal[i].toFixed(2)}G`, C.accent);

    s.hud([
      `傾き ${A.lean[i] >= 0 ? '右' : '左'} ${Math.abs(A.lean[i]).toFixed(1)}°`,
      `ピッチ ${A.pitch[i] >= 0 ? '+' : ''}${A.pitch[i].toFixed(1)}°`,
      `ライダー ${Math.abs(A.rider[i]).toFixed(1)}°`,
    ], C.text);
  }

  // ---- G 3D 散布 ----
  _drawGG(i) {
    const A = this.A, s = this.scene, C = this.colors;
    const range = A.gRange;
    const P = k => [A.gLong[k] / range, -A.gLat[k] / range, (A.gVert[k] - 1) / range];
    s.begin();

    // 軸と目盛り (±range G の立方体)
    const axes = [[[-1, 0, 0], [1, 0, 0]], [[0, -1, 0], [0, 1, 0]], [[0, 0, -1], [0, 0, 1]]];
    for (const [a, b] of axes) s.line(a, b, C.muted, 1.5);
    for (const r of [0.5, 1]) {
      const pts = [];
      for (let k = 0; k <= 48; k++) { const t = k / 48 * Math.PI * 2; pts.push([Math.cos(t) * r, Math.sin(t) * r, 0]); }
      s.polyline(pts, C.line, 1);
    }
    s.label([1.15, 0, 0], '加速', C.muted);
    s.label([-1.15, 0, 0], '減速', C.muted);
    s.label([0, -1.15, 0], '右', C.muted);
    s.label([0, 1.15, 0], '左', C.muted);
    s.label([0, 0, 1.12], '上', C.muted);
    s.label([0, 0, -1.12], '下', C.muted);
    s.label([0.5, 0.05, 0.05], `${(range / 2).toFixed(1)}G`, C.muted, 'left');

    // 全サンプル (多いときは間引く)
    const ctx = s.ctx;
    const step = Math.max(1, Math.ceil(A.n / 5000));
    for (let k = 0; k < A.n; k += step) {
      const q = s.project(P(k));
      if (!q) continue;
      ctx.fillStyle = timeColor(k / A.n);
      ctx.fillRect(q[0] - 1.2, q[1] - 1.2, 2.4, 2.4);
    }
    // 直近 1 秒の軌跡と今の位置
    const trail = [];
    for (let k = Math.max(0, i - A.rate); k <= i; k++) trail.push(P(k));
    s.polyline(trail, C.text, 2);
    s.line([0, 0, 0], P(i), C.accent, 2);
    s.dot(P(i), 6, C.accent);

    s.hud([`前後 ${A.gLong[i].toFixed(2)}G  横 ${A.gLat[i].toFixed(2)}G  上下 ${(A.gVert[i] - 1).toFixed(2)}G`], C.text);
  }

  // ---- 傾き球 ----
  _drawSphere(i) {
    const A = this.A, s = this.scene, C = this.colors;
    const up = k => {
      const r = A.rollRad[k], p = A.pitchRad[k];
      return [Math.sin(p) * Math.cos(r), -Math.sin(r), Math.cos(p) * Math.cos(r)];
    };
    s.begin();

    // 半球の網目 (傾き 30° ごと)
    for (const latDeg of [0, 30, 60]) {
      const la = (90 - latDeg) * DEG, pts = [];
      for (let k = 0; k <= 64; k++) { const t = k / 64 * Math.PI * 2; pts.push([Math.sin(la) * Math.cos(t), Math.sin(la) * Math.sin(t), Math.cos(la)]); }
      s.polyline(pts, C.line, 1);
      if (latDeg > 0) s.label([0, -Math.sin(la) - 0.08, Math.cos(la)], `${90 - latDeg}°`, C.muted);
    }
    for (let m = 0; m < 12; m++) {
      const t = m / 12 * Math.PI * 2, pts = [];
      for (let k = 0; k <= 16; k++) { const la = k / 16 * Math.PI / 2; pts.push([Math.sin(la) * Math.cos(t), Math.sin(la) * Math.sin(t), Math.cos(la)]); }
      s.polyline(pts, C.line, 1);
    }
    s.label([1.15, 0, 0], '前', C.muted);
    s.label([-1.15, 0, 0], '後', C.muted);
    s.label([0, -1.15, 0], '右', C.muted);
    s.label([0, 1.15, 0], '左', C.muted);

    // 全体の軌跡 (色は時間)
    const step = Math.max(1, Math.ceil(A.n / 3000));
    let prev = up(0);
    for (let k = step; k < A.n; k += step) {
      const cur = up(k);
      s.line(prev, cur, timeColor(k / A.n), 1.5);
      prev = cur;
    }
    // 直近 1 秒
    const trail = [];
    for (let k = Math.max(0, i - A.rate); k <= i; k++) trail.push(up(k));
    s.polyline(trail, C.text, 2.5);
    s.arrow([0, 0, 0], up(i), C.accent, 3);
    s.dot(up(i), 5, C.accent);

    s.hud([`傾き ${A.lean[i] >= 0 ? '右' : '左'} ${Math.abs(A.lean[i]).toFixed(1)}°   ピッチ ${A.pitch[i].toFixed(1)}°`], C.text);
  }

  // ---- 時間 3D (時間 × 傾き × 前後G) ----
  _drawRibbon(i) {
    const A = this.A, s = this.scene, C = this.colors;
    const W = 10;                    // 前後 10 秒
    const k0 = Math.max(0, i - W * A.rate), k1 = Math.min(A.n - 1, i + W * A.rate);
    const X = k => (k - i) / A.rate / W * 2.5;
    const Y = k => -A.lean[k] / 60 * 1.2;
    const Z = k => A.gLong[k] / A.longRange;
    s.begin();

    const floor = -1.2, wall = 1.5;
    // 床と壁の枠
    s.polyline([[-2.5, -1.4, floor], [2.5, -1.4, floor], [2.5, wall, floor], [-2.5, wall, floor]], C.line, 1, true);
    s.polyline([[-2.5, wall, floor], [2.5, wall, floor], [2.5, wall, 1.1], [-2.5, wall, 1.1]], C.line, 1, true);
    for (const deg of [-45, 45]) {
      const y = -deg / 60 * 1.2;
      s.line([-2.5, y, floor], [2.5, y, floor], C.line, 1);
      s.label([-2.7, y, floor], `${deg > 0 ? '右' : '左'}${Math.abs(deg)}°`, C.muted, 'right');
    }
    s.line([-2.5, 0, floor], [2.5, 0, floor], C.muted, 1);
    s.line([-2.5, wall, 0], [2.5, wall, 0], C.muted, 1);
    s.label([-2.7, wall, 1], `加速 ${A.longRange.toFixed(1)}G`, C.muted, 'right');
    s.label([-2.7, wall, -1], `減速`, C.muted, 'right');
    // 今の時刻の面
    s.polyline([[0, -1.4, floor], [0, wall, floor], [0, wall, 1.1]], C.accent, 1);
    s.label([2.6, -1.4, floor], '+10秒', C.muted, 'left');
    s.label([-2.6, -1.4, floor], '-10秒', C.muted, 'right');

    const step = Math.max(1, Math.round(A.rate / 50));
    const main = [], shFloor = [], shWall = [];
    for (let k = k0; k <= k1; k += step) {
      main.push([X(k), Y(k), Z(k)]);
      shFloor.push([X(k), Y(k), floor]);
      shWall.push([X(k), wall, Z(k)]);
    }
    s.polyline(shFloor, C.s3, 2);
    s.polyline(shWall, C.s1, 2);
    s.polyline(main, C.text, 2.5);
    s.dot([X(i), Y(i), Z(i)], 6, C.accent);
    s.line([X(i), Y(i), Z(i)], [X(i), Y(i), floor], C.accent, 1);
    s.line([X(i), Y(i), Z(i)], [X(i), wall, Z(i)], C.accent, 1);

    s.hud([`青: 傾き（床の影）  赤: 前後G（壁の影）`], C.text);
  }

  // ---- グラフ ----
  _drawChart(i) {
    const A = this.A, s = this.scene, C = this.colors;
    s.begin();   // キャンバスの大きさ合わせと消去
    const ctx = s.ctx, w = s.w, h = s.h;
    const span = Number($('vSpan').value);
    const T = (A.n - 1) / A.rate, tc = i / A.rate;
    let t0 = 0, t1 = T;
    if (span > 0 && span < T) {
      t0 = clamp(tc - span / 2, 0, T - span);
      t1 = t0 + span;
    }
    const left = 44, right = w - 8;
    const xOf = t => left + (t - t0) / (t1 - t0 || 1) * (right - left);
    this._chartX = { toTime: x => t0 + (x - left) / (right - left) * (t1 - t0) };

    const panels = [
      { title: '傾き・ピッチ (°)', series: [[A.lean, '傾き', C.s1], [A.pitch, 'ピッチ', C.s3]], min: 10 },
      { title: 'G（前後・横・上下）', series: [[A.gLong, '前後', C.s1], [A.gLat, '横', C.s2], [A.gVertLin, '上下-1', C.s3]], min: 0.5 },
      { title: 'ジャイロ (°/s) ボードの軸', series: [[A.gx, 'X', C.s1], [A.gy, 'Y', C.s2], [A.gz, 'Z', C.s3]], min: 30 },
      { title: '加速度 (G) ボードの軸', series: [[A.ax, 'X', C.s1], [A.ay, 'Y', C.s2], [A.az, 'Z', C.s3]], min: 1 },
    ];
    const ph = (h - 8) / panels.length;
    const k0 = Math.max(0, Math.floor(t0 * A.rate)), k1 = Math.min(A.n - 1, Math.ceil(t1 * A.rate));
    const step = Math.max(1, Math.floor((k1 - k0) / ((right - left) * 2)));

    panels.forEach((pn, idx) => {
      const top = 4 + idx * ph + 16, bottom = 4 + (idx + 1) * ph - 6;
      // 縦の範囲: 表示中の最大値に合わせる
      let m = pn.min;
      for (const [arr] of pn.series) for (let k = k0; k <= k1; k += step) m = Math.max(m, Math.abs(arr[k]));
      m *= 1.1;
      const yOf = v => (top + bottom) / 2 - v / m * (bottom - top) / 2;

      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, right - left, bottom - top);
      ctx.beginPath(); ctx.moveTo(left, yOf(0)); ctx.lineTo(right, yOf(0)); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(m.toFixed(m < 10 ? 1 : 0), left - 4, top + 4);
      ctx.fillText((-m).toFixed(m < 10 ? 1 : 0), left - 4, bottom - 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = C.text;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(pn.title, left, top - 2);
      let lx = left + ctx.measureText(pn.title).width + 12;
      ctx.font = '12px system-ui, sans-serif';
      for (const [, name, col] of pn.series) {
        ctx.fillStyle = col; ctx.fillRect(lx, top - 10, 10, 3);
        ctx.fillText(name, lx + 13, top - 2);
        lx += ctx.measureText(name).width + 28;
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
      for (const [arr, , col] of pn.series) {
        ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = k0; k <= k1; k += step) {
          const x = xOf(k / A.rate), y = yOf(arr[k]);
          if (k === k0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    });

    // 時間軸と今の位置
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xOf(tc), 4); ctx.lineTo(xOf(tc), h - 4); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left'; ctx.fillText(`${t0.toFixed(1)}s`, left, h);
    ctx.textAlign = 'right'; ctx.fillText(`${t1.toFixed(1)}s`, right, h);
  }
}
