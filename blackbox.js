'use strict';
// =====================================================================
// ブラックボックスモード: 記録の開始・停止、本体からの転送、ファイル保存、解析
//
// 本体のログ形式 (HangOff.ino の LogHeader と同じ):
//   先頭 64 バイト: ヘッダ
//   以降 12 バイトずつ: int16 × 6 (ジャイロ X,Y,Z, 加速度 X,Y,Z) 100Hz
// =====================================================================

const LOG_MAGIC = 0x31474C48;   // "HLG1"
const LOG_HEADER_SIZE = 64;
const LOG_SAMPLE_SIZE = 12;
const LOGCMD = { start: 1, stop: 2, read: 3, cancel: 4, probe: 5 };
const LOG_STATE = { idle: 0, flushing: 1, recording: 2, sending: 3, disabled: 4 };
const STATE_TEXT = ['待機中', '書き込み中', '● 記録中', '送信中', '使用不可'];

const bb = {
  status: null,       // 本体の記録状態
  raw: null,          // 読み込んだログ (ArrayBuffer)
  log: null,          // parseLog の結果
  A: null,            // analyzeLog の結果
  source: '',
  xfer: null,         // 転送中の情報
  probeResolve: null,
  flip: false,
};
let viewer = null;

// ---------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------
const fmtTime = s => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtKB = b => b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;

function bbUpdateUI() {
  const st = bb.status;
  const conn = isConnected() && !!chars.logCtrl;
  const badge = $('bbState');
  if (!isConnected()) {
    badge.textContent = '未接続'; badge.className = 'badge';
  } else if (!chars.logCtrl) {
    badge.textContent = '未対応'; badge.className = 'badge';
    $('bbNote').textContent = '本体のプログラムが古いため記録できません。最新の HangOff.ino を書き込んでください。';
  } else if (st) {
    badge.textContent = STATE_TEXT[st.state] || '-';
    badge.className = 'badge' + (st.state === LOG_STATE.recording ? ' rec' : st.state === LOG_STATE.idle ? '' : ' busy');
  }

  if (st) {
    const samples = Math.max(0, Math.floor((st.bytes - LOG_HEADER_SIZE) / LOG_SAMPLE_SIZE));
    const capSamples = Math.floor((st.capacity - LOG_HEADER_SIZE) / LOG_SAMPLE_SIZE);
    $('bbTime').textContent = fmtTime(samples / st.rate);
    $('bbCap').textContent = fmtTime(capSamples / st.rate);
    $('bbSamples').textContent = samples.toLocaleString();
    $('bbBar').firstElementChild.style.width = `${Math.min(100, samples / capSamples * 100)}%`;
    $('bbBar').classList.toggle('rec', st.state === LOG_STATE.recording);
    $('bbDroppedWrap').hidden = !st.dropped;
    $('bbDropped').textContent = st.dropped;
    if (st.state === LOG_STATE.disabled) $('bbNote').textContent = '記録用のフラッシュが見つかりません（シリアルモニタの External flash ID を確認してください）。';
  }

  const state = st ? st.state : -1;
  const busy = !!bb.xfer;
  $('bbStart').disabled = !conn || busy || state !== LOG_STATE.idle;
  $('bbStop').disabled = !conn || state !== LOG_STATE.recording;
  $('bbDownload').disabled = !conn || busy || state !== LOG_STATE.idle || !st || st.bytes <= LOG_HEADER_SIZE;
  $('bbSave').disabled = !bb.raw;
  $('bbCsv').disabled = !bb.A;
}

function parseStatus(dv) {
  return {
    state: dv.getUint8(0),
    rate: dv.getUint16(2, true) || 100,
    bytes: dv.getUint32(4, true),
    capacity: dv.getUint32(8, true),
    dropped: dv.getUint32(12, true),
  };
}

function onLogStatus() {
  bbUpdateUI();
}

// app.js から呼ばれる
async function bbOnConnected() {
  bb.status = null;
  if (chars.logStatus) {
    chars.logStatus.addEventListener('characteristicvaluechanged', e => { bb.status = parseStatus(e.target.value); onLogStatus(); });
    await chars.logStatus.startNotifications();
    bb.status = parseStatus(await chars.logStatus.readValue());
  }
  if (chars.logData) {
    chars.logData.addEventListener('characteristicvaluechanged', onLogData);
    await chars.logData.startNotifications();
  }
  bbUpdateUI();
}

