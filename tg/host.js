/*
 * FutureWallet Telegram Mini App host.
 *
 *   index.html (this file)            - Telegram SDK, wallet engine (dist/background.js), chrome shim
 *     └─ #mainFrame  ui/popup.html    - wallet UI (or ui/browser.html, the dApp launcher)
 *     └─ .fw-overlay ui/approve.html  - approvals the engine opens with chrome.windows.create
 *
 * The engine lives in the top document for the whole Telegram session, so navigating the UI
 * between pages never restarts it (or relocks the wallet). UI frames reach it through
 * window.parent.FW_HOST (see frame-bridge.js).
 */

const CFG = window.FW_CONFIG || {};
const TCFG = CFG.telegram || {};
const SHIM = window.FW_SHIM;
const WA = window.Telegram?.WebApp || null;
const IN_TELEGRAM = !!(WA && WA.initData);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = (v) => { try { return !!WA?.isVersionAtLeast?.(v); } catch { return false; } };
const MOBILE = ['android', 'android_x', 'ios'].includes(WA?.platform);

/* ------------------------------------------------------------------ */
/* host toast (engine notifications, deep-link status)                */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function hostToast(title, body = '', ms = 3200) {
  const el = $('hostToast');
  el.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = title;
  el.appendChild(b);
  if (body) el.appendChild(document.createTextNode(body));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function haptic(kind = 'light') {
  try {
    const H = WA?.HapticFeedback;
    if (!H || !ver('6.1')) return;
    if (['success', 'warning', 'error'].includes(kind)) H.notificationOccurred(kind);
    else if (kind === 'select') H.selectionChanged();
    else H.impactOccurred(kind);
  } catch {}
}

function fatal(msg) {
  $('fatalMsg').textContent = msg;
  $('fatal').hidden = false;
  $('splash').hidden = true;
  $('fatalRetry').onclick = () => location.reload();
}

/* ------------------------------------------------------------------ */
/* engine calls from the host                                         */
/* ------------------------------------------------------------------ */

async function ui(method, params = {}) {
  const res = await SHIM.dispatch({ target: 'fw-background', kind: 'ui', method, params }, { id: SHIM.chrome.runtime.id, url: location.href, origin: location.origin });
  if (!res) return null;
  if (!res.ok) throw Object.assign(new Error(res.error?.message || 'Request failed'), { code: res.error?.code });
  return res.result;
}

/* ------------------------------------------------------------------ */
/* safe areas, theme colours                                          */
/* ------------------------------------------------------------------ */

function applyInsets() {
  const root = document.documentElement.style;
  const s = WA?.safeAreaInset || {};
  const c = WA?.contentSafeAreaInset || {};
  const full = !!WA?.isFullscreen;
  root.setProperty('--fw-inset-top', `${full ? (s.top || 0) + (c.top || 0) : 0}px`);
  root.setProperty('--fw-inset-bottom', `${(s.bottom || 0) + (full ? c.bottom || 0 : 0)}px`);
  root.setProperty('--fw-inset-left', `${s.left || 0}px`);
  root.setProperty('--fw-inset-right', `${s.right || 0}px`);
}

let lastColor = '';
function syncThemeFrom(win) {
  try {
    const bg = win.getComputedStyle(win.document.documentElement).getPropertyValue('--bg').trim() || '#0b0e11';
    if (bg === lastColor) return;
    lastColor = bg;
    document.documentElement.style.setProperty('--fw-bg', bg);
    const light = win.document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.style.setProperty('--fw-text', light ? '#1e2329' : '#eaecef');
    if (!WA) return;
    const hex = /^#[0-9a-f]{6}$/i.test(bg) ? bg : light ? '#ffffff' : '#0b0e11';
    if (ver('6.9')) { WA.setHeaderColor(hex); WA.setBackgroundColor(hex); }
    if (ver('7.10')) WA.setBottomBarColor(hex);
  } catch {}
}

/* ------------------------------------------------------------------ */
/* frames                                                             */
/* ------------------------------------------------------------------ */

const mainFrame = $('mainFrame');
const overlays = new Map();     // window id -> { el, url, kind }
let nextWindowId = 1;

function frameInfo(win) {
  if (mainFrame.contentWindow === win) return { kind: 'main', el: mainFrame };
  for (const [id, o] of overlays) if (o.el.contentWindow === win) return { kind: 'overlay', id, el: o.el, ...o };
  return null;
}

function uiUrl(page, params = {}) {
  const u = new URL(`ui/${page}`, document.baseURI);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.href;
}

function openMain(page = 'popup.html', params = {}) {
  mainFrame.src = uiUrl(page, params);
}

/** chrome.windows.create -> in-app overlay (approvals, phishing warnings). */
function openOverlay(url, opts = {}) {
  const id = nextWindowId++;
  const el = document.createElement('iframe');
  el.className = 'fw-frame fw-overlay';
  el.setAttribute('allow', 'clipboard-read; clipboard-write');
  el.title = 'FutureWallet confirmation';
  el.src = url;
  const kind = /approve\.html/.test(url) ? 'approval' : /phishing\.html/.test(url) ? 'phishing' : 'page';
  overlays.set(id, { el, url, kind, ports: [] });
  $('overlays').appendChild(el);
  haptic(kind === 'phishing' ? 'warning' : 'medium');
  if (kind === 'approval' && TCFG.confirmCloseDuringApproval !== false && ver('6.2')) WA.enableClosingConfirmation();
  updateBackButton();
  return id;
}

function closeOverlay(id, { notify = true } = {}) {
  const o = overlays.get(id);
  if (!o) return;
  overlays.delete(id);
  o.ports.forEach((p) => { try { p.disconnect(); } catch {} });
  o.el.classList.add('closing');
  setTimeout(() => o.el.remove(), 200);
  if (![...overlays.values()].some((x) => x.kind === 'approval') && ver('6.2')) WA.disableClosingConfirmation();
  if (notify) SHIM.windowRemoved(id);
  updateBackButton();
  // An approval may have unlocked (or failed to unlock) the wallet - let the main UI catch up.
  try { mainFrame.contentWindow?.fwRefreshIfLocked?.(); } catch {}
}

function topOverlay() {
  const ids = [...overlays.keys()];
  return ids.length ? { id: ids[ids.length - 1], ...overlays.get(ids[ids.length - 1]) } : null;
}

/* ------------------------------------------------------------------ */
/* Telegram BackButton / SettingsButton                               */
/* ------------------------------------------------------------------ */

let backRaf = 0;
function updateBackButton() {
  if (!WA?.BackButton || !ver('6.1')) return;
  cancelAnimationFrame(backRaf);
  backRaf = requestAnimationFrame(() => {
    let visible = false;
    if (overlays.size) visible = true;
    else {
      try {
        const w = mainFrame.contentWindow;
        if (w && typeof w.fwCanGoBack === 'function') visible = !!w.fwCanGoBack();
        else visible = /browser\.html/.test(w?.location?.pathname || '');
      } catch {}
    }
    visible ? WA.BackButton.show() : WA.BackButton.hide();
  });
}

function onBack() {
  haptic('select');
  const top = topOverlay();
  if (top) {
    const w = top.el.contentWindow;
    // Back on an approval = Reject (the engine also rejects if the overlay just disappears).
    const reject = w?.document?.getElementById('reject');
    if (top.kind === 'approval' && reject) reject.click();
    else closeOverlay(top.id);
    return;
  }
  try {
    const w = mainFrame.contentWindow;
    const ev = new w.CustomEvent('fw-hardware-back', { cancelable: true });
    w.dispatchEvent(ev);
  } catch {}
  updateBackButton();
}

function openSettings() {
  try {
    const w = mainFrame.contentWindow;
    if (typeof w?.fwOpenScreen === 'function') return w.fwOpenScreen('settings');
  } catch {}
  openMain('popup.html', { screen: 'settings' });
}

/* ------------------------------------------------------------------ */
/* links, phishing check, dApps                                       */
/* ------------------------------------------------------------------ */

function isOwnUi(url) {
  try {
    const u = new URL(url, document.baseURI);
    return u.origin === location.origin && u.pathname.startsWith(new URL('ui/', document.baseURI).pathname);
  } catch { return false; }
}

function openLinkUnchecked(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return;
  if (WA && /^https:\/\/t\.me\//i.test(u) && ver('6.1')) return WA.openTelegramLink(u);
  if (WA && ver('6.1') && IN_TELEGRAM) return WA.openLink(u, { try_instant_view: false });
  window.open(u, '_blank', 'noopener');
}

/** Opens an external site after running it past the engine's phishing blocklist. */
async function openExternal(url) {
  if (!url) return;
  if (isOwnUi(url)) return openMain(new URL(url).pathname.split('/').pop(), Object.fromEntries(new URL(url).searchParams));
  let redirect = null;
  try { redirect = await SHIM.checkNavigation(url); } catch {}
  if (redirect) { openOverlay(redirect); return; }
  openLinkUnchecked(url);
}

/** dApps can't see this wallet as window.ethereum - they connect over WalletConnect. */
async function openDapp(url) {
  await openExternal(url);
  if (!overlays.size) {
    openMain('popup.html', { screen: 'walletconnect' });
    hostToast('Connect with WalletConnect', 'In the dApp choose WalletConnect, then scan or paste the link here.', 6000);
  }
}

/* ------------------------------------------------------------------ */
/* clipboard, share, backups                                          */
/* ------------------------------------------------------------------ */

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function tgPopup(params) {
  return new Promise((resolve) => {
    if (!WA || !ver('6.2')) return resolve(null);
    try { WA.showPopup(params, (id) => resolve(id || null)); } catch { resolve(null); }
  });
}

const Share = {
  async share({ title, text } = {}) {
    const t = String(text || '');
    if (IN_TELEGRAM && ver('6.1') && t.length < 3000) {
      WA.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(t)}&text=${encodeURIComponent(title || '')}`);
      return;
    }
    if (await copyText(t)) hostToast('Copied to clipboard');
  }
};

function apiBase() {
  const b = (CFG.api?.baseUrl || '').replace(/\/$/, '');
  return b || location.origin;
}

async function sendBackupToChat(fileName, content) {
  const res = await fetch(`${apiBase()}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': WA?.initData || '' },
    body: JSON.stringify({ fileName, content })
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Backup failed (${res.status})`);
}

/** Vault export: an <a download> does nothing inside Telegram's WebView. */
async function saveBackup(fileName, content) {
  const canSend = IN_TELEGRAM && CFG.api?.enabled !== false;
  const choice = await tgPopup({
    title: 'Export encrypted vault',
    message: 'The file is encrypted with your wallet password. Anyone with the file AND your password controls your funds.',
    buttons: [
      ...(canSend ? [{ id: 'chat', type: 'default', text: 'Send to my Telegram chat' }] : []),
      { id: 'copy', type: 'default', text: 'Copy to clipboard' },
      { id: 'cancel', type: 'cancel' }
    ]
  });
  const pick = choice ?? (canSend ? 'chat' : 'copy');
  if (pick === 'chat') {
    try {
      await sendBackupToChat(fileName, content);
      haptic('success');
      hostToast('Backup sent', 'Check your chat with the bot.');
    } catch (e) {
      haptic('error');
      hostToast('Could not send backup', e.message);
    }
  } else if (pick === 'copy') {
    (await copyText(content)) ? hostToast('Vault copied', 'Paste it somewhere safe.') : hostToast('Copy failed');
  }
}

/* ------------------------------------------------------------------ */
/* QR scanner (Telegram native)                                       */
/* ------------------------------------------------------------------ */

const scanSupported = IN_TELEGRAM && ver('6.4') && MOBILE && typeof WA.showScanQrPopup === 'function';

const BarcodeScanner = scanSupported ? {
  async isGoogleBarcodeScannerModuleAvailable() { return { available: true }; },
  async installGoogleBarcodeScannerModule() {},
  scan() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        try { WA.offEvent('scanQrPopupClosed', onClosed); } catch {}
        resolve({ barcodes: val ? [{ rawValue: val }] : [] });
      };
      const onClosed = () => finish(null);
      try { WA.onEvent('scanQrPopupClosed', onClosed); } catch {}
      WA.showScanQrPopup({ text: 'Scan an address or WalletConnect QR' }, (data) => {
        if (!data) return false;
        haptic('success');
        finish(String(data).trim());
        return true;
      });
    });
  }
} : null;

/* ------------------------------------------------------------------ */
/* biometrics (Telegram BiometricManager, token lives in the OS keystore) */
/* ------------------------------------------------------------------ */

const BM = IN_TELEGRAM && ver('7.2') ? WA.BiometricManager : null;
let bmReady = false;
let bmToken = null;

function initBiometrics() {
  return new Promise((resolve) => {
    if (!BM) return resolve(false);
    const t = setTimeout(() => resolve(false), 2500);
    try {
      BM.init(() => { clearTimeout(t); bmReady = true; resolve(true); });
    } catch { clearTimeout(t); resolve(false); }
  });
}

function bmEnsureAccess(reason) {
  return new Promise((resolve, reject) => {
    if (BM.isAccessGranted) return resolve();
    if (BM.isAccessRequested) {
      // The user denied earlier - only Telegram's settings screen can change that.
      tgPopup({ title: 'Biometrics disabled', message: 'Allow biometric access for this app in Telegram settings.', buttons: [{ id: 'open', type: 'default', text: 'Open settings' }, { id: 'c', type: 'cancel' }] })
        .then((id) => { if (id === 'open') BM.openSettings(); reject(new Error('Biometric access not granted')); });
      return;
    }
    BM.requestAccess({ reason }, (granted) => (granted ? resolve() : reject(new Error('Biometric access not granted'))));
  });
}

const Biometric = BM ? {
  async isAvailable() {
    return { isAvailable: bmReady && !!BM.isBiometricAvailable, biometryType: BM.biometricType };
  },
  async verifyIdentity({ reason } = {}) {
    await bmEnsureAccess(reason || 'Unlock FutureWallet');
    await new Promise((resolve, reject) => {
      BM.authenticate({ reason: reason || 'Unlock FutureWallet' }, (ok, token) => {
        if (!ok) return reject(new Error('Biometric check failed'));
        bmToken = token || null;
        resolve();
      });
    });
  },
  async getCredentials() {
    const token = bmToken;
    bmToken = null;
    if (!token) throw new Error('No saved credentials');
    return { username: 'wallet', password: token };
  },
  async setCredentials({ password }) {
    await bmEnsureAccess('Enable biometric unlock');
    await new Promise((resolve, reject) => BM.updateBiometricToken(String(password || ''), (ok) => (ok ? resolve() : reject(new Error('Could not save credentials')))));
  },
  async deleteCredentials() {
    bmToken = null;
    if (!BM.isBiometricTokenSaved) return;
    await new Promise((resolve) => BM.updateBiometricToken('', () => resolve()));
  }
} : null;

/* ------------------------------------------------------------------ */
/* API handed to UI frames (frame-bridge.js)                          */
/* ------------------------------------------------------------------ */

const FWTG = {
  platform: WA?.platform || 'unknown',
  version: WA?.version || '',
  inTelegram: IN_TELEGRAM,
  user: WA?.initDataUnsafe?.user ? { id: WA.initDataUnsafe.user.id, firstName: WA.initDataUnsafe.user.first_name, username: WA.initDataUnsafe.user.username } : null,
  dapps: Array.isArray(CFG.dapps) ? CFG.dapps : [],
  BarcodeScanner,
  Biometric,
  Share,
  saveBackup,
  openExternal,
  openLinkUnchecked,
  openDapp,
  copyText,
  haptic,
  toast: hostToast,
  close: () => WA?.close?.()
};

function cloneInto(win, v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  try { return win.structuredClone(v); } catch { return v; }
}

/**
 * Per-frame chrome object. Storage/alarms are shared with the engine; runtime.sendMessage is
 * routed to the engine with the frame as sender and results cloned into the frame's realm (so
 * `instanceof`, JSON, etc. behave exactly as they did in the extension).
 */
function frameChrome(win) {
  const C = SHIM.chrome;
  const areaFor = (area) => ({
    get: (k, cb) => { const p = area.get(k).then((r) => cloneInto(win, r)); if (typeof cb === 'function') p.then(cb); return p; },
    set: (o, cb) => { const p = area.set(o); if (typeof cb === 'function') p.then(cb); return p; },
    remove: (k, cb) => { const p = area.remove(k); if (typeof cb === 'function') p.then(cb); return p; },
    clear: (cb) => { const p = area.clear(); if (typeof cb === 'function') p.then(cb); return p; }
  });
  return {
    runtime: {
      id: C.runtime.id,
      getURL: C.runtime.getURL,
      getManifest: C.runtime.getManifest,
      sendMessage(msg, cb) {
        const sender = { id: C.runtime.id, url: String(win.location.href), origin: location.origin };
        const p = interceptUiCall(msg, () => SHIM.dispatch(msg, sender)).then((r) => cloneInto(win, r));
        if (typeof cb === 'function') p.then(cb, () => cb(undefined));
        return p;
      },
      connect(info) {
        const pair = SHIM.makePortPair((info && info.name) || '', win);
        const f = frameInfo(win);
        if (f?.kind === 'overlay') overlays.get(f.id)?.ports.push(pair.client);
        win.addEventListener('pagehide', () => pair.client.disconnect(), { once: true });
        setTimeout(() => SHIM.onConnect._fire(pair.background), 0);
        return pair.client;
      },
      onMessage: { addListener() {}, removeListener() {} },
      lastError: undefined
    },
    storage: { local: areaFor(C.storage.local), session: areaFor(C.storage.session), onChanged: C.storage.onChanged },
    tabs: {
      create(opts, cb) { openExternal(opts?.url); if (cb) cb({ id: -1 }); return Promise.resolve({ id: -1 }); },
      getCurrent(cb) { if (cb) cb(undefined); return Promise.resolve(undefined); },
      remove() { return Promise.resolve(); },
      query(q, cb) { if (cb) cb([]); return Promise.resolve([]); }
    },
    windows: C.windows,
    alarms: C.alarms
  };
}

/** Host-side behaviour around a few engine calls. */
async function interceptUiCall(msg, run) {
  if (msg?.target === 'fw-background' && msg.kind === 'ui' && msg.method === 'resetWallet') {
    await disconnectAllWc();
    const res = await run();
    if (res?.ok) {
      try { await Biometric?.deleteCredentials(); } catch {}
      await purgeWalletConnectStorage();
      setTimeout(() => location.reload(), 150);
    }
    return res;
  }
  return run();
}

async function disconnectAllWc() {
  try {
    const sessions = (await Promise.race([ui('wcSessions'), sleep(2500).then(() => [])])) || [];
    await Promise.race([Promise.all(sessions.map((s) => ui('wcDisconnect', { topic: s.topic }).catch(() => {}))), sleep(3000)]);
  } catch {}
}

/** WalletConnect keeps its own IndexedDB; drop only this Telegram user's entries. */
function purgeWalletConnectStorage() {
  const marker = `:${SHIM.storagePrefix}//`;
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('WALLET_CONNECT_V2_INDEXED_DB');
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keyvaluestorage')) { db.close(); return resolve(); }
        const tx = db.transaction('keyvaluestorage', 'readwrite');
        const store = tx.objectStore('keyvaluestorage');
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => { keysReq.result.filter((k) => String(k).includes(marker)).forEach((k) => store.delete(k)); };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      };
    } catch { resolve(); }
    try { Object.keys(localStorage).filter((k) => k.includes(marker)).forEach((k) => localStorage.removeItem(k)); } catch {}
  });
}

