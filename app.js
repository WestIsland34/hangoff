'use strict';
// =====================================================================
// HangOff: 接続・モード切り替え・角度調整モード
// UUID は HangOff.ino と同じにすること
// =====================================================================

// 画面の版。ファイルを変えたら上げる (sw.js の CACHE も合わせて上げる)
const APP_VERSION = '2.3';

const uuid = n => `a7c3${n}-5b1e-4d6a-9f2e-3c8b1d0e7a51`;
const SERVICE = uuid('0000');

// 入力欄と BLE キャラクタリスティックの対応
//   kind: range (スライダー) / check (チェックボックス) / axis (X/Y/Z 選択)
//   optional: 古いファームウェアには無い項目 (無ければ欄を隠す)
const AXIS_NAMES = ['X', 'Y', 'Z'];
const PARAMS = [
  { id: 'axis',     uuid: uuid('0007'), kind: 'axis', optional: true },
  { id: 'ratio',    uuid: uuid('0001'), kind: 'range', fmt: v => `× ${v.toFixed(2)}` },
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
const CMD = { save: 1, level: 2, defaults: 3 };
const RESULT = { saveOk: 1, saveFail: 2 };

const $ = id => document.getElementById(id);
$('appVer').textContent = `v${APP_VERSION}`;
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
  document.querySelectorAll('#params input, .actions button').forEach(el => el.disabled = !on);
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
function showValue(p, v) {
  const input = $(p.id);
  if (p.kind === 'range') {
    input.value = v;
    $(p.id + 'Val').textContent = p.fmt(v);
  } else if (p.kind === 'check') {
    input.checked = v >= 0.5;
  } else if (p.kind === 'axis') {
    const i = Math.round(v);
    input.querySelectorAll('input').forEach(r => r.checked = Number(r.value) === i);
    $('axisVal').textContent = AXIS_NAMES[i] ? `${AXIS_NAMES[i]} 軸` : '-';
  }
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
}

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
      setDirty(true);
      enqueueWrite(p.id, () => chars[p.id].writeValueWithResponse(f32(v)));
    });
  } else if (p.kind === 'check') {
    input.addEventListener('change', () => {
      setDirty(true);
      enqueueWrite(p.id, () => chars[p.id].writeValueWithResponse(f32(input.checked ? 1 : 0)));
    });
  } else if (p.kind === 'axis') {
    input.addEventListener('change', e => {
      const i = Number(e.target.value);
      $('axisVal').textContent = `${AXIS_NAMES[i]} 軸`;
      setDirty(true);
      enqueueWrite(p.id, async () => {
        await chars[p.id].writeValueWithResponse(f32(i));
        showToast(`${AXIS_NAMES[i]} 軸に切り替え、今の向きを水平にしました`);
      });
    });
  }
}

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

async function save() {
  const btn = $('save');
  btn.disabled = true;
  setSaveButton('保存中…');

  // 本体は保存のためにいったん切断するので、再接続して結果を読むまで待つ
  // (結果通知が無い古いファームウェアなら書き込み完了で成功とみなす)
  const result = new Promise(resolve => {
    saveResolve = resolve;
    setTimeout(() => { if (saveResolve === resolve) { saveResolve = null; resolve('timeout'); } }, 20000);
  });
  expectDisconnect(15000);
  let written = false;
  enqueueWrite('save', async () => {
    await chars.command.writeValueWithResponse(new Uint8Array([CMD.save]));
    written = true;
    if (!chars.result && saveResolve) { saveResolve(RESULT.saveOk); saveResolve = null; }
  });

  const r = await result;
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

// 全部のスクリプトを読み込んでから自動接続を始める
window.addEventListener('load', () => {
  autoConnect();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js');
  }
});