function bbOnDisconnected() {
  if (bb.xfer) bb.xfer.failed = '接続が切れました';
  bbUpdateUI();
}

async function bbOnShow() {
  if (!viewer) viewer = new Viewer();
  viewer.onFlip = on => { bb.flip = on; if (bb.log) showLog(); };
  viewer.dirty = true;
  bbUpdateUI();
  // 前回読み込んだデータがあれば表示する
  if (!bb.raw) {
    try {
      const saved = await idbGet('last');
      if (saved && saved.buf) loadBuffer(saved.buf, saved.source || '前回のデータ', false);
    } catch (e) { console.warn(e); }
  }
}

// ---------------------------------------------------------------------
// 記録の開始・停止
// ---------------------------------------------------------------------
function logCommand(bytes) {
  return enqueueOp(() => chars.logCtrl.writeValueWithResponse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

$('bbStart').addEventListener('click', async () => {
  const st = bb.status;
  if (st && st.bytes > LOG_HEADER_SIZE &&
      !confirm('本体に前の記録が残っています。新しく記録すると上書きされます。始めますか？\n（必要なら先に「本体からデータを読み込む」で取り出してください）')) return;
  try {
    await logCommand([LOGCMD.start]);
    showToast('記録を始めました');
  } catch (e) { showToast('記録を始められませんでした', 'ng'); }
});

$('bbStop').addEventListener('click', async () => {
  try {
    await logCommand([LOGCMD.stop]);
    showToast('記録を止めました');
  } catch (e) { showToast('止められませんでした', 'ng'); }
});

// ---------------------------------------------------------------------
// 本体からの転送
// 1. PROBE で最大サイズの通知を送ってもらい、届いた長さから 1 回に送れる量を決める
// 2. READ で範囲を指定すると、本体が [offset u32, データ] の通知を連続で送ってくる
// 3. 届かなかった部分があれば、その範囲だけ読み直す
// ---------------------------------------------------------------------
function onLogData(e) {
  const dv = e.target.value;
  const off = dv.getUint32(0, true);
  const n = dv.byteLength - 4;
  if (off === 0xFFFFFFFF) {
    if (bb.probeResolve) { bb.probeResolve(n); bb.probeResolve = null; }
    return;
  }
  const x = bb.xfer;
  if (!x || n <= 0 || off + n > x.total) return;
  x.buf.set(new Uint8Array(dv.buffer, dv.byteOffset + 4, n), off);
  const idx = Math.floor(off / x.chunk);
  if (!x.got[idx]) { x.got[idx] = 1; x.gotCount++; x.gotBytes += n; }
  x.lastRx = performance.now();
}

async function probeChunk() {
  const p = new Promise(resolve => {
    bb.probeResolve = resolve;
    setTimeout(() => { if (bb.probeResolve === resolve) { bb.probeResolve = null; resolve(20); } }, 2000);
  });
  await logCommand([LOGCMD.probe]);
  const len = await p;
  return Math.max(16, Math.min(240, len));
}

function readCommand(offset, length, chunk) {
  const b = new DataView(new ArrayBuffer(11));
  b.setUint8(0, LOGCMD.read);
  b.setUint32(1, offset, true);
  b.setUint32(5, length, true);
  b.setUint16(9, chunk, true);
  return logCommand(new Uint8Array(b.buffer));
}

function missingRanges(x) {
  const out = [];
  let start = -1;
  for (let k = 0; k <= x.got.length; k++) {
    const miss = k < x.got.length && !x.got[k];
    if (miss && start < 0) start = k;
    if (!miss && start >= 0) { out.push([start, k]); start = -1; }
  }
  return out;
}

function updateXferUI() {
  const x = bb.xfer;
  if (!x) return;
  const pct = x.gotBytes / x.total * 100;
  const sec = (performance.now() - x.t0) / 1000;
  const rate = x.gotBytes / Math.max(0.1, sec);
  const remain = (x.total - x.gotBytes) / Math.max(1, rate);
  $('bbXferBar').style.width = `${pct}%`;
  $('bbXferText').textContent = `${pct.toFixed(0)}%  ${fmtKB(x.gotBytes)} / ${fmtKB(x.total)}  ${fmtKB(rate)}/s  残り約${Math.ceil(remain)}秒`;
}

$('bbDownload').addEventListener('click', async () => {
  if (!bb.status || bb.xfer) return;
  const total = bb.status.bytes;
  $('bbXfer').hidden = false;
  $('bbXferBar').style.width = '0%';
  $('bbXferText').textContent = '準備中…';
  try {
    const chunk = await probeChunk();
    const x = bb.xfer = {
      total, chunk,
      buf: new Uint8Array(total),
      got: new Uint8Array(Math.ceil(total / chunk)),
      gotCount: 0, gotBytes: 0,
      t0: performance.now(), lastRx: performance.now(),
      failed: null, cancelled: false,
    };
    bbUpdateUI();
    const timer = setInterval(updateXferUI, 250);
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const ranges = missingRanges(x);
        if (!ranges.length) break;
        for (const [a, b] of ranges) {
          if (x.failed || x.cancelled) break;
          const off = a * chunk, len = Math.min(b * chunk, total) - off;
          x.lastRx = performance.now();
          await readCommand(off, len, chunk);
          // 範囲が全部届くか、2 秒間何も届かなくなるまで待つ
          while (!x.failed && !x.cancelled) {
            await new Promise(r => setTimeout(r, 100));
            let done = true;
            for (let k = a; k < b; k++) if (!x.got[k]) { done = false; break; }
            if (done || performance.now() - x.lastRx > 2000) break;
          }
          if (!x.failed && !x.cancelled && performance.now() - x.lastRx > 2000) {
            await logCommand([LOGCMD.cancel]).catch(() => {});
          }
        }
        if (x.failed || x.cancelled) break;
      }
    } finally {
      clearInterval(timer);
    }
    updateXferUI();
    if (x.cancelled) throw new Error('中止しました');
    if (x.failed) throw new Error(x.failed);
    if (missingRanges(x).length) throw new Error('一部のデータが届きませんでした');
    bb.xfer = null;
    $('bbXfer').hidden = true;
    loadBuffer(x.buf.buffer, `本体から読み込み（${new Date().toLocaleString()}）`, true);
    showToast('✓ 読み込みました', 'ok');
  } catch (e) {
    bb.xfer = null;
    $('bbXferText').textContent = '失敗: ' + e.message;
    showToast('読み込めませんでした: ' + e.message, 'ng');
    if (isConnected() && chars.logCtrl) logCommand([LOGCMD.cancel]).catch(() => {});
  }
  bbUpdateUI();
});