window.FW_HOST = {
  attachFrame(win) {
    return { chrome: frameChrome(win), FWTG };
  },
  closeFrame(win) {
    const f = frameInfo(win);
    if (f?.kind === 'overlay') closeOverlay(f.id);
    else if (f?.kind === 'main') openMain('popup.html');
  },
  frameChanged() { updateBackButton(); },
  themeChanged(win) {
    const f = frameInfo(win);
    if (f?.kind === 'main') syncThemeFrom(win);
  }
};

/* ------------------------------------------------------------------ */
/* deep links: ?startapp=wc_<base64url>  or  ?wc=<uri> (bot buttons)  */
/* ------------------------------------------------------------------ */

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function readLaunchIntent() {
  const out = { wc: null, screen: null };
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('wc')?.startsWith('wc:')) out.wc = q.get('wc');
    const sp = WA?.initDataUnsafe?.start_param || q.get('tgWebAppStartParam') || '';
    if (sp.startsWith('wc_')) {
      const uri = b64urlDecode(sp.slice(3));
      if (uri.startsWith('wc:')) out.wc = uri;
    } else if (sp.startsWith('screen_')) {
      const s = sp.slice(7);
      if (['walletconnect', 'settings', 'receive', 'send', 'swap', 'history'].includes(s)) out.screen = s;
    }
  } catch (e) {
    console.warn('[FW host] bad launch param', e);
  }
  return out;
}

