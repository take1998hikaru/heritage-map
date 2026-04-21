/* Heritage Map — Gist sync
 *
 * Syncs two localStorage slots across devices through a single GitHub Gist:
 *   heritage_map_checks_v1  (3-round check state)
 *   heritage_map_quiz_v1    (per-question answer history)
 *
 * The Gist stores one file `heritage_data.json` with:
 *   { version, lastModified, checks: {...}, quiz: {...} }
 *
 * Auth: user's GitHub Personal Access Token with `gist` scope.
 * Both token and gist id are kept in localStorage on each device.
 *
 * Merge strategy:
 *   - checks:  whole-object, last-writer-wins based on lastModified.
 *   - quiz:    per-question, keeps the entry with the newer `ts`.
 *
 * UI helpers (status pill, settings modal) are included and attached
 * at the end of this file when it sees the appropriate anchor elements.
 */
(function(global) {
  'use strict';

  var CHECKS_KEY = 'heritage_map_checks_v1';
  var QUIZ_KEY   = 'heritage_map_quiz_v1';
  var LAST_MOD_KEY = 'heritage_map_last_mod';
  var TOKEN_KEY  = 'heritage_sync_token';
  var GIST_ID_KEY = 'heritage_sync_gist_id';
  var GIST_FILE  = 'heritage_data.json';
  var DEBOUNCE_MS = 2000;

  var API = 'https://api.github.com';

  // Public namespace
  var HSync = {
    status: 'disabled',     // disabled | syncing | synced | error
    lastSyncAt: null,
    lastError: null,
    // Consumers can override these to refresh their UI after sync
    onStatusChange: function() {},
    onDataLoaded:   function() {},
  };

  // --- localStorage helpers ------------------------------------------------
  // We capture the original setItem up front so internal writes (from
  // saveLocal / merge flow) can bypass the interceptor installed further
  // down. Without this, a pull or push would rewrite CHECKS_KEY, which
  // would re-trigger pushDebounced and form an infinite feedback loop
  // (observed symptom: status cycling between "syncing" and "error").
  var _origSetItem = localStorage.setItem.bind(localStorage);
  function _internalSet(key, val) {
    try { _origSetItem(key, val); } catch (e) {}
  }
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
    catch (e) { return fallback; }
  }
  // Accept common paste formats and extract the 20+ hex-char Gist id.
  //   - raw id       : e53b...
  //   - full URL     : https://gist.github.com/user/e53b...
  //   - gist+user    : take1998hikaru/e53b...
  // If no hex id is found we keep the input trimmed so errors surface.
  function normalizeGistId(s) {
    if (!s) return '';
    s = String(s).trim();
    var m = s.match(/([0-9a-fA-F]{20,})/);
    return m ? m[1] : s;
  }

  HSync.getToken  = function() { return (localStorage.getItem(TOKEN_KEY) || '').trim(); };
  HSync.setToken  = function(t) {
    t = (t || '').trim();
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  };
  HSync.getGistId = function() { return (localStorage.getItem(GIST_ID_KEY) || '').trim(); };
  HSync.setGistId = function(g) {
    var id = normalizeGistId(g);
    if (id) localStorage.setItem(GIST_ID_KEY, id); else localStorage.removeItem(GIST_ID_KEY);
  };
  HSync.clearConfig = function() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(GIST_ID_KEY);
    localStorage.removeItem(LAST_MOD_KEY);
    setStatus('disabled');
  };

  // --- local snapshot ------------------------------------------------------
  function loadLocal() {
    return {
      version: 1,
      lastModified: localStorage.getItem(LAST_MOD_KEY) || new Date(0).toISOString(),
      checks: readJSON(CHECKS_KEY, {}),
      quiz:   readJSON(QUIZ_KEY,   {}),
    };
  }
  function saveLocal(data) {
    // Internal writes bypass the setItem interceptor to avoid push loops.
    _internalSet(CHECKS_KEY, JSON.stringify(data.checks || {}));
    _internalSet(QUIZ_KEY,   JSON.stringify(data.quiz   || {}));
    _internalSet(LAST_MOD_KEY, data.lastModified || new Date().toISOString());
  }

  // --- merge ---------------------------------------------------------------
  // WARNING about data loss:
  //   A previous version used "last-writer-wins" on the whole checks
  //   object, keyed by lastModified. That lost data when a freshly
  //   installed device (with empty localStorage) pushed before pulling —
  //   its "now" timestamp beat the other device's last-push timestamp and
  //   wiped a full session of checks.
  //
  //   We now merge per heritage, keeping the MAX count. 3周チェックは
  //   0→1→2→3 に単調増加するだけなので、max で失われる情報は無い。
  //   Trade-off: a "全リセット" by the user is eclipsed by another
  //   device's older non-zero values and comes back. Acceptable: resets
  //   are rare and the user can redo them on the "winning" device.
  function merge(local, remote) {
    var lt = Date.parse(local.lastModified  || '1970-01-01T00:00:00Z') || 0;
    var rt = Date.parse(remote.lastModified || '1970-01-01T00:00:00Z') || 0;

    var checks = {};
    var lc = local.checks  || {};
    var rc = remote.checks || {};
    var keys = {};
    Object.keys(lc).forEach(function(k) { keys[k] = 1; });
    Object.keys(rc).forEach(function(k) { keys[k] = 1; });
    Object.keys(keys).forEach(function(k) {
      var v = Math.max(+lc[k] || 0, +rc[k] || 0);
      if (v > 0) checks[k] = v;
    });

    // quiz: per-question by ts
    var quiz = {};
    [local.quiz, remote.quiz].forEach(function(src) {
      if (!src) return;
      Object.keys(src).forEach(function(h) {
        var bucket = quiz[h] = quiz[h] || {};
        Object.keys(src[h] || {}).forEach(function(qk) {
          var item = src[h][qk];
          var cur = bucket[qk];
          if (!cur || (item && (item.ts || 0) > (cur.ts || 0))) bucket[qk] = item;
        });
      });
    });
    return {
      version: 1,
      lastModified: new Date(Math.max(lt, rt)).toISOString(),
      checks: checks,
      quiz:   quiz,
    };
  }

  // --- Gist API wrappers ---------------------------------------------------
  function authHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
  function humanizeStatus(status, action) {
    if (status === 401) return 'トークンが無効です。再発行してください (401)';
    if (status === 403) return 'gistスコープが無いか、レート制限です (403)';
    if (status === 404) return 'Gist IDが見つかりません (404)。空欄にすれば自動作成されます';
    if (status === 422) return 'リクエスト形式エラー (422)';
    if (status === 429) return 'GitHub APIのレート制限です (429)。少し待ってから再試行してください';
    if (status >= 500)  return 'GitHubサーバ側のエラー (' + status + ')';
    return (action || 'Gist操作') + '失敗 (' + status + ')';
  }
  async function readMaybeError(r) {
    try {
      var j = await r.json();
      if (j && j.message) return ' — ' + j.message;
    } catch (e) {}
    return '';
  }
  async function fetchGist(token, gistId) {
    var r = await fetch(API + '/gists/' + gistId, { headers: authHeaders(token) });
    if (!r.ok) throw new Error(humanizeStatus(r.status, 'Gist取得') + await readMaybeError(r));
    return await r.json();
  }
  async function updateGist(token, gistId, content, opts) {
    var init = {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(token)),
      body: JSON.stringify({ files: (function() {
        var f = {}; f[GIST_FILE] = { content: JSON.stringify(content, null, 2) }; return f;
      })() })
    };
    // keepalive lets the browser finish the request even if the page is
    // being unloaded / the PWA is being suspended.
    if (opts && opts.keepalive) init.keepalive = true;
    var r = await fetch(API + '/gists/' + gistId, init);
    if (!r.ok) throw new Error(humanizeStatus(r.status, 'Gist更新') + await readMaybeError(r));
    return await r.json();
  }
  async function createGist(token, content) {
    var body = {
      description: 'Heritage map study progress (auto-managed)',
      public: false,
      files: (function() {
        var f = {}; f[GIST_FILE] = { content: JSON.stringify(content, null, 2) }; return f;
      })()
    };
    var r = await fetch(API + '/gists', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(token)),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(humanizeStatus(r.status, 'Gist作成') + await readMaybeError(r));
    return await r.json();
  }
  async function findGistByFile(token) {
    // User has at most ~100 Gists normally; paginate a few pages to be safe.
    for (var page = 1; page <= 3; page++) {
      var r = await fetch(API + '/gists?per_page=100&page=' + page, { headers: authHeaders(token) });
      if (!r.ok) throw new Error(humanizeStatus(r.status, 'Gist一覧') + await readMaybeError(r));
      var list = await r.json();
      if (!list.length) break;
      for (var i = 0; i < list.length; i++) {
        if (list[i].files && list[i].files[GIST_FILE]) return list[i];
      }
      if (list.length < 100) break;
    }
    return null;
  }

  // --- Status plumbing -----------------------------------------------------
  function setStatus(s, err) {
    HSync.status = s;
    if (err !== undefined) HSync.lastError = err;
    try { HSync.onStatusChange(s); } catch (e) {}
  }

  // --- High-level operations ----------------------------------------------
  HSync.pull = async function() {
    var token = HSync.getToken();
    if (!token) { setStatus('disabled'); return; }
    setStatus('syncing');
    try {
      var gistId = HSync.getGistId();
      if (!gistId) {
        var found = await findGistByFile(token);
        if (found) { gistId = found.id; HSync.setGistId(gistId); }
        else { setStatus('synced'); return; }   // nothing to pull yet
      }
      var gist = await fetchGist(token, gistId);
      var file = gist.files && gist.files[GIST_FILE];
      if (!file || !file.content) { setStatus('synced'); return; }
      var remote = JSON.parse(file.content);
      var local  = loadLocal();
      var merged = merge(local, remote);
      saveLocal(merged);
      HSync.lastSyncAt = new Date();
      setStatus('synced', null);
      try { HSync.onDataLoaded(merged); } catch (e) {}
    } catch (e) {
      setStatus('error', e.message);
      console.warn('[HSync] pull failed:', e);
    }
  };

  HSync.push = async function(opts) {
    var token = HSync.getToken();
    if (!token) { setStatus('disabled'); return; }
    setStatus('syncing');
    try {
      var local = loadLocal();
      local.lastModified = new Date().toISOString();
      saveLocal(local);

      var gistId = HSync.getGistId();
      if (gistId) {
        await updateGist(token, gistId, local, opts);
      } else {
        var found = await findGistByFile(token);
        if (found) { gistId = found.id; HSync.setGistId(gistId); await updateGist(token, gistId, local, opts); }
        else       { var ng = await createGist(token, local); HSync.setGistId(ng.id); }
      }
      HSync.lastSyncAt = new Date();
      setStatus('synced', null);
    } catch (e) {
      setStatus('error', e.message);
      console.warn('[HSync] push failed:', e);
    }
  };

  var pushTimer = null;
  HSync.pushDebounced = function() {
    if (!HSync.getToken()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function() {
      pushTimer = null;
      HSync.push();
    }, DEBOUNCE_MS);
  };

  // If a debounced push is pending, fire it immediately. Used when the app
  // is about to be backgrounded / closed so the 2-second timer doesn't get
  // suspended by iOS / Android PWAs before it fires.
  HSync.flushPendingPush = function() {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
      return HSync.push({ keepalive: true });
    }
    return Promise.resolve();
  };

  // Intercept writes to the two tracked localStorage keys so any module that
  // updates state automatically triggers a debounced sync — no need to edit
  // every existing setItem call site. NOTE: saveLocal() uses _internalSet
  // directly so it does NOT come through here, which would otherwise cause
  // push → save → push infinite loops.
  localStorage.setItem = function(k, v) {
    _origSetItem(k, v);
    if (k === CHECKS_KEY || k === QUIZ_KEY) {
      // Bump lastModified locally so the next merge recognises us as newer.
      _origSetItem(LAST_MOD_KEY, new Date().toISOString());
      HSync.pushDebounced();
    }
  };

  HSync.autoSyncOnLoad = async function() {
    if (!HSync.getToken()) { setStatus('disabled'); return; }
    await HSync.pull();
  };

  // ------------------------------------------------------------------------
  // Optional UI helpers
  // ------------------------------------------------------------------------

  var STATUS_TEXT = {
    disabled: '⚪ 同期オフ',
    syncing:  '🟡 同期中…',
    synced:   '🟢 最新',
    error:    '🔴 エラー',
  };

  // Inject status pill into an element with id="hsync-status-pill" (if present).
  function renderStatusPill() {
    var el = document.getElementById('hsync-status-pill');
    if (!el) return;
    var s = HSync.status;
    el.textContent = STATUS_TEXT[s] || '';
    el.title = HSync.lastError && s === 'error' ? HSync.lastError : '';
    el.dataset.syncStatus = s;
  }

  // Settings modal: toggled by element with id="hsync-open-settings"
  function mountSettingsModal() {
    if (document.getElementById('hsync-modal')) return;
    var html = ''
      + '<div id="hsync-modal" class="hsync-modal" hidden>'
      +   '<div class="hsync-box">'
      +     '<h3>⚙️ Gist同期設定</h3>'
      +     '<p class="hsync-desc">PCとスマホで学習進捗を同期します。GitHubのPersonal Access Token (<code>gist</code>スコープ) が必要です。</p>'
      +     '<label>GitHub Personal Access Token</label>'
      +     '<input type="password" id="hsync-token" placeholder="ghp_… または github_pat_…" autocomplete="off" spellcheck="false">'
      +     '<label>Gist ID <span class="hsync-optional">（任意・空欄なら自動で検出／作成）</span></label>'
      +     '<input type="text" id="hsync-gist-id" placeholder="例: a1b2c3… 省略可" autocomplete="off" spellcheck="false">'
      +     '<div class="hsync-row">'
      +       '<button id="hsync-save" type="button" class="hsync-btn-primary">保存して同期</button>'
      +       '<button id="hsync-pull-now" type="button">今すぐ取得</button>'
      +       '<button id="hsync-push-now" type="button">今すぐ送信</button>'
      +       '<button id="hsync-clear" type="button" class="hsync-btn-danger">設定をクリア</button>'
      +       '<button id="hsync-close" type="button" class="hsync-btn-ghost">閉じる</button>'
      +     '</div>'
      +     '<div id="hsync-msg" class="hsync-msg"></div>'
      +     '<p class="hsync-note">'
      +       'トークンはこの端末の localStorage にのみ保存されます。<br>'
      +       'ファイル名 <code>heritage_data.json</code> のGistを自動検出します。無ければ <strong>private Gist</strong> を自動作成します。'
      +     '</p>'
      +   '</div>'
      + '</div>';
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);

    // Minimal styles
    var style = document.createElement('style');
    style.textContent = [
      '.hsync-modal { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px; }',
      '.hsync-modal[hidden] { display:none !important; }',
      '.hsync-box { background:#fff; color:#222; border-radius:10px; padding:20px 22px; max-width:440px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,0.25); font-family:"Segoe UI","Yu Gothic UI","Meiryo",sans-serif; }',
      '.hsync-box h3 { margin:0 0 6px; font-size:16px; color:#1a5276; }',
      '.hsync-desc { margin:0 0 12px; font-size:12px; color:#555; line-height:1.5; }',
      '.hsync-desc code { background:#f0f0f0; padding:1px 5px; border-radius:3px; font-size:11px; }',
      '.hsync-box label { display:block; font-size:12px; font-weight:600; color:#555; margin:10px 0 4px; }',
      '.hsync-optional { font-weight:400; color:#888; }',
      '.hsync-box input { width:100%; padding:8px 10px; border:1px solid #ccc; border-radius:5px; font-size:13px; box-sizing:border-box; }',
      '.hsync-box input:focus { outline:none; border-color:#2980b9; }',
      '.hsync-row { display:flex; flex-wrap:wrap; gap:6px; margin-top:14px; }',
      '.hsync-row button { padding:7px 12px; font-size:12px; border:1px solid #ccc; background:#fff; color:#333; border-radius:5px; cursor:pointer; font-weight:600; }',
      '.hsync-row button:hover { background:#f4f6f8; border-color:#2980b9; color:#2980b9; }',
      '.hsync-btn-primary { background:#2980b9 !important; color:#fff !important; border-color:#2980b9 !important; }',
      '.hsync-btn-primary:hover { background:#1a5276 !important; }',
      '.hsync-btn-danger { color:#c62828 !important; border-color:#e0a0a0 !important; }',
      '.hsync-btn-danger:hover { background:#ffebee !important; color:#c62828 !important; }',
      '.hsync-btn-ghost { background:transparent !important; }',
      '.hsync-msg { margin-top:10px; font-size:12px; line-height:1.5; min-height:1.3em; }',
      '.hsync-msg.ok { color:#2e7d32; }',
      '.hsync-msg.ng { color:#c62828; }',
      '.hsync-note { margin-top:12px; font-size:11px; color:#888; line-height:1.6; }',
      '#hsync-status-pill { font-size:12px; padding:3px 9px; border-radius:12px; background:rgba(255,255,255,0.15); user-select:none; }',
      '#hsync-status-pill[data-sync-status="error"] { background:rgba(244,67,54,0.3); }',
      '#hsync-status-pill[data-sync-status="synced"] { background:rgba(46,125,50,0.3); }',
      ''
    ].join('\n');
    document.head.appendChild(style);

    var modal = document.getElementById('hsync-modal');
    var tokenIn = document.getElementById('hsync-token');
    var gistIn  = document.getElementById('hsync-gist-id');
    var msg     = document.getElementById('hsync-msg');

    function showMsg(text, ok) {
      msg.textContent = text || '';
      msg.className = 'hsync-msg' + (ok === true ? ' ok' : ok === false ? ' ng' : '');
    }
    function openModal() {
      tokenIn.value = HSync.getToken();
      gistIn.value  = HSync.getGistId();
      showMsg('');
      modal.hidden = false;
      setTimeout(function() { (HSync.getToken() ? gistIn : tokenIn).focus(); }, 10);
    }
    function closeModal() { modal.hidden = true; }

    var opener = document.getElementById('hsync-open-settings');
    if (opener) opener.addEventListener('click', openModal);
    document.getElementById('hsync-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function(e) { if (!modal.hidden && e.key === 'Escape') closeModal(); });

    document.getElementById('hsync-save').addEventListener('click', async function() {
      var t = tokenIn.value.trim();
      var g = gistIn.value.trim();
      if (!t) { showMsg('トークンを入力してください', false); return; }
      HSync.setToken(t);
      HSync.setGistId(g);
      showMsg('保存しました。同期を実行中…');
      await HSync.push();
      if (HSync.status === 'synced') showMsg('同期完了 ✅ Gist ID: ' + (HSync.getGistId() || '?'), true);
      else showMsg('エラー: ' + (HSync.lastError || '不明'), false);
    });
    document.getElementById('hsync-pull-now').addEventListener('click', async function() {
      if (!HSync.getToken()) { showMsg('先にトークンを保存してください', false); return; }
      showMsg('取得中…');
      await HSync.pull();
      if (HSync.status === 'synced') showMsg('最新の状態に更新しました ✅', true);
      else showMsg('エラー: ' + (HSync.lastError || '不明'), false);
    });
    document.getElementById('hsync-push-now').addEventListener('click', async function() {
      if (!HSync.getToken()) { showMsg('先にトークンを保存してください', false); return; }
      showMsg('送信中…');
      await HSync.push();
      if (HSync.status === 'synced') showMsg('送信完了 ✅', true);
      else showMsg('エラー: ' + (HSync.lastError || '不明'), false);
    });
    document.getElementById('hsync-clear').addEventListener('click', function() {
      if (!confirm('このデバイスの同期設定をクリアします。ローカルの学習進捗は残ります。よろしいですか？')) return;
      HSync.clearConfig();
      tokenIn.value = '';
      gistIn.value = '';
      showMsg('クリアしました', true);
    });
  }

  HSync.onStatusChange = renderStatusPill;

  // --- Lifecycle hooks -----------------------------------------------------
  // Problem: in an installed PWA, `setTimeout` can be paused or delayed
  // when the app is backgrounded, so a pending 2-second debounced push may
  // never fire. The symptom the user reported: "edits made from the PWA
  // don't reach the Gist, but the browser tab syncs fine."
  // Fix:
  //   - hidden  → flush the pending debounced push immediately
  //   - visible → if the last pull is old, auto-pull so the PWA shows
  //               changes made on the other device while it was closed.
  var lastAutoPullAt = 0;
  var AUTO_PULL_THROTTLE_MS = 30 * 1000;   // don't spam pulls on quick switches

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      HSync.flushPendingPush();
    } else if (document.visibilityState === 'visible') {
      if (!HSync.getToken()) return;
      var now = Date.now();
      if (now - lastAutoPullAt > AUTO_PULL_THROTTLE_MS) {
        lastAutoPullAt = now;
        HSync.pull();
      }
    }
  }

  function onPageHide() { HSync.flushPendingPush(); }

  function init() {
    renderStatusPill();
    mountSettingsModal();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    HSync.autoSyncOnLoad();
    lastAutoPullAt = Date.now();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.HSync = HSync;
})(window);