$('bbCancel').addEventListener('click', () => {
  if (bb.xfer) bb.xfer.cancelled = true;
  else $('bbXfer').hidden = true;
});

// ---------------------------------------------------------------------
// ファイル
// ---------------------------------------------------------------------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

$('bbSave').addEventListener('click', () => {
  if (bb.raw) download(new Blob([bb.raw], { type: 'application/octet-stream' }), `hangoff-${stamp()}.bin`);
});

$('bbOpen').addEventListener('click', () => $('bbFile').click());
$('bbFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    loadBuffer(await f.arrayBuffer(), f.name, true);
  } catch (err) {
    showToast('読み込めませんでした: ' + err.message, 'ng');
  }
  e.target.value = '';
});

$('bbCsv').addEventListener('click', () => {
  const A = bb.A;
  if (!A) return;
  const rows = ['time_s,gyro_x_dps,gyro_y_dps,gyro_z_dps,acc_x_g,acc_y_g,acc_z_g,lean_deg,pitch_deg,rider_deg,g_long,g_lat,g_vert,g_total'];
  for (let k = 0; k < A.n; k++) {
    rows.push([
      (k / A.rate).toFixed(2),
      A.gx[k].toFixed(2), A.gy[k].toFixed(2), A.gz[k].toFixed(2),
      A.ax[k].toFixed(4), A.ay[k].toFixed(4), A.az[k].toFixed(4),
      A.lean[k].toFixed(2), A.pitch[k].toFixed(2), A.rider[k].toFixed(2),
      A.gLong[k].toFixed(3), A.gLat[k].toFixed(3), A.gVert[k].toFixed(3), A.gTotal[k].toFixed(3),
    ].join(','));
  }
  download(new Blob([rows.join('\n')], { type: 'text/csv' }), `hangoff-${stamp()}.csv`);
});

$('bbDemo').addEventListener('click', () => {
  loadBuffer(makeDemoLog(), 'デモデータ（模擬走行 60 秒）', false);
});

