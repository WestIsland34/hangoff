'use strict';
// =====================================================================
// HangOff: 接続・モード切り替え・角度調整モード
// UUID は HangOff.ino と同じにすること
// =====================================================================

// 画面の版。ファイルを変えたら上げる (sw.js の CACHE も合わせて上げる)
const APP_VERSION = '2.5';

const uuid = n => `a7c3${n}-5b1e-4d6a-9f2e-3c8b1d0e7a51`;
const SERVICE = uuid('0000');

// 入力欄と BLE キャラクタリスティックの対応
//   kind: range (スライダー) / check (チェックボックス) / choice (ボタンで1つ選ぶ)
//   optional: 古いファームウェアには無い項目 (無ければ欄を隠す)
const AXIS_NAMES = ['X', 'Y', 'Z'];
const SOURCE_NAMES = ['アプリ', '受信機'];
const usFmt = v => `${v.toFixed(0)} µs`;
const ratioFmt = v => `× ${v.toFixed(2)}`;
const PARAMS = [
  { id: 'axis',     uuid: uuid('0007'), kind: 'choice', optional: true, fmt: i => AXIS_NAMES[i] ? `${AXIS_NAMES[i]} 軸` : '-' },
  { id: 'source',   uuid: uuid('0008'), kind: 'choice', optional: true, fmt: i => SOURCE_NAMES[i] || '-' },
  { id: 'ratio',    uuid: uuid('0001'), kind: 'range', fmt: ratioFmt },
  { id: 'pwmRatioLow',  uuid: uuid('0009'), kind: 'range', optional: true, fmt: ratioFmt },
  { id: 'pwmRatioHigh', uuid: uuid('000a'), kind: 'range', optional: true, fmt: ratioFmt },
  { id: 'pwmLow',   uuid: uuid('000b'), kind: 'range', optional: true, fmt: usFmt },
  { id: 'pwmHigh',  uuid: uuid('000c'), kind: 'range', optional: true, fmt: usFmt },
  { id: 'limit',    uuid: uuid('0002'), kind: 'range', fmt: v => `${v.toFixed(0)}°` },
  { id: 'trim',     uuid: uuid('0003'), kind: 'range', fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(0)} µs` },
  { id: 'deadband', uuid: uuid('0004'), kind: 'range', fmt: v => `${v.toFixed(1)}°` },
  { id: 'alpha',    uuid: uuid('0005'), kind: 'range', fmt: v => v.toFixed(3) },
  { id: 'reverse',  uuid: uuid('0006'), kind: 'check' },
];
const STATUS_UUID  = uuid('0010');
const COMMAND_UUID = uuid('0020');
const RESULT_UUID  = uuid('0021');
// ブラックボックス (古いファームウェアには無い)
const LOG_CTRL_UUID   = uuid('0030');
const LOG_STATUS_UUID = uuid('0031');
const LOG_DATA_UUID   = uuid('0032');
const CMD = { save: 1, level: 2, defaults: 3, reference: 4 };
const RESULT = { saveOk: 1, saveFail: 2, refMoved: 3 };

const $ = id => document.getElementById(id);
$('appVer').textContent = `アプリ v${APP_VERSION}`;
const VERSION_UUID = uuid('0040');   // 本体のプログラムの版 (古いファームウェアには無い)

// 本体のプログラムの版をタイトル横に出す (切断後も最後に読んだ版を出したままにする)
async function readFirmwareVersion(service) {
  const ch = await getOptional(service, VERSION_UUID);
  let text = '本体 v2.3以前';
  if (ch) {
    try { text = '本体 v' + new TextDecoder().decode(await ch.readValue()).replace(/\0+$/, ''); } catch {}
  }
  $('fwVer').textContent = text;
  $('fwVer').hidden = false;
}
let device = null;
const chars = {};

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function isConnected() {
  return !!(device && device.gatt.connected);
}

function setEnabled(on) {
  document.querySelectorAll('#params input, #params button, .actions button').forEach(el => el.disabled = !on);
}
setEnabled(false);

let toastTimer = null;
function showToast(text, cls = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast ' + cls, 2500);
}

// 本体に保存していない変更があるか
function setDirty(on) {
  $('dirty').hidden = !on;
}

const f32 = v => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.buffer; };

// ---- モード切り替え ----
function showMode(mode) {
  $('home').hidden = true;
  $('modeTabs').hidden = false;
  $('tune').hidden = mode !== 'tune';
  $('blackbox').hidden = mode !== 'blackbox';
  document.body.classList.toggle('wide', mode === 'blackbox');
  document.querySelectorAll('#modeTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if (mode === 'blackbox' && typeof bbOnShow === 'function') bbOnShow();
}
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => showMode(b.dataset.mode)));

// ---- GATT 操作の順番待ち ----
// GATT 操作は同時に1つしかできないので、順番に実行する。
// 同じ項目の書き込みが溜まったら最新の値だけ送る。
// 応答が返らない操作があっても後ろが止まらないよう、1つの操作は最大 5 秒で打ち切る。
let queue = Promise.resolve();
const pending = new Map();
const OP_TIMEOUT_MS = 5000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('本体から応答がありません')), OP_TIMEOUT_MS)),
  ]);
}

function enqueueWrite(key, fn) {
  const already = pending.has(key);
  pending.set(key, fn);
  if (already) return;
  queue = queue.then(() => {
    const job = pending.get(key);
    pending.delete(key);
    if (!job) return;
    return withTimeout(job());
  }).catch(err => { console.error(err); setStatus('書き込み失敗: ' + err.message, 'err'); });
}

// 結果を待てる版 (ブラックボックスのコマンドに使う)
function enqueueOp(fn) {
  return new Promise((resolve, reject) => {
    queue = queue.then(() => withTimeout(fn()).then(resolve, reject)).catch(() => {});
  });
}

function resetQueue() {
  pending.clear();
  queue = Promise.resolve();
}

// ---- 角度調整モード ----
const values = {};   // 本体の今の設定値

function showValue(p, v) {
  const input = $(p.id);
  values[p.id] = v;
  if (p.kind === 'range') {
    input.value = v;
    $(p.id + 'Val').textContent = p.fmt(v);
  } else if (p.kind === 'check') {
    input.checked = v >= 0.5;
  } else if (p.kind === 'choice') {
    const i = Math.round(v);
    input.querySelectorAll('input').forEach(r => r.checked = Number(r.value) === i);
    $(p.id + 'Val').textContent = p.fmt(i);
  }
  updateSourceUI();
}

// 比率の決め方に合わせて、受信機の設定欄を出したり隠したりする
function updateSourceUI() {
  const hasPwm = !!chars.source;
  const pwm = hasPwm && Math.round(values.source || 0) === 1;
  $('sourceRow').hidden = !hasPwm;
  $('pwmGroup').hidden = !pwm;
  $('ratioName').textContent = pwm ? '信号が無いときの比率' : '比率';
  $('ratioHint').textContent = pwm
    ? '受信機の信号が来ていないときは、この比率を使います'
    : 'サーボ角 ＝ ボードの傾き × 比率';
  if (values.pwmLow !== undefined) $('pwmLowEcho').textContent = usFmt(values.pwmLow);
  if (values.pwmHigh !== undefined) $('pwmHighEcho').textContent = usFmt(values.pwmHigh);
}

async function readAll() {
  for (const p of PARAMS) {
    if (!chars[p.id]) continue;
    const dv = await chars[p.id].readValue();
    showValue(p, dv.getFloat32(0, true));
  }
}

function onStatus(e) {
  const dv = e.target.value;
  const board = dv.getFloat32(0, true);
  const us = dv.getFloat32(4, true);
  $('board').textContent = `${board.toFixed(1)}°`;
  $('servo').textContent = `${us.toFixed(0)} µs`;
  // 500～2500us → -90～+90°
  showRiderLean((us - 1500) / 1000 * 90);

  // 新しいファームウェアは 受信機の信号・今の比率・基準姿勢の有無 も送ってくる
  if (dv.byteLength >= 20) {
    lastPwmUs = dv.getFloat32(8, true);
    const ratio = dv.getFloat32(12, true);
    refValid = dv.getFloat32(16, true) >= 0.5;
    const pwm = Math.round(values.source || 0) === 1;
    const pwmText = lastPwmUs > 0 ? `${lastPwmUs.toFixed(0)} µs` : '信号なし';
    $('pwmNow').textContent = pwmText;
    $('liveRatio').innerHTML = `比率 <b>× ${ratio.toFixed(2)}</b>（${pwm ? '受信機 ' + pwmText : 'アプリ'}）`;
    $('liveRatio').hidden = false;
    $('refMissing').hidden = refValid;
  }
}
let lastPwmUs = 0;
let refValid = true;

// イラストを接地点を中心に回す (+ で右に傾く)
function showRiderLean(deg) {
  $('riderImg').style.transform = `rotate(${deg.toFixed(1)}deg)`;
}
showRiderLean(0);

// ---- 接続 ----
// 「接続」ボタン: 一覧から HangOff を選んで接続する
async function pickAndConnect() {
  if (!navigator.bluetooth) {
    setStatus('このブラウザは Bluetooth に対応していません（Android は Chrome、iPhone は Bluefy で開いてください）', 'err');
    return;
  }
  try {
    setStatus('一覧から HangOff を選んでください…');
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    await connect(dev);
  } catch (err) {
    if (err.name === 'NotFoundError') setStatus('未接続');   // 一覧を閉じた
    else setStatus('接続失敗: ' + err.message, 'err');
  }
}

// 前回接続した HangOff に、一覧を出さずに自動でつなぐ (対応ブラウザのみ)
async function autoConnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  let devices;
  try { devices = await navigator.bluetooth.getDevices(); } catch { return; }
  const dev = devices.find(d => (d.name || '').startsWith('HangOff')) || devices[0];
  if (!dev) return;

  setStatus('前回の HangOff を探しています…（電源を入れてください）');
  if (dev.watchAdvertisements) {
    // 電波が届いたら接続する
    const onAdv = () => {
      dev.removeEventListener('advertisementreceived', onAdv);
      connect(dev).catch(() => setStatus('未接続'));
    };
    dev.addEventListener('advertisementreceived', onAdv);
    try { await dev.watchAdvertisements(); return; } catch { dev.removeEventListener('advertisementreceived', onAdv); }
  }
  try { await connect(dev); } catch { setStatus('未接続'); }
}

let userDisconnect = false;
// 本体がわざと切断するとき (記録の準備) は、この時刻まで再接続を続ける
let reconnectUntil = 0;
function expectDisconnect(ms) {
  reconnectUntil = Date.now() + ms;
}

async function getOptional(service, id) {
  try { return await service.getCharacteristic(id); } catch { return null; }
}

async function connect(dev) {
  if (device !== dev) {
    if (device) device.removeEventListener('gattserverdisconnected', onDisconnected);
    device = dev;
    device.addEventListener('gattserverdisconnected', onDisconnected);
  }
  try {
    setStatus('接続中…');
    // 本体が電波を止めているとき、ブラウザによっては接続がいつまでも終わらないので 10 秒で打ち切る
    const server = await Promise.race([
      device.gatt.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('接続がタイムアウトしました')), 10000)),
    ]);
    const service = await server.getPrimaryService(SERVICE);
    for (const p of PARAMS) {
      chars[p.id] = p.optional ? await getOptional(service, p.uuid) : await service.getCharacteristic(p.uuid);
    }
    $('axisRow').hidden = !chars.axis;
    await readFirmwareVersion(service);
    // 基準姿勢の記録は新しいファームウェアだけ (古いものは「今の傾きを水平にする」)
    $('reference').hidden = $('refNote').hidden = !chars.source;
    $('level').hidden = !!chars.source;
    updateSourceUI();
    chars.command = await service.getCharacteristic(COMMAND_UUID);
    chars.status  = await service.getCharacteristic(STATUS_UUID);
    // 保存結果の通知 (古いファームウェアには無い)
    chars.result = await getOptional(service, RESULT_UUID);
    if (chars.result) {
      chars.result.addEventListener('characteristicvaluechanged', onResult);
      await chars.result.startNotifications();
      // 保存のために本体が切断した後なら、残っている結果を読む
      if (saveResolve) {
        const r = (await chars.result.readValue()).getUint8(0);
        if (r && saveResolve) { saveResolve(r); saveResolve = null; }
      }
    }
    // ブラックボックス (古いファームウェアには無い)
    chars.logCtrl   = await getOptional(service, LOG_CTRL_UUID);
    chars.logStatus = await getOptional(service, LOG_STATUS_UUID);
    chars.logData   = await getOptional(service, LOG_DATA_UUID);

    await readAll();
    chars.status.addEventListener('characteristicvaluechanged', onStatus);
    await chars.status.startNotifications();
    if (typeof bbOnConnected === 'function') await bbOnConnected();

    setEnabled(true);
    setStatus(`接続済み: ${device.name || 'HangOff'}`, 'on');
    $('connect').textContent = '切断';
  } catch (err) {
    console.error(err);
    device.gatt.disconnect();   // 途中の接続も取り消す
    throw err;
  }
}

let reconnecting = false;

async function onDisconnected() {
  if (reconnecting) return;   // 再接続の試行中に起きた切断は、今の再接続ループに任せる
  resetQueue();
  setEnabled(false);
  $('connect').textContent = '接続';
  $('board').textContent = '--';
  $('servo').textContent = '--';
  $('liveRatio').hidden = true;
  lastPwmUs = 0;
  if (typeof bbOnDisconnected === 'function') bbOnDisconnected();
  if (userDisconnect) { userDisconnect = false; setStatus('切断しました'); return; }

  // 保存時や電波が弱くて切れたときは自動で再接続する
  const planned = Date.now() < reconnectUntil;
  reconnecting = true;
  try {
    for (let i = 1; i <= 5 || Date.now() < reconnectUntil; i++) {
      setStatus(planned ? '本体がメモリに保存中です。終わったら自動で再接続します…' : `切断されました。再接続しています…（${i}/5）`);
      await new Promise(r => setTimeout(r, 1000));
      try { await connect(device); reconnectUntil = 0; return; } catch {}
    }
  } finally {
    reconnecting = false;
  }
  reconnectUntil = 0;
  setStatus('切断されました。「接続」を押してください', 'err');
}

$('connect').addEventListener('click', () => {
  if (isConnected()) { userDisconnect = true; device.gatt.disconnect(); }
  else pickAndConnect();
});

for (const p of PARAMS) {
  const input = $(p.id);
  if (p.kind === 'range') {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      $(p.id + 'Val').textContent = p.fmt(v);
      values[p.id] = v;
      updateSourceUI();
      setDirty(true);
      enqueueWrite(p.id, () => chars[p.id].writeValueWithResponse(f32(v)));
    });
  } else if (p.kind === 'check') {
    input.addEventListener('change', () => {
      setDirty(true);
      enqueueWrite(p.id, () => chars[p.id].writeValueWithResponse(f32(input.checked ? 1 : 0)));
    });
  } else if (p.kind === 'choice') {
    input.addEventListener('change', e => {
      const i = Number(e.target.value);
      $(p.id + 'Val').textContent = p.fmt(i);
      values[p.id] = i;
      updateSourceUI();
      setDirty(true);
      enqueueWrite(p.id, async () => {
        await chars[p.id].writeValueWithResponse(f32(i));
        if (p.id === 'axis') {
          showToast(chars.source && refValid
            ? `${AXIS_NAMES[i]} 軸に切り替えました（0° は記録した基準姿勢）`
            : `${AXIS_NAMES[i]} 軸に切り替え、今の向きを 0° にしました`);
        }
      });
    });
  }
}

// 受信機の今の信号を下限・上限にする
function setPwmEnd(id) {
  if (!(lastPwmUs > 0)) { showToast('受信機の信号が来ていません。配線と受信機の電源を確認してください', 'ng'); return; }
  const p = PARAMS.find(q => q.id === id);
  const v = Math.round(lastPwmUs / 10) * 10;
  showValue(p, v);
  setDirty(true);
  enqueueWrite(id, () => chars[id].writeValueWithResponse(f32(v)));
}
$('pwmSetLow').addEventListener('click', () => setPwmEnd('pwmLow'));
$('pwmSetHigh').addEventListener('click', () => setPwmEnd('pwmHigh'));

// 水平記憶・初期値に戻す (本体側で値が変わるので読み直す)
function sendCommand(cmd, doneText) {
  enqueueWrite('cmd' + cmd, async () => {
    await chars.command.writeValueWithResponse(new Uint8Array([cmd]));
    await readAll();
    setDirty(true);
    showToast(doneText);
  });
}

$('level').addEventListener('click', () => sendCommand(CMD.level, '今の傾きを水平にしました'));
$('defaults').addEventListener('click', () => {
  if (confirm('設定を初期値に戻しますか？')) sendCommand(CMD.defaults, '初期値に戻しました');
});

// ---- 保存 ----
let saveResolve = null;

function onResult(e) {
  const r = e.target.value.getUint8(0);
  if (r && saveResolve) { saveResolve(r); saveResolve = null; }   // 0 は「保存を受け付けた」
}

function setSaveButton(text, cls) {
  const btn = $('save');
  btn.textContent = text;
  btn.classList.remove('ok', 'ng');
  if (cls) btn.classList.add(cls);
}

// 保存を伴うコマンドを送り、結果 (RESULT の値 / 'timeout') を待つ。
// v2.4 までの本体は保存のためにいったん切断するので、再接続して結果を読むまで待つ
// (結果通知が無い古いファームウェアなら書き込み完了で成功とみなす)
async function commandWithResult(cmd) {
  const result = new Promise(resolve => {
    saveResolve = resolve;
    setTimeout(() => { if (saveResolve === resolve) { saveResolve = null; resolve('timeout'); } }, 20000);
  });
  expectDisconnect(15000);
  let written = false;
  enqueueWrite('cmd' + cmd, async () => {
    await chars.command.writeValueWithResponse(new Uint8Array([cmd]));
    written = true;
    if (!chars.result && saveResolve) { saveResolve(RESULT.saveOk); saveResolve = null; }
  });
  const r = await result;
  // v2.5 以降は接続したまま保存するので、結果が届いたら「わざとの切断」の待ちを終える
  if (isConnected()) reconnectUntil = 0;
  return { r, written };
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  setSaveButton('保存中…');

  const { r, written } = await commandWithResult(CMD.save);
  if (r === RESULT.saveOk) {
    setDirty(false);
    setSaveButton('✓ 保存しました', 'ok');
    showToast('✓ 本体に保存しました', 'ok');
  } else if (r === RESULT.saveFail) {
    setSaveButton('✕ 保存に失敗しました', 'ng');
    showToast('保存に失敗しました。もう一度押してください', 'ng');
  } else {
    setSaveButton('? 確認できませんでした', 'ng');
    showToast(written ? '保存結果を確認できませんでした' : '本体に届きませんでした。接続を確認してください', 'ng');
  }

  // 結果表示のあと元に戻す (切断中なら再接続時に有効になる)
  setTimeout(() => {
    setSaveButton('本体に保存');
    btn.disabled = !isConnected();
  }, 2000);
}

$('save').addEventListener('click', save);

// ---- 基準姿勢の記録 ----
// 本体が1秒間測って記録し、そのまま本体に保存する
async function captureReference() {
  const btn = $('reference');
  btn.disabled = true;
  btn.classList.remove('ok', 'ng');
  btn.textContent = '測定中… 動かさないでください';
  showToast('そのまま約1秒、動かさないでください');

  const { r, written } = await commandWithResult(CMD.reference);
  if (r === RESULT.saveOk) {
    setDirty(false);
    refValid = true;
    $('refMissing').hidden = true;
    btn.textContent = '✓ 基準姿勢を記録しました';
    btn.classList.add('ok');
    showToast('✓ 基準姿勢を記録して、本体に保存しました', 'ok');
  } else if (r === RESULT.refMoved) {
    btn.textContent = '✕ 動いていました';
    btn.classList.add('ng');
    showToast('測定中に動いていたので記録しませんでした。止めてからもう一度押してください', 'ng');
  } else if (r === RESULT.saveFail) {
    btn.textContent = '✕ 保存に失敗しました';
    btn.classList.add('ng');
    showToast('保存に失敗しました。もう一度押してください', 'ng');
  } else {
    btn.textContent = '? 確認できませんでした';
    btn.classList.add('ng');
    showToast(written ? '結果を確認できませんでした' : '本体に届きませんでした。接続を確認してください', 'ng');
  }

  setTimeout(() => {
    btn.textContent = '基準姿勢を記録';
    btn.classList.remove('ok', 'ng');
    btn.disabled = !isConnected();
  }, 2500);
}

$('reference').addEventListener('click', captureReference);

// 全部のスクリプトを読み込んでから自動接続を始める
window.addEventListener('load', () => {
  autoConnect();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js');
  }
});