async function pairFromDeepLink(uri) {
  hostToast('WalletConnect', 'Preparing connection…');
  // The wallet must exist before a session can be approved; proposals stay valid ~5 minutes.
  const deadline = Date.now() + 5 * 60 * 1000;
  let warned = false;
  while (Date.now() < deadline) {
    const st = await ui('status').catch(() => null);
    if (st?.initialized) break;
    if (!warned) { warned = true; hostToast('Create or import a wallet', 'The dApp connection will continue automatically.', 6000); }
    await sleep(2000);
  }
  for (let i = 0; i < 30; i++) {
    try {
      await ui('wcPair', { uri });
      hostToast('Pairing…', 'Approve the connection request.');
      return;
    } catch (e) {
      const m = String(e.message || '');
      if (/not initialized/i.test(m) && i < 29) { await sleep(500); continue; }
      if (/not initialized/i.test(m)) return hostToast('WalletConnect unavailable', 'Set walletConnect.projectId in config.js.', 6000);
      if (/already exists|pairing.*exist/i.test(m)) return hostToast('Already paired', 'Check the dApp for the request.');
      return hostToast('Pairing failed', m.slice(0, 120), 6000);
    }
  }
}

/* ------------------------------------------------------------------ */
/* engine hooks (chrome.windows / tabs / notifications)               */
/* ------------------------------------------------------------------ */

