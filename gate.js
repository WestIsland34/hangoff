// 合言葉の画面 (2026-11-27、使う人の希望で /hangoff/ の下のページに付けた)。
// ・ページの最初 (<head> の先頭) で読み込む。合言葉が済むまでページ全体を隠す。
// ・合言葉そのものは置かず、SHA-256 のハッシュ値だけを置く。
// ・一度通った端末では localStorage に覚えて、次から聞かない (オフラインでも開ける)。
// ・GitHub のリポジトリは公開なので、これは「たまたま見つけた人を止める」ための簡易な鍵。
//   app.js や画像などのファイルは、アドレスを直接開けば読める。
(function () {
  var HASH = '56585a8d055be478f37fb0bafc2cff7ee1abd2ee8e1175918f84f0f51e2b55bf';  // 合言葉の SHA-256
  var KEY = 'hangoff-gate';

  try { if (localStorage.getItem(KEY) === HASH) return; } catch (e) {}

  var root = document.documentElement;
  root.style.visibility = 'hidden';

  function norm(s) { return (s.normalize ? s.normalize('NFKC') : s).trim(); }

  function sha256hex(s) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  function show() {
    var css = document.createElement('style');
    css.textContent =
      '#hgGate{position:fixed;inset:0;z-index:2147483647;visibility:visible;display:grid;place-items:center;' +
      'background:#f4f5f7;color:#1d2129;font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;padding:16px}' +
      '#hgGate form{width:100%;max-width:320px;background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:20px}' +
      '#hgGate h1{font-size:20px;margin:0 0 4px}#hgGate p{font-size:14px;color:#6b7280;margin:0 0 14px}' +
      '#hgGate input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:10px 12px;border:1px solid #e2e5ea;border-radius:8px;background:#fff;color:#1d2129}' +
      '#hgGate button{width:100%;margin-top:10px;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:#e8590c;color:#fff;cursor:pointer}' +
      '#hgGate .err{color:#c92a2a;font-size:13px;margin:8px 0 0;min-height:1.2em}' +
      '@media (prefers-color-scheme:dark){#hgGate{background:#15171c;color:#e8eaed}' +
      '#hgGate form{background:#1f232b;border-color:#323844}#hgGate p{color:#9aa0a9}' +
      '#hgGate input{background:#15171c;color:#e8eaed;border-color:#323844}#hgGate button{background:#ff7a2e;color:#15171c}' +
      '#hgGate .err{color:#ff6b6b}}';
    document.head.appendChild(css);

    var box = document.createElement('div');
    box.id = 'hgGate';
    box.innerHTML =
      '<form autocomplete="off"><h1>HangOff</h1><p>合言葉を入れてください</p>' +
      '<input type="password" aria-label="合言葉" autofocus>' +
      '<button type="submit">入る</button><div class="err" role="alert"></div></form>';
    document.body.appendChild(box);

    var input = box.querySelector('input');
    var err = box.querySelector('.err');
    input.focus();
    box.querySelector('form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      sha256hex(norm(input.value)).then(function (h) {
        if (h === HASH) {
          try { localStorage.setItem(KEY, HASH); } catch (e) {}
          box.remove();
          root.style.visibility = '';
        } else {
          err.textContent = '合言葉が違います';
          input.select();
        }
      });
    });
  }

  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