// 前回のデータを残しておく (ページを開き直しても見られるように)
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hangoff', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('logs');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, value) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    tx.objectStore('logs').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const r = db.transaction('logs').objectStore('logs').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function loadBuffer(buf, source, remember) {
  bb.log = parseLog(buf);   // 形式が違えばここで例外
  bb.raw = buf;
  bb.source = source;
  showLog();
  if (remember) idbPut('last', { buf, source }).catch(e => console.warn(e));
}

function showLog() {
  bb.A = analyzeLog(bb.log, { flipForward: bb.flip });
  const L = bb.log;
  $('bbDataInfo').textContent =
    `${bb.source}: ${(L.n / L.rate).toFixed(1)} 秒・${L.n.toLocaleString()} サンプル・${fmtKB(bb.raw.byteLength)}（記録時の軸 ${'XYZ'[L.meta.axis] || '?'}）`;
  $('viewer').hidden = false;
  if (!viewer) viewer = new Viewer();
  viewer.setData(bb.A);
  bbUpdateUI();
}

// ---------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------
function parseLog(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < LOG_HEADER_SIZE || dv.getUint32(0, true) !== LOG_MAGIC) throw new Error('HangOff のログではありません');
  const f = o => dv.getFloat32(o, true);
  const meta = {
    version: dv.getUint16(4, true),
    rate: dv.getUint16(6, true) || 100,
    gyroScale: f(8),
    accelScale: f(12),
    gyroBias: [f(16), f(20), f(24)],
    axis: Math.round(f(28)),
    rollOffset: f(32),
    alpha: f(36),
    ratio: f(40),
    limitDeg: f(44),
    reverse: f(48),
  };
  const n = Math.floor((buf.byteLength - LOG_HEADER_SIZE) / LOG_SAMPLE_SIZE);
  const ch = () => new Float32Array(n);
  const log = { meta, n, rate: meta.rate, gx: ch(), gy: ch(), gz: ch(), ax: ch(), ay: ch(), az: ch() };
  for (let k = 0; k < n; k++) {
    const o = LOG_HEADER_SIZE + k * LOG_SAMPLE_SIZE;
    log.gx[k] = dv.getInt16(o, true) * meta.gyroScale - meta.gyroBias[0];
    log.gy[k] = dv.getInt16(o + 2, true) * meta.gyroScale - meta.gyroBias[1];
    log.gz[k] = dv.getInt16(o + 4, true) * meta.gyroScale - meta.gyroBias[2];
    log.ax[k] = dv.getInt16(o + 6, true) * meta.accelScale;
    log.ay[k] = dv.getInt16(o + 8, true) * meta.accelScale;
    log.az[k] = dv.getInt16(o + 10, true) * meta.accelScale;
  }
  return log;
}