SHIM.hooks.openWindow = (url) => openOverlay(url);
SHIM.hooks.closeWindow = (id) => closeOverlay(id, { notify: true });
SHIM.hooks.openUrl = (url) => openExternal(url);
SHIM.hooks.notify = (title, message) => { haptic('success'); hostToast(title, message, 4500); };

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

function showGate() {
  $('splash').hidden = true;
  $('gate').hidden = false;
  const bot = TCFG.botUsername;
  const link = bot ? `https://t.me/${bot}${TCFG.appShortName ? '/' + TCFG.appShortName : ''}` : 'https://telegram.org/';
  $('gateLink').href = link;
  $('gateMsg').textContent = bot ? `Open @${bot} in Telegram to use your wallet.` : 'Open this wallet from its Telegram bot.';
}

function setupTelegram() {
  if (!WA) return;
  try {
    WA.ready();
    WA.expand();
    if (TCFG.disableVerticalSwipes !== false && ver('7.7')) WA.disableVerticalSwipes();
    if (TCFG.fullscreen && ver('8.0') && MOBILE) WA.requestFullscreen();
    if (ver('6.1')) WA.BackButton.onClick(onBack);
    if (ver('7.0') && WA.SettingsButton) { WA.SettingsButton.onClick(openSettings); WA.SettingsButton.show(); }
    ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged'].forEach((ev) => { try { WA.onEvent(ev, applyInsets); } catch {} });
    try {
      WA.onEvent('activated', () => {
        SHIM.tickAlarms();
        try { mainFrame.contentWindow?.dispatchEvent(new mainFrame.contentWindow.Event('fw-app-resumed')); } catch {}
      });
    } catch {}
  } catch (e) {
    console.warn('[FW host] Telegram setup', e);
  }
  applyInsets();
}

