/*
 * FutureWallet - chrome.* API shim for the Telegram Mini App host page.
 *
 * The extension's background bundle (dist/background.js) and UI pages talk to each other through
 * chrome.runtime / chrome.storage / chrome.alarms / chrome.windows. In the Mini App there is no
 * extension runtime, so this file provides a same-page implementation of exactly the surface the
 * bundle uses. The background runs in the top-level host document (index.html) for the whole
 * Telegram session; the UI pages run in same-origin iframes that get a per-frame view of this API
 * through tg/frame-bridge.js.
 *
 * Storage model
 *   chrome.storage.local   -> in-memory cache, persisted to localStorage (namespaced per Telegram
 *                             user) and mirrored to Telegram DeviceStorage (Bot API 9.0+) so a
 *                             WebView cache wipe doesn't lose the wallet. Optionally the encrypted
 *                             vault is also mirrored to Telegram CloudStorage (config.storage).
 *   chrome.storage.session -> memory only. Closing the Mini App locks the wallet.
 *
 * Classic (non-module) script on purpose: it must exist before the background module evaluates.
 */
(function () {
  'use strict';

  var CFG = window.FW_CONFIG || {};
  var SCFG = CFG.storage || {};
  var WA = (window.Telegram && window.Telegram.WebApp) || null;

  /* ------------------------------------------------------------------ */
  /* small helpers                                                      */
  /* ------------------------------------------------------------------ */

  function listenerSet() {
    var fns = [];
    return {
      addListener: function (fn) { if (typeof fn === 'function' && fns.indexOf(fn) < 0) fns.push(fn); },
      removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
      hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
      hasListeners: function () { return fns.length > 0; },
      _fire: function () {
        var args = arguments, out = [];
        fns.slice().forEach(function (fn) {
          try { out.push(fn.apply(null, args)); } catch (e) { console.error('[FW shim] listener error', e); }
        });
        return out;
      },
      _list: function () { return fns.slice(); }
    };
  }

  function hostClone(v) {
    if (v === undefined || v === null || typeof v !== 'object') return v;
    try { return structuredClone(v); } catch (e) { return v; }
  }

  function versionAtLeast(v) {
    try { return !!(WA && WA.isVersionAtLeast && WA.isVersionAtLeast(v)); } catch (e) { return false; }
  }

  function tgUserId() {
    try {
      var u = WA && WA.initDataUnsafe && WA.initDataUnsafe.user;
      return u && u.id ? String(u.id) : '';
    } catch (e) { return ''; }
  }

  // AbortSignal.timeout is used by the remote-config fetch; iOS < 16 WebViews lack it.
  if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
    AbortSignal.timeout = function (ms) {
      var c = new AbortController();
      setTimeout(function () { c.abort(new DOMException('TimeoutError', 'TimeoutError')); }, ms);
      return c.signal;
    };
  }

  /* ------------------------------------------------------------------ */
  /* storage                                                            */
  /* ------------------------------------------------------------------ */

  var uid = SCFG.namespaceByTelegramUser === false ? '' : tgUserId();
  var NS = (SCFG.prefix || 'fw') + ':' + (uid || 'guest') + ':';
  var INDEX_KEY = '__keys';
  var VAULT_KEY = 'vault';

  // Exposed so host.js can hand the same namespace to WalletConnect's storage.
  var STORAGE_PREFIX = (SCFG.prefix || 'fw') + '-' + (uid || 'guest');

  var deviceStorage = SCFG.deviceStorageMirror !== false && versionAtLeast('9.0') && WA.DeviceStorage ? WA.DeviceStorage : null;
  var cloudStorage = SCFG.cloudVaultBackup === true && versionAtLeast('6.9') && WA.CloudStorage ? WA.CloudStorage : null;

  function dsCall(method, args) {
    return new Promise(function (resolve) {
      if (!deviceStorage) return resolve(null);
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 4000);
      try {
        deviceStorage[method].apply(deviceStorage, args.concat([function (err, val) {
          if (done) return;
          done = true; clearTimeout(t);
          resolve(err ? null : (val === undefined ? true : val));
        }]));
      } catch (e) { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    });
  }

  function csCall(method, args) {
    return new Promise(function (resolve) {
      if (!cloudStorage) return resolve(null);
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 6000);
      try {
        cloudStorage[method].apply(cloudStorage, args.concat([function (err, val) {
          if (done) return;
          done = true; clearTimeout(t);
          resolve(err ? null : (val === undefined ? true : val));
        }]));
      } catch (e) { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    });
  }

  var mem = new Map();           // key -> JSON string
  var lsOk = true;
  try { localStorage.setItem(NS + '__probe', '1'); localStorage.removeItem(NS + '__probe'); } catch (e) { lsOk = false; }

  function lsSet(k, str) {
    if (!lsOk) return false;
    try { localStorage.setItem(NS + k, str); return true; } catch (e) { console.error('[FW shim] localStorage write failed for', k, e); return false; }
  }
  function lsDel(k) { if (lsOk) try { localStorage.removeItem(NS + k); } catch (e) {} }

  /* ---- DeviceStorage write-behind mirror (debounced per key) ---- */
  var dsTimers = new Map();
  function dsIndex() {
    return JSON.stringify(Array.from(mem.keys()));
  }
  function mirrorToDevice(k) {
    if (!deviceStorage) return;
    clearTimeout(dsTimers.get(k));
    dsTimers.set(k, setTimeout(function () {
      dsTimers.delete(k);
      if (mem.has(k)) dsCall('setItem', [NS + k, mem.get(k)]);
      else dsCall('removeItem', [NS + k]);
      dsCall('setItem', [NS + INDEX_KEY, dsIndex()]);
    }, k === VAULT_KEY ? 0 : 500));
  }

  /* ---- CloudStorage vault backup (encrypted blob only, chunked: 4096 chars/value) ---- */
  var CS_CHUNK = 3800;
  var CS_META = 'fw_vault_meta';
  function cloudBackupVault(str) {
    if (!cloudStorage) return;
    if (!str) {
      csCall('getItem', [CS_META]).then(function (meta) {
        var n = 0; try { n = JSON.parse(meta || '{}').n || 0; } catch (e) {}
        var keys = [CS_META]; for (var i = 0; i < n; i++) keys.push('fw_vault_' + i);
        csCall('removeItems', [keys]);
      });
      return;
    }
    var parts = [];
    for (var i = 0; i < str.length; i += CS_CHUNK) parts.push(str.slice(i, i + CS_CHUNK));
    if (parts.length > 60) { console.warn('[FW shim] vault too large for CloudStorage backup'); return; }
    Promise.all(parts.map(function (p, idx) { return csCall('setItem', ['fw_vault_' + idx, p]); })).then(function () {
      csCall('setItem', [CS_META, JSON.stringify({ n: parts.length, at: Date.now() })]);
    });
  }
  function cloudRestoreVault() {
    return csCall('getItem', [CS_META]).then(function (meta) {
      var n = 0; try { n = JSON.parse(meta || '{}').n || 0; } catch (e) {}
      if (!n) return null;
      var keys = []; for (var i = 0; i < n; i++) keys.push('fw_vault_' + i);
      return csCall('getItems', [keys]).then(function (vals) {
        if (!vals) return null;
        var s = keys.map(function (k) { return vals[k] || ''; }).join('');
        try { JSON.parse(s); return s; } catch (e) { return null; }
      });
    });
  }

  /* ---- hydration: everything persisted, before the background reads anything ---- */
  var restoredFrom = null;
  var ready = (function hydrate() {
    if (lsOk) {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(NS) === 0) mem.set(k.slice(NS.length), localStorage.getItem(k));
      }
    }
    var chain = Promise.resolve();
    if (deviceStorage) {
      chain = chain.then(function () {
        return dsCall('getItem', [NS + INDEX_KEY]).then(function (idx) {
          var keys = []; try { keys = JSON.parse(idx || '[]'); } catch (e) {}
          var missing = keys.filter(function (k) { return !mem.has(k); });
          if (!missing.length) {
            // First run with DeviceStorage available: seed the mirror from localStorage.
            if (mem.size && !keys.length) Array.from(mem.keys()).forEach(mirrorToDevice);
            return;
          }
          return Promise.all(missing.map(function (k) {
            return dsCall('getItem', [NS + k]).then(function (v) {
              if (typeof v === 'string' && v) { mem.set(k, v); lsSet(k, v); restoredFrom = restoredFrom || 'device'; }
            });
          }));
        });
      });
    }
    if (cloudStorage) {
      chain = chain.then(function () {
        if (mem.has(VAULT_KEY)) return;
        return cloudRestoreVault().then(function (v) {
          if (v) { mem.set(VAULT_KEY, v); lsSet(VAULT_KEY, v); mirrorToDevice(VAULT_KEY); restoredFrom = 'cloud'; }
        });
      });
    }
    return chain.catch(function (e) { console.error('[FW shim] storage hydrate failed', e); });
  })();

  function normKeys(keys) {
    if (keys === null || keys === undefined) return { all: true };
    if (typeof keys === 'string') return { list: [keys] };
    if (Array.isArray(keys)) return { list: keys };
    if (typeof keys === 'object') return { list: Object.keys(keys), defaults: keys };
    return { list: [] };
  }

  var onChanged = listenerSet();

  function makeArea(areaName, persistent) {
    var store = persistent ? mem : new Map();
    function readAll(q) {
      var out = {};
      var list = q.all ? Array.from(store.keys()).filter(function (k) { return k !== INDEX_KEY; }) : q.list;
      list.forEach(function (k) {
        if (store.has(k)) { try { out[k] = JSON.parse(store.get(k)); } catch (e) {} }
        else if (q.defaults && k in q.defaults) out[k] = hostClone(q.defaults[k]);
      });
      return out;
    }
    function withCb(p, cb) { if (typeof cb === 'function') p.then(cb, function () { cb(undefined); }); return p; }
    return {
      get: function (keys, cb) {
        if (typeof keys === 'function') { cb = keys; keys = null; }
        return withCb((persistent ? ready : Promise.resolve()).then(function () { return readAll(normKeys(keys)); }), cb);
      },
      set: function (items, cb) {
        return withCb((persistent ? ready : Promise.resolve()).then(function () {
          var changes = {};
          Object.keys(items || {}).forEach(function (k) {
            var str = JSON.stringify(items[k]);
            if (str === undefined) return;
            var old = store.get(k);
            store.set(k, str);
            if (persistent) {
              var ok = lsSet(k, str);
              mirrorToDevice(k);
              if (k === VAULT_KEY) {
                cloudBackupVault(str);
                // Losing the vault is unrecoverable without the phrase - surface it instead of
                // "succeeding" into memory only.
                if (!ok && !deviceStorage) throw new Error('Could not save the wallet on this device (storage unavailable)');
              }
            }
            changes[k] = { oldValue: old === undefined ? undefined : JSON.parse(old), newValue: JSON.parse(str) };
          });
          if (Object.keys(changes).length) onChanged._fire(changes, areaName);
        }), cb);
      },
      remove: function (keys, cb) {
        return withCb((persistent ? ready : Promise.resolve()).then(function () {
          normKeys(keys).list.forEach(function (k) {
            if (!store.has(k)) return;
            store.delete(k);
            if (persistent) { lsDel(k); mirrorToDevice(k); if (k === VAULT_KEY) cloudBackupVault(''); }
          });
        }), cb);
      },
      clear: function (cb) {
        return withCb((persistent ? ready : Promise.resolve()).then(function () {
          var keys = Array.from(store.keys());
          store.clear();
          if (persistent) {
            keys.forEach(function (k) { lsDel(k); mirrorToDevice(k); });
            cloudBackupVault('');
          }
        }), cb);
      },
      getBytesInUse: function (keys, cb) {
        var p = Promise.resolve(Array.from(store.values()).reduce(function (a, v) { return a + v.length; }, 0));
        return withCb(p, cb);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* runtime                                                            */
  /* ------------------------------------------------------------------ */

  var RUNTIME_ID = CFG.runtimeId || 'futurewallet-telegram';
  var BASE = new URL('./', document.baseURI).href;   // webapp root (index.html's folder)
  var onMessage = listenerSet();
  var onConnect = listenerSet();
  var onInstalled = listenerSet();

  function waitForListener() {
    if (onMessage.hasListeners()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        if (onMessage.hasListeners()) return resolve();
        if (Date.now() - t0 > 15000) return reject(new Error('Wallet engine did not start'));
        setTimeout(poll, 30);
      })();
    });
  }

  /** Dispatches a message to the background exactly like chrome.runtime.sendMessage does. */
  function dispatch(msg, sender) {
    return waitForListener().then(function () {
      return new Promise(function (resolve) {
        var settled = false;
        function sendResponse(r) { if (!settled) { settled = true; resolve(r); } }
        var results = onMessage._fire(hostClone(msg), sender, sendResponse);
        var async = results.some(function (r) { return r === true || (r && typeof r.then === 'function'); });
        if (!async) sendResponse(undefined);
      });
    });
  }

  function makePortPair(name, ownerWin) {
    function end() {
      var onMsg = listenerSet(), onDis = listenerSet();
      return { name: name, onMessage: onMsg, onDisconnect: onDis, _peer: null, _alive: true,
        postMessage: function (m) { var p = this._peer; if (p && p._alive) setTimeout(function () { p.onMessage._fire(hostClone(m), p); }, 0); },
        disconnect: function () { closePair(this); } };
    }
    var a = end(), b = end();
    a._peer = b; b._peer = a;
    function closePair(side) {
      if (!a._alive) return;
      a._alive = b._alive = false;
      var other = side === a ? b : a;
      other.onDisconnect._fire(other);
    }
    b.sender = { id: RUNTIME_ID, url: ownerWin ? String(ownerWin.location.href) : BASE };
    return { client: a, background: b };
  }

  /* ------------------------------------------------------------------ */
  /* alarms (wall-clock based - survive JS being paused in background)  */
  /* ------------------------------------------------------------------ */

  var alarms = new Map();
  var onAlarm = listenerSet();
  function tickAlarms() {
    var now = Date.now();
    alarms.forEach(function (a, name) {
      if (a.scheduledTime > now) return;
      if (a.periodInMinutes) a.scheduledTime = now + a.periodInMinutes * 60000;
      else alarms.delete(name);
      onAlarm._fire({ name: name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes });
    });
  }
  setInterval(tickAlarms, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tickAlarms(); });

  var alarmsApi = {
    create: function (name, info) {
      if (typeof name === 'object') { info = name; name = ''; }
      info = info || {};
      var delay = info.delayInMinutes != null ? info.delayInMinutes : info.periodInMinutes;
      var when = info.when || (Date.now() + Math.max(0, Number(delay || 0)) * 60000);
      alarms.set(name || '', { scheduledTime: when, periodInMinutes: info.periodInMinutes || null });
      return Promise.resolve();
    },
    clear: function (name, cb) { var had = alarms.delete(name || ''); if (cb) cb(had); return Promise.resolve(had); },
    clearAll: function (cb) { alarms.clear(); if (cb) cb(true); return Promise.resolve(true); },
    get: function (name, cb) { var a = alarms.get(name || ''); var r = a ? { name: name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes } : undefined; if (cb) cb(r); return Promise.resolve(r); },
    getAll: function (cb) { var r = []; alarms.forEach(function (a, n) { r.push({ name: n, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }); }); if (cb) cb(r); return Promise.resolve(r); },
    onAlarm: onAlarm
  };

  /* ------------------------------------------------------------------ */
  /* windows / tabs - approvals open as in-app overlays (host.js)       */
  /* ------------------------------------------------------------------ */

  var hooks = {
    openWindow: function () { return null; },
    closeWindow: function () {},
    openUrl: function () {},
    notify: function () {}
  };
  var onWindowRemoved = listenerSet();
  var onTabUpdated = listenerSet();
  var tabRedirects = new Map();   // pseudo-tab id -> url the background redirected it to
  var nextTabId = 1000;

  var windowsApi = {
    WINDOW_ID_NONE: -1,
    create: function (opts, cb) {
      var id = hooks.openWindow(opts && opts.url, opts || {});
      var win = id == null ? undefined : { id: id, focused: true, type: 'popup' };
      if (typeof cb === 'function') setTimeout(function () { cb(win); }, 0);
      return Promise.resolve(win);
    },
    remove: function (id, cb) {
      hooks.closeWindow(id);
      if (typeof cb === 'function') cb();
      return Promise.resolve();
    },
    update: function () { return Promise.resolve(); },
    getCurrent: function (cb) { var w = { id: 0, focused: true }; if (cb) cb(w); return Promise.resolve(w); },
    onRemoved: onWindowRemoved
  };

  var tabsApi = {
    query: function (q, cb) { if (typeof cb === 'function') cb([]); return Promise.resolve([]); },
    sendMessage: function () { return Promise.reject(new Error('No tabs in the Telegram Mini App')); },
    create: function (opts, cb) { hooks.openUrl(opts && opts.url); if (cb) cb({ id: -1 }); return Promise.resolve({ id: -1 }); },
    update: function (tabId, props) {
      if (props && props.url && tabRedirects.has(tabId)) tabRedirects.set(tabId, props.url);
      return Promise.resolve({ id: tabId });
    },
    getCurrent: function (cb) { if (cb) cb(undefined); return Promise.resolve(undefined); },
    remove: function () { return Promise.resolve(); },
    onUpdated: onTabUpdated
  };

  /**
   * Phishing check without touching the background: emulate the "tab navigated" event the
   * background already listens to. If it decides the host is blocked it redirects the pseudo-tab
   * to ui/phishing.html - we return that URL, otherwise null.
   */
  function checkNavigation(url) {
    var tabId = nextTabId++;
    tabRedirects.set(tabId, null);
    var results = onTabUpdated._fire(tabId, { url: url, status: 'loading' }, { id: tabId, url: url });
    return Promise.all(results.map(function (r) { return Promise.resolve(r).catch(function () {}); })).then(function () {
      var redirect = tabRedirects.get(tabId);
      tabRedirects.delete(tabId);
      return redirect || null;
    });
  }

  /* ------------------------------------------------------------------ */
  /* the chrome object                                                  */
  /* ------------------------------------------------------------------ */

  var storageApi = {
    local: makeArea('local', true),
    session: makeArea('session', false),
    onChanged: onChanged
  };
  storageApi.session.setAccessLevel = function () { return Promise.resolve(); };

  var HOST_SENDER = { id: RUNTIME_ID, url: BASE + 'index.html', origin: location.origin };

  var chromeShim = {
    runtime: {
      id: RUNTIME_ID,
      getURL: function (p) { return new URL(String(p || '').replace(/^\//, ''), BASE).href; },
      getManifest: function () { return { name: 'FutureWallet', version: CFG.version || '2.0.0', manifest_version: 3 }; },
      sendMessage: function (msg, cb) {
        var p = dispatch(msg, HOST_SENDER);
        if (typeof cb === 'function') p.then(cb, function () { cb(undefined); });
        return p;
      },
      connect: function (info) {
        var pair = makePortPair((info && info.name) || '', null);
        setTimeout(function () { onConnect._fire(pair.background); }, 0);
        return pair.client;
      },
      onMessage: onMessage,
      onConnect: onConnect,
      onInstalled: onInstalled,
      onStartup: listenerSet(),
      lastError: undefined
    },
    storage: storageApi,
    alarms: alarmsApi,
    windows: windowsApi,
    tabs: tabsApi,
    notifications: {
      create: function (idOrOpts, maybeOpts, cb) {
        var o = typeof idOrOpts === 'object' ? idOrOpts : (maybeOpts || {});
        try { hooks.notify(o.title || 'FutureWallet', o.message || ''); } catch (e) {}
        var id = typeof idOrOpts === 'string' ? idOrOpts : 'n' + Date.now();
        if (typeof cb === 'function') cb(id);
        return Promise.resolve(id);
      },
      clear: function () { return Promise.resolve(true); }
    },
    declarativeNetRequest: {
      updateSessionRules: function () { return Promise.resolve(); },
      updateDynamicRules: function () { return Promise.resolve(); }
    }
  };

  try {
    Object.defineProperty(window, 'chrome', { value: chromeShim, writable: true, configurable: true });
  } catch (e) {
    window.chrome = chromeShim;
  }

  /* ------------------------------------------------------------------ */
  /* internals for host.js / frame-bridge.js                            */
  /* ------------------------------------------------------------------ */

  window.FW_SHIM = {
    chrome: chromeShim,
    ready: ready,
    hooks: hooks,
    storagePrefix: STORAGE_PREFIX,
    namespace: NS,
    userId: uid,
    get restoredFrom() { return restoredFrom; },
    hasDeviceStorage: !!deviceStorage,
    hasCloudBackup: !!cloudStorage,
    dispatch: dispatch,
    checkNavigation: checkNavigation,
    windowRemoved: function (id) { onWindowRemoved._fire(id); },
    makePortPair: makePortPair,
    onConnect: onConnect,
    fireInstalled: function (reason) { onInstalled._fire({ reason: reason || 'install' }); },
    tickAlarms: tickAlarms
  };
})();