// ボードの軸 → バイクの軸 (x 前, y 左, z 上) に直して、姿勢と G を計算する。
//   上: 記録開始から 0.5 秒の加速度の平均 (まっすぐ立てて止まった状態で始める前提)
//   前: 角度調整で選んだ「傾きを測る軸」(バイクはこの軸まわりに傾く)
// 姿勢は Mahony フィルタ: ジャイロを積分し、加速度がほぼ 1G のとき (直進・停止中) だけ重力の向きで補正する。
// コーナー中は遠心力で加速度の向きが傾きと一致しないので補正しない。
function analyzeLog(log, opts = {}) {
  const { n, rate, meta } = log;
  const dt = 1 / rate;
  const n0 = Math.max(1, Math.min(n, Math.round(rate * 0.5)));

  // 上向き
  let up = [0, 0, 0];
  for (let k = 0; k < n0; k++) up = vAdd(up, [log.ax[k], log.ay[k], log.az[k]]);
  up = vLen(up) > 0.1 ? vNorm(up) : [0, 0, 1];
  // 前向き (上と直交させる)
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let fwd = null;
  for (const e of [axes[meta.axis] || axes[0], ...axes]) {
    const f = vSub(e, vScale(up, vDot(e, up)));
    if (vLen(f) > 0.3) { fwd = vNorm(f); break; }
  }
  if (opts.flipForward) fwd = vScale(fwd, -1);
  const left = vCross(up, fwd);
  const M = [fwd, left, up];   // ボード → バイク

  // 記録開始時に止まっていればジャイロのゼロ点を取り直す
  let bias = [0, 0, 0], varSum = 0;
  for (let k = 0; k < n0; k++) bias = vAdd(bias, [log.gx[k], log.gy[k], log.gz[k]]);
  bias = vScale(bias, 1 / n0);
  for (let k = 0; k < n0; k++) varSum += vLen(vSub([log.gx[k], log.gy[k], log.gz[k]], bias)) ** 2;
  if (Math.sqrt(varSum / n0) > 3) bias = [0, 0, 0];

  const F = () => new Float32Array(n);
  const A = {
    n, rate, meta,
    gx: log.gx, gy: log.gy, gz: log.gz, ax: log.ax, ay: log.ay, az: log.az,
    rollRad: F(), pitchRad: F(), yawRad: F(),
    lean: F(), pitch: F(), rider: F(), rollRate: F(),
    fx: F(), fy: F(), fz: F(),
    gLong: F(), gLat: F(), gVert: F(), gVertLin: F(), gTotal: F(),
  };

  // 加減速中も加速度の向きが傾くので、補正はかなり 1G に近いときだけにする。
  // 振動で一瞬だけ 1G に近づくことがあるので、判定と補正には 0.2 秒の平均を使う。
  const KP = 0.5, GATE = 0.03;
  const lpf = Math.min(1, dt / 0.2);
  let af = [0, 0, 1];
  let q0 = 1, q1 = 0, q2 = 0, q3 = 0;
  let gMax = 0.5, longMax = 0.3;
  const limit = meta.limitDeg > 0 ? meta.limitDeg : 90;
  const ratio = meta.ratio > 0 ? meta.ratio : 1;

  for (let k = 0; k < n; k++) {
    const w = mulMV(M, vScale(vSub([log.gx[k], log.gy[k], log.gz[k]], bias), DEG));
    const a = mulMV(M, [log.ax[k], log.ay[k], log.az[k]]);
    const an = vLen(a);
    let [wx, wy, wz] = w;
    af = vAdd(af, vScale(vSub(a, af), lpf));
    const afn = vLen(af);

    if (afn > 0 && Math.abs(afn - 1) < GATE) {
      // 推定した重力の向き (バイク座標)
      const vx = 2 * (q1 * q3 - q0 * q2);
      const vy = 2 * (q0 * q1 + q2 * q3);
      const vz = q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3;
      const ax_ = af[0] / afn, ay_ = af[1] / afn, az_ = af[2] / afn;
      wx += KP * (ay_ * vz - az_ * vy);
      wy += KP * (az_ * vx - ax_ * vz);
      wz += KP * (ax_ * vy - ay_ * vx);
    }
    // q += 0.5 * q ⊗ (0, w) * dt
    const h = 0.5 * dt;
    const n0q = q0 + (-q1 * wx - q2 * wy - q3 * wz) * h;
    const n1q = q1 + (q0 * wx + q2 * wz - q3 * wy) * h;
    const n2q = q2 + (q0 * wy - q1 * wz + q3 * wx) * h;
    const n3q = q3 + (q0 * wz + q1 * wy - q2 * wx) * h;
    const qn = Math.hypot(n0q, n1q, n2q, n3q);
    q0 = n0q / qn; q1 = n1q / qn; q2 = n2q / qn; q3 = n3q / qn;

    const roll = Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2));
    const pitch = Math.asin(clamp(2 * (q0 * q2 - q3 * q1), -1, 1));
    const yaw = Math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3));
    A.rollRad[k] = roll; A.pitchRad[k] = pitch; A.yawRad[k] = yaw;
    A.lean[k] = roll / DEG;            // 右に傾くと +
    A.pitch[k] = -pitch / DEG;         // 前が上がると +
    A.rollRate[k] = w[0] / DEG;
    A.rider[k] = clamp(A.lean[k] * ratio, -limit, limit);

    // ボードが感じた力 (バイク座標) と、地面基準の G
    A.fx[k] = a[0]; A.fy[k] = a[1]; A.fz[k] = a[2];
    const R = eulerMatrix(roll, pitch, yaw);
    const fw = mulMV(R, a);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    A.gLong[k] = cy * fw[0] + sy * fw[1];
    A.gLat[k] = -(-sy * fw[0] + cy * fw[1]);   // 右向きを +
    A.gVert[k] = fw[2];
    A.gVertLin[k] = fw[2] - 1;
    A.gTotal[k] = an;
    gMax = Math.max(gMax, Math.abs(A.gLong[k]), Math.abs(A.gLat[k]), Math.abs(A.gVertLin[k]));
    longMax = Math.max(longMax, Math.abs(A.gLong[k]));
  }
  A.gRange = Math.ceil(gMax * 2) / 2;
  A.longRange = Math.ceil(longMax * 4) / 4;
  return A;
}