async function boot() {
  if (!SHIM) return fatal('Wallet runtime missing (tg/chrome-shim.js did not load).');
  if (TCFG.requireTelegram !== false && !IN_TELEGRAM) return showGate();
  setupTelegram();

  // Engine settings that depend on the Telegram session - set before the engine evaluates.
  CFG.storagePrefix = SHIM.storagePrefix;
  if (WA?.colorScheme) CFG.app = { theme: WA.colorScheme === 'light' ? 'light' : 'dark', ...(CFG.app || {}) };

  await SHIM.ready;
  await initBiometrics();

  try {
    await import('../dist/background.js');
  } catch (e) {
    console.error(e);
    return fatal('The wallet engine failed to start: ' + (e?.message || e));
  }

  // Extension "installed/updated" event - once per engine version per Telegram user.
  try {
    const key = SHIM.namespace + '__engineVersion';
    const prev = localStorage.getItem(key);
    if (prev !== CFG.version) { localStorage.setItem(key, CFG.version || ''); SHIM.fireInstalled(prev ? 'update' : 'install'); }
  } catch {}

  // Auto-lock: the engine locks on its alarm; make the visible UI follow immediately.
  SHIM.chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'autolock') setTimeout(() => { try { mainFrame.contentWindow?.fwRefresh?.(); } catch {} }, 100);
  });

  // Only set when data was missing from the WebView and recovered from a Telegram mirror.
  if (SHIM.restoredFrom) {
    hostToast('Wallet restored', SHIM.restoredFrom === 'cloud' ? 'Encrypted vault restored from Telegram Cloud.' : 'Recovered from device storage.', 5000);
  }

  const intent = readLaunchIntent();
  mainFrame.addEventListener('load', () => {
    $('splash').hidden = true;
    mainFrame.hidden = false;
    updateBackButton();
  });
  openMain('popup.html', intent.screen ? { screen: intent.screen } : {});
  if (intent.wc) pairFromDeepLink(intent.wc);
}

boot();