// ---------------------------------------------------------------------
// デモデータ: 楕円コースを走る模擬データを本体と同じ形式で作る
// (ボードは X 軸が前、Z 軸が上向きに付いている想定)
// ---------------------------------------------------------------------
function makeDemoLog(seconds = 60, rate = 100) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(LOG_HEADER_SIZE + n * LOG_SAMPLE_SIZE);
  const dv = new DataView(buf);
  const GS = 0.07, AS = 0.000244;
  dv.setUint32(0, LOG_MAGIC, true);
  dv.setUint16(4, 1, true);
  dv.setUint16(6, rate, true);
  dv.setFloat32(8, GS, true);
  dv.setFloat32(12, AS, true);
  dv.setFloat32(28, 0, true);      // 軸 X
  dv.setFloat32(36, 0.96, true);
  dv.setFloat32(40, 1.3, true);    // 比率
  dv.setFloat32(44, 60, true);     // 最大傾き

  // コース: 直線で加速 → ブレーキ → 右コーナー → … (左コーナーも混ぜる)
  const plan = [
    [1.0, 0, 0], [2.5, 0, 0.35], [0.8, 0, -0.6], [3.0, 42, 0], [0.6, 0, 0.3],
    [2.0, 0, 0.3], [0.7, 0, -0.5], [2.4, -38, 0], [0.5, 0, 0.2], [1.5, 0, 0.25],
    [0.6, 0, -0.4], [1.2, 30, 0], [1.2, -30, 0], [1.0, 0, 0.2],
  ];
  const seg = [];
  let tt = 0;
  for (const [d, lean, acc] of plan) { seg.push({ t0: tt, t1: tt + d, lean, acc }); tt += d; }
  const loop = tt;
  const target = t => {
    if (t < 1) return { lean: 0, acc: 0 };   // 最初の 1 秒は停止
    const u = (t - 1) % loop;
    const s = seg.find(x => u >= x.t0 && u < x.t1) || seg[0];
    return s;
  };

  let lean = 0, v = 0, rng = 1;
  const rand = () => { rng = (rng * 16807) % 2147483647; return rng / 2147483647 - 0.5; };
  for (let k = 0; k < n; k++) {
    const t = k / rate;
    const tg = target(t);
    // 傾きは目標に滑らかに近づける (時定数 0.25 秒)
    const prevLean = lean;
    lean += (tg.lean - lean) * Math.min(1, (1 / rate) / 0.25);
    const leanRate = (lean - prevLean) * rate;      // °/s
    const th = lean * DEG;
    const moving = t >= 1;
    const accG = moving ? (Math.abs(tg.lean) > 1 ? 0 : tg.acc) : 0;
    v = moving ? Math.max(4, Math.min(14, v + accG * 9.81 / rate)) : 0;

    // ヨー速度 (右旋回は -)、バイク座標のジャイロ
    const r = v > 0 ? -9.81 * Math.tan(th) / v : 0;
    let wx = leanRate * DEG, wy = r * Math.sin(th), wz = r * Math.cos(th);
    // 力: 前後 = 加減速, 上 = 1/cos(傾き) (釣り合い旋回), それに振動
    const vib = moving ? 0.08 : 0.01;
    let fx = accG + rand() * vib, fy = rand() * vib, fz = 1 / Math.cos(th) + rand() * vib * 1.5 + (moving ? 0.05 * Math.sin(2 * Math.PI * 23 * t) : 0);
    wx += rand() * 0.02; wy += rand() * 0.02; wz += rand() * 0.02;

    const o = LOG_HEADER_SIZE + k * LOG_SAMPLE_SIZE;
    const put = (j, val, sc) => dv.setInt16(o + j * 2, clamp(Math.round(val / sc), -32768, 32767), true);
    put(0, wx / DEG, GS); put(1, wy / DEG, GS); put(2, wz / DEG, GS);
    put(3, fx, AS); put(4, fy, AS); put(5, fz, AS);
  }
  return buf;
}
