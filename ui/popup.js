import { call, $, $$, short, toast, show, copy, fmt, esc, safeImg, confirmDialog, promptDialog, chooseDialog, withBusy } from './api.js';
import { drawQR } from '../dist/qr.js';
import { identicon, symbolColor, timeAgo, skeletonRows, drawSparkline, drawDonut, passwordStrength, icon, fmtFiat, fiatSymbol } from './kit.js';
import { tokenLogo, chainLogo } from './logos.js';

// Both html and body need the class: app.css's fixed-360x600 popup box is gated on
// `:not(.page)` for EACH element separately, so leaving it off <html> let that rule keep clamping
// the root element to a tiny 360x600 box even once <body> correctly switched to full-page layout
// - the onboarding tab showed a cramped popup-sized card adrift in an otherwise blank canvas.
if (location.search.includes('onboard') || location.search.includes('expanded')) {
  document.body.classList.add('page');
  document.documentElement.classList.add('page');
}

// Capacitor plugins aren't ES-importable here - this file loads as a raw, unbundled module in
// both the desktop extension and the mobile app (see mobile/build.mjs), so a bare `import
// '@capacitor-mlkit/barcode-scanning'` would fail to resolve in the browser and break the whole
// file. Capacitor auto-registers native plugins on window.Capacitor.Plugins instead - same
// pattern browser.js uses for the custom DappBrowser plugin.
// Telegram Mini App: tg/frame-bridge.js exposes the host's Telegram adapters as window.FWTG with
// the same shape as the Capacitor plugins below (QR scanner -> Telegram showScanQrPopup,
// biometrics -> Telegram BiometricManager, share -> Telegram share sheet), so every existing
// NATIVE code path works unchanged in Telegram.
const TG = window.FWTG || null;
const CAPACITOR = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NATIVE = CAPACITOR || !!TG;
const BarcodeScanner = TG ? TG.BarcodeScanner : CAPACITOR ? window.Capacitor.Plugins.BarcodeScanner : null;
const NativeBiometric = TG ? TG.Biometric : CAPACITOR ? window.Capacitor.Plugins.NativeBiometric : null;
const CapShare = TG ? TG.Share : CAPACITOR ? window.Capacitor.Plugins.Share : null;
// ?screen=<id> - deep link / host navigation target, opened once the wallet is unlocked.
let pendingScreen = new URLSearchParams(location.search).get('screen');
const BIOMETRIC_SERVER = 'com.futurewallet.web3';

/** Shared native QR scanner flow - shows Google's on-device scanner UI, no camera runtime
 * permission needed on Android per the plugin's own docs, only a device with Google Play
 * Services. If that module isn't downloaded yet, kick off the install and ask the user to
 * retry rather than failing silently. Returns the raw scanned text, or null. */
async function scanQr() {
  if (!BarcodeScanner) return null;
  try {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      toast('Downloading scanner - try again in a few seconds');
      return null;
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: ['QR_CODE'] });
    return barcodes?.[0]?.rawValue?.trim() || null;
  } catch (e) {
    toast(e.message || 'Scan failed');
    return null;
  }
}

let S = null;
let OV = { native: { formatted: '0', symbol: '' }, tokens: [] };
let gasCfg = null;      // { options, nonce, eip1559 }
let gasChoice = { preset: 'market', custom: null };
let seedDraft = null, pwDraft = null, importMode = false, verifyState = null;
let sendResolved = null;
let sendAssetValue = 'native';
let receiveAssetValue = 'native';
let hideZero = false, sortByValue = true, activityFilter = 'all', currentToken = null;
// The `history` call is expensive - it reconciles every pending tx's on-chain receipt one at a
// time (see background/index.js), so it can take a few seconds. Switching
// filter tabs used to re-run the whole thing from scratch every tap, which both felt slow and,
// worse, looked broken: the list wouldn't visibly change until that multi-second fetch finished,
// so a tap on "Send" looked like it did nothing. Cache the unfiltered result once per screen
// visit and have the tabs just re-filter it client-side - instant, and still fresh each time the
// History screen is (re)opened.
let activityAll = null;
let biometricAutoTried = false;
let remoteConfigRetried = false;

/* ---------------- onboarding intro carousel (mobile-only, first launch) ---------------- */

const INTRO_SLIDES = [
  { icon: 'lock', title: 'Bank-grade security', body: 'Your private keys are encrypted and never leave this device.' },
  { icon: 'network', title: 'Multi-chain, one wallet', body: 'Ethereum, BNB Chain, and dozens of other networks in one place.' },
  { icon: 'bridge', title: 'Swap, send, explore', body: 'Built-in swaps and a dApp browser, right from your wallet.' }
];
let introSeen = true; // safe default - only flips to false once storage confirms it hasn't been shown
let introChecked = false;
let introIdx = 0;
async function ensureIntroChecked() {
  if (introChecked) return;
  introChecked = true;
  try {
    const r = await chrome.storage.local.get('fw_introSeen');
    introSeen = !!r.fw_introSeen;
  } catch {
    introSeen = true; // storage unavailable for some reason - never block onboarding on this
  }
}
function renderIntroSlide() {
  const s = INTRO_SLIDES[introIdx];
  $('#introSlide').innerHTML = `
    <div class="brand-badge" style="width:132px;height:132px;border-radius:38px;margin-bottom:32px">${icon(s.icon, { size: 52 })}</div>
    <h1 class="fw-semibold" style="font-size:26px">${esc(s.title)}</h1>
    <p class="muted" style="padding:0 12px;font-size:15px;line-height:1.5;max-width:320px">${esc(s.body)}</p>`;
  $('#introDots').innerHTML = INTRO_SLIDES.map(
    (_, i) => `<span style="width:7px;height:7px;border-radius:50%;background:${i === introIdx ? 'var(--accent)' : 'var(--line)'}"></span>`
  ).join('');
  $('#introNext').textContent = introIdx === INTRO_SLIDES.length - 1 ? 'Get Started' : 'Next';
}
async function completeIntro() {
  introSeen = true;
  try { await chrome.storage.local.set({ fw_introSeen: true }); } catch {}
  refresh();
}
$('#introNext').onclick = () => {
  if (introIdx < INTRO_SLIDES.length - 1) { introIdx++; renderIntroSlide(); }
  else completeIntro();
};
$('#introSkip').onclick = completeIntro;

/* Fills every static `data-icon="name"` placeholder in popup.html with its SVG. Dynamically
   rendered rows (tokens, history, dApp hub, etc.) call icon() directly in their template
   strings instead - this only covers the hand-written markup. Runs once; popup.js is loaded at
   the end of body so the DOM is already fully parsed by the time this executes. */
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 18 });
  });
}
hydrateIcons();

const applyTheme = (t) => {
  // Only Dark/Light are offered now (Settings used to also have Gold and System) - anything else
  // still saved from before that change (an old 'binance'/'system' value in someone's existing
  // settings) falls back to Dark rather than erroring or matching nothing.
  const resolved = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);
  // popup.html hardcodes data-bs-theme="dark" in markup and this was never updated afterward -
  // every Bootstrap utility class this app uses (.btn, .form-control, .card, .alert, .nav-pills,
  // ...) reads ITS colors from that attribute, completely separately from this app's own --bg/
  // --text variables above. Light theme only ever repainted the custom variables, so anything
  // relying on an unoverridden Bootstrap default kept rendering in Bootstrap's dark palette on top
  // of a light background - that's the "many places broken in light mode" report.
  document.documentElement.setAttribute('data-bs-theme', resolved);
};

/* ---------------- boot ---------------- */

/** True when running inside the toolbar popup (not an expanded tab) */
const isPopup = !document.body.classList.contains('page');

async function refresh() {
  let acct = null;
  try {
    S = await call('status');
    if (!S) {
      setTimeout(refresh, 200);
      return;
    }

    // On a fresh cold start, background/remoteConfig.js's eager Firestore fetch is fired but not
    // awaited before this first status() call can land, so everything here that comes from remote
    // config - maintenance, the announcement ticker, the notification inbox - may still reflect
    // whatever was last persisted to disk rather than what the admin just published. One retry a
    // couple of seconds later (long enough for that fetch to resolve) self-corrects all of it
    // without the user having to force-restart the app.
    if (!remoteConfigRetried) {
      remoteConfigRetried = true;
      setTimeout(refresh, 2500);
    }

    // Remote-config kill switch, checked before anything else (including onboarding) so it can't
    // be bypassed by closing/reopening the toolbar popup - the small popup would just let the user
    // dismiss the message by closing it, so this forces a full tab that stays open instead.
    if (S.maintenance?.enabled) {
      if (isPopup && !NATIVE) {
        chrome.tabs.create({ url: chrome.runtime.getURL('ui/popup.html?onboard=1') });
        window.close();
        return;
      }
      if ($('#maintenanceMsg')) $('#maintenanceMsg').textContent = S.maintenance.message || 'FutureWallet is temporarily down for maintenance. Please check back soon.';
      return view('maintenance');
    }
    applyTheme(S.settings?.theme);
    if ($('#netName')) $('#netName').textContent = S.network?.name || '—';
    if (S.network) {
      const nd = chainLogo(S.network.chainId, S.network.symbol, 16, S.settings?.showTokenLogos !== false);
      nd.id = 'netDot';
      nd.classList.add('netdot');
      if ($('#netDot')) $('#netDot').replaceWith(nd);
    }
    // Mobile-only - the desktop extension shows Create/Import directly, no separate intro carousel.
    // A one-time feature carousel shown before Create/Import, first ever launch only. Gated on a
    // local flag rather than S.initialized itself, since that stays false through the whole
    // Create/Import flow too and would otherwise show the carousel again on every retry.
    if (NATIVE && !S.initialized) {
      await ensureIntroChecked();
      if (!introSeen) {
        renderIntroSlide();
        return view('intro');
      }
    }
    if (!S.initialized) return view('welcome');
    if (!S.unlocked) {
      const canBiometric = !!NativeBiometric && !!S.settings?.biometricEnabled;
      $('#btnBiometricUnlock').classList.toggle('hidden', !canBiometric);
      view('lock');
      if (canBiometric && !biometricAutoTried) { biometricAutoTried = true; biometricUnlock(); }
      return;
    }
    acct = (S.accounts || []).find((a) => a.address === S.selectedAddress) || S.accounts?.[0];
    if (acct) {
      S.selectedAddress = acct.address;
      $('#acctName').textContent = acct.name + (acct.readOnly ? ' (watch)' : '');
      $('#acctAddr').textContent = short(acct.address, 5);
      $('#acctAvatar').src = identicon(acct.address, 26);
    }
    // Fiat mode shows the portfolio's total fiat value with no symbol suffix (set by
    // renderBalDisplay() once loadOverview()'s fiat fetch resolves) - stamping the native coin's
    // symbol here unconditionally, on every refresh() (including the one right after changing
    // currency in Settings), briefly glued that symbol onto whatever fiat number was still on
    // screen before the new currency's data arrived. Changing INR to USD flashed "1234.56 BNB"
    // for a moment, not a currency switch, just a mislabeled number. Only relevant to set eagerly
    // here when NOT in fiat mode, where the balance IS the native amount.
    if (S.network && !S.settings.showFiat) $('#balSymbol').textContent = S.network.symbol;
    $('#backupBanner').classList.toggle('hidden', !!S.backupDone);
  } catch (err) {
    console.error('[FutureWallet] Refresh boot error:', err);
    view('welcome');
    return;
  }
  // a watch-only account cannot sign - disable the actions
  const ro = !!acct?.readOnly;
  ['#btnSend', '#btnSwap'].forEach((id) => {
    $(id).style.opacity = ro ? '.4' : '';
    $(id).style.pointerEvents = ro ? 'none' : '';
  });
  $('#roBanner').classList.toggle('hidden', !ro);
  if ($('#notifDot')) $('#notifDot').classList.toggle('hidden', !S.hasUnseenNotifications);
  renderAnnouncementBanner();
  view('home');
  loadOverview();
  if (pendingScreen) {
    const target = pendingScreen;
    pendingScreen = null;
    openDeepScreen(target);
  }
}

/** Screens reachable from Telegram deep links (startapp=screen_<id>) and the host. */
function openDeepScreen(id) {
  if (!S?.unlocked) { pendingScreen = id; return; }
  if (id === 'send' && !$('#btnSend').style.pointerEvents) return $('#btnSend').click();
  if (id === 'receive') return $('#btnReceive').click();
  if (['swap', 'history', 'assets', 'settings'].includes(id)) return openTab(id);
  if (['walletconnect', 'contacts', 'networks', 'permissions', 'approvals'].includes(id)) return openScreen(id);
}

function renderAnnouncementBanner() {
  if (S.announcements && S.announcements.length) {
    const text = S.announcements.map((a) => (a.body ? `${a.title}: ${a.body}` : a.title)).join('   •   ');
    const track = $('#annTrack');
    // Rendered twice back to back so the 0%->-50% loop in app.css has no seam - see the comment
    // there. esc() since title/body are admin-authored but still untrusted free text.
    track.innerHTML = `<span>${esc(text)}</span><span class="ann-sep">•</span><span>${esc(text)}</span>`;
    $('#announceBanner').classList.remove('hidden');
    // Speed is pinned to ~50px/s regardless of how much text there is, so adding more
    // announcements lengthens the loop instead of making it race by.
    requestAnimationFrame(() => {
      const singleWidth = track.scrollWidth / 2;
      track.style.animationDuration = `${Math.max(8, singleWidth / 50)}s`;
    });
  } else if ($('#announceBanner')) {
    $('#announceBanner').classList.add('hidden');
  }
  if ($('#annDot')) $('#annDot').classList.toggle('hidden', !S.announcements?.length);
}

/** Force a real remote-config refetch (bypassing the 30-min throttle) and re-apply whatever
 * changed - maintenance, the announcement ticker, the notification dot - WITHOUT the navigation
 * side effects refresh() has (it always ends on view('home'), which would be jarring here).
 *
 * Needed because on mobile there is no persistent background context - background.js boots fresh
 * only on a true cold start (see the shim.js comment on chrome.storage.session). Pressing home and
 * reopening the app does NOT reboot it; Android just resumes the same in-memory WebView, so the
 * one-time poll at boot never runs again. Without this, an admin change made while the app sits
 * backgrounded (the exact "publish it, switch back to check" workflow) would never be seen until
 * the process is actually killed and restarted. */
async function syncRemoteConfigUI() {
  if (!S?.unlocked) return;
  try {
    await call('checkNotifications');
    const s = await call('status');
    if (!s) return;
    S.maintenance = s.maintenance;
    S.announcements = s.announcements;
    S.hasUnseenNotifications = s.hasUnseenNotifications;
    if ($('#notifDot')) $('#notifDot').classList.toggle('hidden', !S.hasUnseenNotifications);
    renderAnnouncementBanner();
  } catch {}
}
if (NATIVE) window.addEventListener('fw-app-resumed', syncRemoteConfigUI);
setInterval(syncRemoteConfigUI, 60000);

const NAV_VIEWS = { home: 'navHome', assets: 'navAssets', swap: 'navSwap', history: 'navHistory', settings: 'navSettings' };

/* Screens shown before a wallet exists or while locked: no top bar, no bottom nav */
const CHROMELESS = new Set(['intro', 'welcome', 'password', 'seed', 'verify', 'import', 'lock', 'maintenance']);

/* Where the back arrow should return to, when it isn't obvious from markup */
const navStack = [];
let currentView = null;

/**
 * Single entry point for navigation.
 * The top bar is visible on every post-unlock screen; the bottom nav only on the five tabs.
 * Passing `push: false` avoids recording the move (used by the back handler itself).
 */
function view(id, { push = true } = {}) {
  if (push && currentView && currentView !== id) navStack.push(currentView);
  currentView = id;

  const chromeless = CHROMELESS.has(id) || !S?.unlocked;
  $('#appbar').classList.toggle('hidden', chromeless);
  $('#bottomNav').classList.toggle('hidden', chromeless || !NAV_VIEWS[id]);
  $$('.navitem').forEach((n) => n.classList.toggle('on', NAV_VIEWS[id] === n.id));

  show(id);
  const el = document.querySelector(`[data-view="${id}"]`);
  if (el) el.scrollTop = 0;
}

/** Back: use the recorded history, falling back to the screen's declared parent. */
function goBack(fallback = 'home') {
  const prev = navStack.pop();
  view(prev || fallback, { push: false });
}

// Hardware/gesture back button (mobile). Use the same in-page navigation as the visible back
// arrows, never a real page reload - see shim.js for why a raw WebView back would relock the
// wallet. At the true root (home tab, nothing on navStack) there is nowhere in-page left to go,
// so this doesn't call preventDefault() and shim.js exits the app instead, matching normal
// Android back behavior.
window.addEventListener('fw-hardware-back', (e) => {
  const sheetOpen = $$('.sheet:not(.hidden)')[0];
  if (sheetOpen) {
    e.preventDefault();
    closeSheets();
    return;
  }
  if (navStack.length) {
    e.preventDefault();
    goBack();
    return;
  }
  if (currentView && currentView !== 'home' && !CHROMELESS.has(currentView)) {
    e.preventDefault();
    openTab('home');
  }
});

// Hooks for the Telegram host (tg/host.js): whether its BackButton should be visible, and ways
// to re-sync this page after something happened outside it (auto-lock, an approval overlay).
window.fwCanGoBack = () => !!($$('.sheet:not(.hidden)')[0] || navStack.length || (currentView && currentView !== 'home' && !CHROMELESS.has(currentView)));
window.fwRefresh = () => refresh();
window.fwRefreshIfLocked = () => { if (!S?.unlocked || currentView === 'lock') refresh(); };
window.fwOpenScreen = (id) => { closeSheets(); openDeepScreen(id); };

let lastBalance = { value: '0', symbol: '' };
let balHidden = localStorage.getItem('fw_balHidden') === '1';
// Whether loadOverview has ever resolved once - gates the dashboard's skeleton loaders so they
// show on the very first load (and right after unlock/returning from the dApp browser, where
// there's genuinely nothing on screen yet) but don't re-flash on the 15s background poll below,
// which would just make already-loaded numbers flicker for no reason.
let overviewLoaded = false;

/** Renders whatever loadOverview last computed, masked with dots when the user has hidden the
 * balance - kept separate from loadOverview so toggling visibility doesn't need a refetch. */
function renderBalDisplay() {
  $('#balValue').textContent = balHidden ? '••••••' : lastBalance.value;
  $('#balSymbol').textContent = balHidden ? '' : lastBalance.symbol;
  $('#balAmount').classList.remove('hidden');
  $('#balSkeleton').classList.add('hidden');
}

async function loadOverview() {
  if (!OV.tokens.length) skeletonRows($('#tokenList'), 3);
  if (!overviewLoaded) {
    $('#balAmount').classList.add('hidden');
    $('#balSkeleton').classList.remove('hidden');
    skeletonRows($('#homeAssets'), 2);
    skeletonRows($('#homeActivity'), 2);
  }
  try {
    OV = await call('overview', { address: S.selectedAddress });
    // Total portfolio shows fiat value (all assets combined), not a single coin's balance -
    // fall back to the native coin amount only when fiat pricing is off/unavailable.
    if (OV.fiat) {
      lastBalance = { value: fmtFiat(OV.fiat.total, OV.fiat.currency), symbol: '' };
    } else {
      lastBalance = { value: fmt(OV.native.formatted), symbol: S.network.symbol };
    }
    renderBalDisplay();
    $('#balError').classList.add('hidden');
    if (OV.ensName) $('#acctAddr').textContent = OV.ensName;
    // Not animated - this fires on every data refresh (15s background poll included), not just
    // when the Assets screen is actually opened.
    renderTokens(false);
    renderAllocation();
    loadSparkline();
  } catch {
    lastBalance = { value: '—', symbol: '' };
    renderBalDisplay();
    $('#balError').classList.remove('hidden');
  }
  // Runs either way, success or failure - it just reflects whatever OV currently holds (freshly
  // fetched, or the last-known one on a failed refresh), and also clears the #homeAssets skeleton
  // above, which nothing else would if the fetch itself failed.
  renderHomeAssets();
  overviewLoaded = true;
  // Not renderActivity()/loadActivity() here - that's the History screen's own expensive fetch
  // (per-pending-tx receipt lookups), and this runs on every refresh() app-wide. Firing it
  // unconditionally on every refresh, whether or not History is even open, was most of why the
  // whole app felt sluggish. loadActivity() now only runs when History is actually opened.
  renderHomeActivity();
  renderNfts();
}

/* ---------------- home lists ---------------- */

function renderHomeAssets() {
  const el = $('#homeAssets');
  // overviewLoaded is still false only on the very first render (it flips true at the end of
  // loadOverview(), after this runs) - the entrance animation should play once, not every 15s on
  // the background poll, which was rebuilding this list from scratch and replaying the fade-in on
  // every single refresh (looked like the whole screen "blinking" even when nothing changed).
  const firstLoad = !overviewLoaded;
  el.innerHTML = '';
  const native = { address: null, symbol: S.network.symbol, decimals: 18, balance: OV.native.formatted, fiat: OV.fiat?.value ?? null, change24h: OV.fiat?.change24h ?? null, price: OV.fiat?.price ?? null };
  [native, ...OV.tokens].slice(0, 4).forEach((t, i) => {
    const row = assetRow(t);
    if (firstLoad) row.style.animationDelay = `${i * 35}ms`;
    else row.style.animation = 'none';
    el.appendChild(row);
  });
  if (!OV.tokens.length) {
    const add = document.createElement('div');
    add.className = 'rowitem';
    add.innerHTML = `<div class="icon-tile md">${icon('plus')}</div><div class="grow"><div class="title">Import tokens</div></div><span class="chev">${icon('chevron', { size: 16 })}</span>`;
    add.onclick = () => view('addToken');
    el.appendChild(add);
  }
}

async function loadSparkline() {
  const el = $('#spark'), ch = $('#balChange'), wrap = $('#homeChartWrap'), range = $('#rangeRow');
  $('#sparkTip').classList.add('hidden');
  if (!S.settings.showChart) { wrap.classList.add('hidden'); range.classList.add('hidden'); ch.classList.add('hidden'); homeChartPoints = null; return; }
  wrap.classList.remove('hidden'); range.classList.remove('hidden');
  if (!S.settings.showFiat) { el.classList.add('hidden'); ch.classList.add('hidden'); homeChartPoints = null; return; }
  const h = await call('priceHistory', { days: sparkDays }).catch(() => null);
  if (!h) { el.classList.add('hidden'); ch.classList.add('hidden'); homeChartPoints = null; return; }
  el.classList.remove('hidden'); ch.classList.remove('hidden');
  const up = h.change >= 0;
  const rangeLabel = { 1: '24H', 7: '7D', 30: '30D', 365: '1Y' }[sparkDays] || `${sparkDays}D`;
  ch.innerHTML = `${up ? '▲' : '▼'} ${Math.abs(h.change).toFixed(2)}%<span class="sep"></span><span class="range-label">${rangeLabel}</span>`;
  ch.className = 'change ' + (up ? 'up' : 'down');
  homeChartPoints = h.points;
  homeChartColor = up ? '#0ecb81' : '#f6465d';
  drawSparkline(el, homeChartPoints, homeChartColor);
}

// Holds the currently-drawn chart's data so the touch/drag scrubber (wired once, below) can
// redraw with a marker at whatever point the user is pressing, without re-fetching anything.
let tdChartPoints = null;
let tdChartColor = '#0ecb81';

/** Same idea as loadSparkline() above, scoped to whichever token openToken() last opened - native
 * coin history when currentToken has no address, per-contract history otherwise (see
 * getTokenPriceHistory in services.js). Leaves the 24h badge openToken() already set from the
 * asset list's data alone on failure (e.g. a token CoinGecko doesn't track) rather than blanking
 * it - that number is still accurate, there's just no chart/range-specific figure to replace it. */
async function loadTokenSparkline() {
  const el = $('#tdSpark'), row = $('#tdRangeRow'), empty = $('#tdChartEmpty'), card = $('#tdChartCard');
  $('#tdChartTip').classList.add('hidden');
  if (!S.settings.showChart) { card.classList.add('hidden'); tdChartPoints = null; return; }
  card.classList.remove('hidden');
  if (!S.settings.showFiat) { el.classList.add('hidden'); row.classList.add('hidden'); empty.classList.add('hidden'); tdChartPoints = null; return; }
  const h = await call('priceHistory', { days: tdSparkDays, address: currentToken?.address || undefined }).catch(() => null);
  row.classList.remove('hidden'); // range tabs stay usable even if this particular range has no data
  if (!h) { el.classList.add('hidden'); empty.classList.remove('hidden'); tdChartPoints = null; return; }
  empty.classList.add('hidden');
  el.classList.remove('hidden');
  const up = h.change >= 0;
  const rangeLabel = { 1: '24h', 7: '7d', 30: '30d', 365: '1y' }[tdSparkDays] || `${tdSparkDays}d`;
  const ch = $('#tdChange');
  ch.textContent = `${up ? '▲' : '▼'} ${Math.abs(h.change).toFixed(2)}% (${rangeLabel})`;
  ch.className = 'change ' + (up ? 'up' : 'down');
  tdChartPoints = h.points;
  tdChartColor = up ? '#0ecb81' : '#f6465d';
  drawSparkline(el, tdChartPoints, tdChartColor);
}

// Press-and-drag scrubber on the token-detail chart: shows a floating price tooltip and a marker
// dot at whichever point is under the finger/cursor. getPoints/getColor are called fresh on every
// interaction (not captured once) so this stays correct across reloads (a new range, a different
// token) without needing to be re-wired - the canvas element itself never changes, only its data.
function wireChartScrub(canvas, tip, getPoints, getColor, formatValue) {
  const showAt = (clientX) => {
    const points = getPoints();
    if (!points || points.length < 2) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const idx = Math.round((x / rect.width) * (points.length - 1));
    drawSparkline(canvas, points, getColor(), idx);
    tip.textContent = formatValue(points[idx]);
    tip.style.left = `${x}px`;
    tip.classList.remove('hidden');
  };
  const hide = () => {
    tip.classList.add('hidden');
    const points = getPoints();
    if (points) drawSparkline(canvas, points, getColor());
  };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); showAt(e.clientX); });
  canvas.addEventListener('pointermove', (e) => { if (e.buttons) showAt(e.clientX); });
  canvas.addEventListener('pointerup', hide);
  canvas.addEventListener('pointerleave', hide);
  canvas.addEventListener('pointercancel', hide);
}
wireChartScrub(
  $('#tdSpark'), $('#tdChartTip'),
  () => tdChartPoints, () => tdChartColor,
  (price) => `${fiatSymbol(OV.fiat?.currency)}${price.toFixed(price < 1 ? 6 : 2)}`
);
let homeChartPoints = null;
let homeChartColor = '#0ecb81';
wireChartScrub(
  $('#spark'), $('#sparkTip'),
  () => homeChartPoints, () => homeChartColor,
  (price) => fmtFiat(price, OV.fiat?.currency)
);

function assetRow(t) {
  const d = document.createElement('div');
  d.className = 'rowitem';
  d.appendChild(tokenLogo(S.network.chainId, t.address, t.symbol, 36, S.settings.showTokenLogos));
  const rest = document.createElement('div');
  rest.className = 'grow';
  // Balance sits under the name (left column) - just the raw coin amount, no fiat mixed in here.
  rest.innerHTML = `<div class="title">${esc(t.symbol)}</div>
    <div class="sub" style="font-family:inherit">Bal: ${fmt(t.balance)}</div>`;
  const right = document.createElement('div');
  right.className = 'right';
  // Right column: total fiat value of the holding on top, its live 24h move underneath.
  const changeHtml = t.change24h != null
    ? `<div class="sub"><span class="change ${t.change24h >= 0 ? 'up' : 'down'}">${t.change24h >= 0 ? '▲' : '▼'}${Math.abs(t.change24h).toFixed(2)}%</span></div>`
    : '';
  right.innerHTML = t.fiat != null ? `${fmtFiat(t.fiat, OV.fiat.currency)}${changeHtml}` : '';
  d.append(rest, right);
  d.onclick = () => openToken(t);
  return d;
}

/** Portfolio allocation donut on the Assets screen - built entirely from OV, already fetched for
 * the list itself, so this costs nothing extra (no additional price/history requests). Independent
 * of the search box/hide-zero/sort controls below it: it always reflects the whole portfolio, not
 * whatever's currently filtered into view. */
function renderAllocation() {
  const card = $('#allocCard');
  if (!S.settings.showFiat || !OV.fiat) { card.classList.add('hidden'); return; }
  const native = { symbol: S.network.symbol, fiat: OV.fiat.value };
  const held = [native, ...OV.tokens]
    .filter((t) => t.fiat != null && t.fiat > 0)
    .sort((a, b) => b.fiat - a.fiat);
  if (held.length < 2) { card.classList.add('hidden'); return; } // one asset = a full circle, nothing to compare
  card.classList.remove('hidden');
  // Cap the chart at 5 slices - a couple dozen dust-token slivers is unreadable, not informative,
  // and also keeps the legend below it to at most 6 rows regardless of how many tokens are held.
  const top = held.slice(0, 5);
  const rest = held.slice(5);
  const restTotal = rest.reduce((s, t) => s + t.fiat, 0);
  // Assigned by position, not symbolColor(t.symbol) - that's a hash over the whole palette, made
  // for spreading many icons apart, not for guaranteeing the handful of slices actually on screen
  // together are distinguishable (BNB and USDT hashed to the same slot here). A short fixed
  // sequence guarantees every one of the up-to-6 slices shown gets a different color.
  const ALLOC_COLORS = ['#6d5efc', '#0ecb81', '#f0b90b', '#2fa4f8', '#f6465d', '#ff7ac2'];
  const slices = top.map((t, i) => ({ symbol: t.symbol, fiat: t.fiat, color: ALLOC_COLORS[i % ALLOC_COLORS.length] }));
  // Canvas fillStyle needs a resolved color, not a CSS var() reference - reads whatever --muted
  // currently resolves to so this still looks right after a theme switch (dark/light/gold all
  // define it differently).
  if (restTotal > 0) {
    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#848e9c';
    slices.push({ symbol: `Other (${rest.length})`, fiat: restTotal, color: mutedColor });
  }
  const total = slices.reduce((s, x) => s + x.fiat, 0);
  drawDonut($('#allocDonut'), slices.map((s) => ({ value: s.fiat, color: s.color })));
  $('#allocLegend').innerHTML = slices
    .map(
      (s) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
        <span style="width:9px;height:9px;border-radius:50%;background:${s.color};flex-shrink:0"></span>
        <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.symbol)}</span>
        <span class="muted">${((s.fiat / total) * 100).toFixed(1)}%</span>
      </div>`
    )
    .join('');
}

// animate=false for the silent 15s background poll (via loadOverview) - true for every
// user-triggered call (opening the tab, searching, toggling hide-zero/sort), where replaying the
// entrance is a reasonable "list changed" cue rather than an unprompted flash.
function renderTokens(animate = true) {
  const el = $('#tokenList');
  el.innerHTML = '';
  const native = { address: null, symbol: S.network.symbol, decimals: 18, balance: OV.native.formatted, fiat: OV.fiat?.value ?? null, change24h: OV.fiat?.change24h ?? null, price: OV.fiat?.price ?? null };
  let list = [native, ...OV.tokens.map((t) => ({ ...t, fiat: t.fiat ?? null }))];

  if (assetQuery) list = list.filter((t) => t.symbol.toLowerCase().includes(assetQuery) || (t.address || '').toLowerCase().includes(assetQuery));
  if (hideZero) list = list.filter((t) => Number(t.balance) > 0 || t.address === null);
  if (sortByValue && list.length > 1) list = [list[0], ...list.slice(1).sort((a, b) => Number(b.balance) - Number(a.balance))];

  if (!list.length) {
    el.innerHTML = `<div class="empty">${assetQuery ? 'No assets match that search' : 'Zero-balance tokens are hidden'}</div>`;
    return;
  }
  list.forEach((t, i) => {
    const row = assetRow(t);
    if (animate) row.style.animationDelay = `${i * 35}ms`;
    else row.style.animation = 'none';
    el.appendChild(row);
  });
}

/** BEP-20 on BNB Smart Chain/testnet/opBNB, ERC-20 everywhere else this wallet supports - all the
 * same interface in practice, just the conventional per-chain label. */
function tokenStandardFor(chainId) {
  return [56, 97, 204].includes(Number(chainId)) ? 'BEP-20' : 'ERC-20';
}

function openToken(t) {
  currentToken = t;
  const heroLogo = tokenLogo(S.network.chainId, t.address, t.symbol, 52, S.settings.showTokenLogos);
  heroLogo.id = 'tdIcon';
  heroLogo.className = 'ident td-logo';
  $('#tdIcon').replaceWith(heroLogo);
  $('#tdTitle').textContent = t.symbol;
  $('#tdSym').textContent = t.symbol;
  $('#tdFullName').textContent = '';
  $('#tdBal').innerHTML = `${fmt(t.balance)} <span class="muted" style="font-size:15px">${esc(t.symbol)}</span>`;
  $('#tdFiat').textContent = t.fiat != null ? `≈ ${fmtFiat(t.fiat, OV.fiat.currency)}` : '';
  // Not fmtFiat() here - that's always 2dp, which renders a sub-cent token price (very common
  // for anything that isn't a stablecoin) as a misleading "0.00".
  $('#tdPrice').textContent = t.price != null ? `${fiatSymbol(OV.fiat?.currency)}${t.price.toFixed(t.price < 1 ? 6 : 2)}` : '';
  // Prefilled from the asset list's already-fetched 24h figure so something shows instantly;
  // loadTokenSparkline() below refines this to whichever chart range is selected once it loads.
  if (t.change24h != null) {
    const up = t.change24h >= 0;
    $('#tdChange').textContent = `${up ? '▲' : '▼'} ${Math.abs(t.change24h).toFixed(2)}% (24h)`;
    $('#tdChange').className = 'change ' + (up ? 'up' : 'down');
  } else {
    $('#tdChange').classList.add('hidden');
  }

  const netBadge = $('#tdNetBadge');
  netBadge.innerHTML = '';
  netBadge.appendChild(chainLogo(S.network.chainId, S.network.name, 14, S.settings.showTokenLogos));
  netBadge.appendChild(document.createTextNode(S.network.name));

  $('#tdSymRow').textContent = t.symbol;
  $('#tdNet').textContent = S.network.name;
  $('#tdDec').textContent = t.decimals;
  $('#tdNameRow').classList.add('hidden');
  $('#tdName').textContent = '';

  // Reset in case a copy's "Copied" state (below) is still showing from a different token opened
  // within the last 1.5s.
  const copyBtn = $('#tdCopyAddr');
  clearTimeout(copyBtn._resetTimer);
  copyBtn.classList.remove('copied');
  copyBtn.innerHTML = `${icon('copy', { size: 12 })}<span>Copy</span>`;

  const hasAddr = !!t.address;
  $('#tdAddrCard').classList.toggle('hidden', !hasAddr);
  $('#tdRemove').classList.toggle('hidden', !hasAddr);
  $('#tdStandardRow').classList.toggle('hidden', !hasAddr);
  $('#tdExplorer').classList.toggle('hidden', !S.network.explorer);
  const verify = $('#tdVerify');
  if (hasAddr) {
    $('#tdAddr').textContent = t.address;
    $('#tdStandard').textContent = tokenStandardFor(S.network.chainId);
    // Only ever a claim about matching this wallet's own curated list - never a statement about
    // the token itself being safe. A manually-imported token gets a plain caution note instead of
    // a false sense of security, since anyone can deploy a contract with any name/symbol they like.
    if (t.isBuiltIn) {
      verify.className = 'td-verify ok';
      verify.innerHTML = `${icon('check', { size: 16 })}<span><b>Known token</b><br>Matches FutureWallet's built-in list for ${esc(S.network.name)}.</span>`;
    } else {
      verify.className = 'td-verify caution';
      verify.innerHTML = `${icon('search', { size: 16 })}<span><b>Manually imported</b><br>Anyone can deploy a token with this name - double-check the contract address.</span>`;
    }
    verify.classList.remove('hidden');
    // Best-effort - not every token implements name(), and a slow RPC shouldn't hold up the rest
    // of the screen, so this fills in after the fact instead of being awaited above.
    call('tokenName', { address: t.address })
      .then((name) => {
        if (currentToken !== t || !name) return; // user moved on before this resolved
        $('#tdFullName').textContent = name;
        $('#tdName').textContent = name;
        $('#tdNameRow').classList.remove('hidden');
      })
      .catch(() => {});
  } else {
    verify.classList.add('hidden');
  }

  // Reset chart state + range tabs to the default each time a different asset is opened.
  tdSparkDays = 7;
  tdChartPoints = null;
  $$('#tdRangeRow .range').forEach((x) => x.classList.toggle('on', x.dataset.days === '7'));
  loadTokenSparkline();
  view('tokenDetail');
}
$('#tdCopyAddr').onclick = async () => {
  if (!currentToken?.address) return;
  await copy(currentToken.address);
  const btn = $('#tdCopyAddr');
  btn.classList.add('copied');
  btn.innerHTML = `${icon('check', { size: 12 })}<span>Copied</span>`;
  clearTimeout(btn._resetTimer);
  btn._resetTimer = setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = `${icon('copy', { size: 12 })}<span>Copy</span>`;
  }, 1500);
};
$('#tdReceive').onclick = () => {
  receiveAssetValue = currentToken?.address || 'native';
  $('#receiveAddr').textContent = S.selectedAddress;
  $('#receiveEns').textContent = OV.ensName || '';
  updateReceiveAsset();
  view('receive');
};

$('#toggleZero').onclick = () => { hideZero = !hideZero; $('#toggleZero').textContent = hideZero ? 'Show all' : 'Hide zero'; renderTokens(); };
$('#toggleSort').onclick = () => { sortByValue = !sortByValue; $('#toggleSort').textContent = sortByValue ? 'Sort: value' : 'Sort: added'; renderTokens(); };
$('#tdSend').onclick = () => openSend(currentToken?.address || 'native');
$('#tdSwap').onclick = () => openSwap(currentToken?.address || 'native');
$('#tdExplorer').onclick = () => {
  if (!S?.network?.explorer) return toast('This network has no explorer configured');
  const baseUrl = S.network.explorer.replace(/\/$/, '');
  const url = currentToken?.address
    ? `${baseUrl}/token/${currentToken.address}`
    : `${baseUrl}/address/${S.selectedAddress}`;
  openExplorerUrl(url);
};
$('#tdRemove').onclick = async () => {
  if (!currentToken?.address) return;
  if (!(await confirmDialog('Hide token', `${currentToken.symbol} will be removed from your list. Your balance is unaffected and you can import it again.`, { okLabel: 'Hide', danger: true }))) return;
  await call('removeToken', { address: currentToken.address });
  view('home'); loadOverview();
};

function rowItem(icon, title, sub, right, onclick) {
  const d = document.createElement('div');
  d.className = 'rowitem';
  d.innerHTML = `<div class="tokenicon">${icon}</div><div class="grow"><div class="title">${title}</div><div class="sub">${sub}</div></div><div class="right">${right}</div>`;
  if (onclick) d.onclick = onclick;
  return d;
}

let currentNft = null;

function openNft(n) {
  currentNft = n;
  const img = $('#ndImage');
  const src = safeImg(n.image);
  if (src) {
    img.src = src;
    img.classList.remove('hidden');
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden'); // no artwork: don't leave a 200px empty box
  }
  $('#ndTitle').textContent = n.name || 'NFT';
  $('#ndName').textContent = `${n.name || 'NFT'} #${n.tokenId}`;
  $('#ndContract').textContent = n.contract;
  $('#ndTokenId').textContent = n.tokenId;
  $('#ndStandard').textContent = n.standard === 'erc1155' ? 'ERC-1155' : 'ERC-721';
  $('#ndNetwork').textContent = S.network.name;
  view('nftDetail');
}

$('#ndTransfer').onclick = async () => {
  if (!currentNft) return;
  const to = await promptDialog('Transfer NFT', {
    label: 'Recipient address', placeholder: '0x… or name.eth',
    body: `${currentNft.name} #${currentNft.tokenId}`, okLabel: 'Send'
  });
  if (!to) return;
  try {
    const h = await call('sendNft', { from: S.selectedAddress, to, contract: currentNft.contract, tokenId: currentNft.tokenId });
    toast('Sent ' + short(h, 5));
    view('nfts'); renderNfts();
  } catch (e) { toast(e.message.slice(0, 120)); }
};

$('#ndRemove').onclick = async () => {
  if (!currentNft) return;
  if (!(await confirmDialog('Remove NFT', 'This only removes it from your list. Ownership on-chain is unaffected.', { okLabel: 'Remove', danger: true }))) return;
  await call('removeNft', { address: S.selectedAddress, contract: currentNft.contract, tokenId: currentNft.tokenId });
  view('nfts'); renderNfts();
};

$('#ndExplorer').onclick = () => openExplorerUrl(S.network?.explorer && currentNft ? `${S.network.explorer.replace(/\/$/, '')}/token/${currentNft.contract}?a=${currentNft.tokenId}` : null);

async function renderNfts() {
  const list = await call('nfts', { address: S.selectedAddress }).catch(() => []);
  const el = $('#nftGrid');
  el.innerHTML = list.length ? '' : '<div class="empty" style="grid-column:1/-1">No NFTs imported</div>';
  list.forEach((n) => {
    const d = document.createElement('div');
    d.className = 'nftcard';
    d.innerHTML = `<img src="${safeImg(n.image)}" onerror="this.style.background='var(--bg-alt)';this.removeAttribute('src')" /><div class="cap"><div>${esc(n.name)}</div><div class="muted">#${esc(n.tokenId)}</div></div>`;
    d.onclick = () => openNft(n);
    el.appendChild(d);
  });
}

// Icon by transaction *kind* (send/receive/swap/approve/nft), not status - the status badge
// already says pending/confirmed/failed, so the icon's job is to answer "what kind of tx is
// this", which a status-only icon never could.
const ACTIVITY_KIND_ICON = {
  send: { name: 'send', bg: 'var(--accent-bg)', fg: 'var(--accent-2)' },
  receive: { name: 'receive', bg: 'var(--green-bg)', fg: 'var(--green)' },
  swap: { name: 'swap', bg: 'var(--accent-bg)', fg: 'var(--accent-2)' },
  approve: { name: 'lock', bg: 'var(--amber-bg)', fg: 'var(--amber)' },
  nft: { name: 'nft', bg: 'var(--accent-bg)', fg: 'var(--accent-2)' },
  other: { name: 'send', bg: 'var(--accent-bg)', fg: 'var(--accent-2)' }
};
const ACTIVITY_FAILED_ICON = { name: 'close', bg: 'var(--red-bg)', fg: 'var(--red)' };

/** History entries created before this "kind" tagging shipped won't have one stored - guess it
 * from the summary text instead of leaving them iconless/unfilterable forever. */
function inferKind(t) {
  if (t.kind) return t.kind;
  if (t.direction === 'in') return 'receive';
  const s = (t.summary || '').toLowerCase();
  if (s.startsWith('send')) return 'send';
  if (s.includes('swap')) return 'swap';
  if (s.includes('approv') || s.includes('allowance')) return 'approve';
  if (s.startsWith('nft')) return 'nft';
  return 'other';
}

/** One transaction row - shared by the full History screen and the Home "Recent activity" preview. */
function activityRow(t) {
  const d = document.createElement('div');
  d.className = 'rowitem';
  const kind = inferKind(t);
  const st = t.status === 'failed' ? ACTIVITY_FAILED_ICON : ACTIVITY_KIND_ICON[kind] || ACTIVITY_KIND_ICON.other;
  const counterparty = t.direction === 'in' ? t.from : t.to;
  d.innerHTML = `<div class="icon-tile md" style="background:${st.bg};color:${st.fg}">${icon(st.name, { size: 16 })}</div>
    <div class="grow"><div class="title">${esc(t.summary || 'Transaction')}</div><div class="sub" style="font-family:inherit">${timeAgo(t.ts)}${counterparty ? ' · ' + short(counterparty, 4) : ''}</div></div>
    <span class="badge ${t.status === 'confirmed' ? 'ok' : t.status === 'failed' ? 'failed' : 'pending'}">${t.status}</span>`;
  d.onclick = () => openTx(t);
  return d;
}

/** Pure re-filter of the already-fetched list - no network call, so tapping a filter tab is
 * instant regardless of how long the underlying `history` fetch took. */
function renderActivityList() {
  const all = activityAll || [];
  // "Pending" is a status filter, "Send"/"Received"/"Swap" are type filters - two different
  // dimensions living in the same tab bar, so they need two different predicates.
  const list =
    activityFilter === 'all' ? all : activityFilter === 'pending' ? all.filter((t) => t.status === 'pending') : all.filter((t) => inferKind(t) === activityFilter);
  const el = $('#activityList');
  el.innerHTML = list.length ? '' : `<div class="empty">${all.length ? 'Nothing matches this filter' : 'No transactions yet'}</div>`;
  list.forEach((t) => el.appendChild(activityRow(t)));
}

/** Fetches fresh history (the slow part - on-chain receipt reconciliation) and refills the
 * cache. Call this when the History screen is (re)opened or data actually changed (clear); use
 * renderActivityList() alone for anything that's just re-filtering what's already loaded. */
async function loadActivity() {
  skeletonRows($('#activityList'), 4);
  activityAll = await call('history', { address: S.selectedAddress }).catch(() => []);
  renderActivityList();
}

// Separate from overviewLoaded - that one's already true by the time this runs (loadOverview()
// flips it before calling renderHomeActivity()), so it can't tell first-load apart from the 15s
// background poll on its own here.
let homeActivityLoaded = false;
async function renderHomeActivity() {
  const el = $('#homeActivity');
  const firstLoad = !homeActivityLoaded;
  const all = await call('history', { address: S.selectedAddress }).catch(() => []);
  el.innerHTML = '';
  if (!all.length) {
    el.innerHTML = `<div class="empty"><div style="font-weight:600;color:var(--text);margin-bottom:2px">No recent activity</div>Your transactions will appear here.</div>`;
    homeActivityLoaded = true;
    return;
  }
  all.slice(0, 3).forEach((t, i) => {
    const row = activityRow(t);
    if (firstLoad) row.style.animationDelay = `${i * 35}ms`;
    else row.style.animation = 'none';
    el.appendChild(row);
  });
  homeActivityLoaded = true;
}

$$('#actFilter .seg').forEach((sg) => (sg.onclick = () => {
  $$('#actFilter .seg').forEach((x) => x.classList.toggle('on', x === sg));
  activityFilter = sg.dataset.f;
  renderActivityList();
}));
$('#btnClearActivity').onclick = async () => {
  if (!(await confirmDialog('Clear activity', 'This only clears the local list. Your on-chain transactions are unaffected.', { okLabel: 'Clear', danger: true }))) return;
  await call('clearActivity', { address: S.selectedAddress });
  loadActivity();
};

function openTx(t) {
  const partyLabel = t.direction === 'in' ? 'From' : 'To';
  const party = t.direction === 'in' ? t.from : t.to;
  $('#txBody').innerHTML =
    kv('Status', t.status) + kv('Summary', t.summary || '—') + kv(partyLabel, party ? short(party, 6) : '—') +
    kv('Nonce', t.nonce ?? '—') + kv('Time', new Date(t.ts).toLocaleString()) +
    `<label>Hash</label><div class="code">${t.hash}</div>`;
  const act = $('#txActions');
  act.innerHTML = '';
  if (t.status === 'pending') {
    const sp = document.createElement('button');
    sp.className = 'primary';
    sp.textContent = 'Speed up';
    sp.onclick = async () => {
      try { toast('New hash: ' + short(await call('speedUp', { hash: t.hash, from: S.selectedAddress }), 5)); await loadActivity(); view('home'); }
      catch (e) { toast(e.message.slice(0, 90)); }
    };
    const cn = document.createElement('button');
    cn.className = 'danger';
    cn.textContent = 'Cancel';
    cn.onclick = async () => {
      try { await call('cancelTx', { hash: t.hash, from: S.selectedAddress }); toast('Cancellation sent'); await loadActivity(); view('home'); }
      catch (e) { toast(e.message.slice(0, 90)); }
    };
    act.append(sp, cn);
  }
  if (S.network.explorer) {
    const ex = document.createElement('button');
    ex.className = 'plain';
    ex.textContent = 'Explorer';
    ex.onclick = () => openExplorerUrl(S.network?.explorer && t?.hash ? `${S.network.explorer.replace(/\/$/, '')}/tx/${t.hash}` : null);
    act.appendChild(ex);
  }
  view('txDetail');
}

const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;

/* ---------------- onboarding ---------------- */

$('#btnCreate').onclick = () => { importMode = false; $('#pwTitle').textContent = 'Create password'; view('password'); updatePwValidity(); };
$('#btnImportSeed').onclick = () => { view('import'); updateImportValidity(); };
// Continue stays disabled (set in the HTML) until a full-length phrase is typed, so it can't be
// pressed with a partial phrase. The actual checksum/wordlist check still runs on click, since
// word count alone doesn't prove the phrase is valid.
function updateImportValidity() {
  const words = $('#importSeed').value.trim().split(/\s+/).filter(Boolean);
  $('#importNext').disabled = ![12, 15, 18, 21, 24].includes(words.length);
}
$('#importSeed').addEventListener('input', () => {
  $('#importSeedError').textContent = '';
  updateImportValidity();
});
$('#importNext').onclick = async () => {
  const p = $('#importSeed').value.trim().replace(/\s+/g, ' ');
  const words = p.split(' ').filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    $('#importSeedError').textContent = 'Enter 12, 15, 18, 21 or 24 words';
    return;
  }
  // withBusy swaps the label to "Checking..." for the round trip to the background service
  // worker - without it, a slow-to-wake-up MV3 worker (common right after the extension itself
  // was just reloaded) left the button looking frozen/unresponsive for a few seconds with zero
  // feedback, which read as "Continue doesn't work" even though it was just still validating.
  const valid = await withBusy('#importNext', 'Checking…', () => call('validateMnemonic', { phrase: p }));
  if (!valid) { $('#importSeedError').textContent = 'Invalid recovery phrase. Check the words and try again.'; return; }
  $('#importSeedError').textContent = '';
  seedDraft = p; importMode = true; $('#pwTitle').textContent = 'Create password'; view('password'); updatePwValidity();
};
/** Continue only turns on once both fields are filled, long enough, and actually match - lets
 * the confirm field show a live tick/mismatch hint instead of the old "type it, hit Continue,
 * get bounced back by a toast" round trip. */
function updatePwValidity() {
  const p1 = $('#pw1').value, p2 = $('#pw2').value;
  const longEnough = p1.length >= 8;
  const matches = p2.length > 0 && p1 === p2;
  $('#pw2Match').classList.toggle('hidden', !matches);
  $('#pw2Hint').textContent = p2.length > 0 && !matches ? 'Passwords do not match' : '';
  $('#pwNext').disabled = !(longEnough && matches);
}
$('#pw1').addEventListener('input', (e) => {
  const st = passwordStrength(e.target.value);
  $('#pwBar').style.width = st.pct + '%';
  $('#pwBar').style.background = st.color;
  $('#pwLabel').textContent = e.target.value ? st.label : '';
  updatePwValidity();
});
$('#pw2').addEventListener('input', updatePwValidity);

$('#pwNext').onclick = async () => {
  const p1 = $('#pw1').value, p2 = $('#pw2').value;
  if (p1.length < 8) return toast('Minimum 8 characters');
  if (p1 !== p2) return toast('Passwords do not match');
  pwDraft = p1;
  if (importMode) {
    try { await call('createWallet', { password: p1, mnemonic: seedDraft, backupDone: true }); toast('Wallet imported'); await refresh(); }
    catch (e) { toast(e.message); }
    return;
  }
  seedDraft = await call('generateMnemonic');
  $('#seedWords').innerHTML = seedDraft.split(' ').map((w, i) => `<span><b>${i + 1}</b>${w}</span>`).join('');
  view('seed');
};
$('#copySeed').onclick = () => copy(seedDraft);
// Same "Continue only turns on once the real condition is met" pattern as the password screen -
// disabled by default (set in the HTML) so this doesn't depend on the checkbox's initial state.
$('#seedAck').addEventListener('change', (e) => { $('#seedNext').disabled = !e.target.checked; });
$('#seedNext').onclick = () => {
  if (!$('#seedAck').checked) return;
  startVerify();
};

function startVerify() {
  const words = seedDraft.split(' ');
  const idxs = [];
  while (idxs.length < 3) { const i = Math.floor(Math.random() * words.length); if (!idxs.includes(i)) idxs.push(i); }
  idxs.sort((a, b) => a - b);
  verifyState = { words, idxs, filled: {} };
  const pool = [...idxs.map((i) => words[i]), ...words.filter((w, i) => !idxs.includes(i)).slice(0, 5)].sort(() => Math.random() - 0.5);
  $('#verifySlots').innerHTML = words
    .map((w, i) => `<span data-slot="${i}"><b>${i + 1}</b>${idxs.includes(i) ? '____' : w}</span>`)
    .join('');
  $('#verifyChoices').innerHTML = pool.map((w) => `<div class="chip" data-word="${w}">${w}</div>`).join('');
  $$('#verifyChoices .chip').forEach((c) => (c.onclick = () => pickWord(c)));
  // Reset lands back here too (see #verifyReset below) - re-disable Confirm and clear the
  // progress hint/error so a reset genuinely starts the check over, not just the visible slots.
  $('#verifyDone').disabled = true;
  $('#verifyError').classList.add('hidden');
  updateVerifyProgress();
  view('verify');
}

function updateVerifyProgress() {
  const total = verifyState.idxs.length;
  const done = verifyState.idxs.filter((i) => verifyState.filled[i]).length;
  $('#verifyProgress').textContent = done < total ? `${done} of ${total} words filled` : 'All words filled';
}

function pickWord(chip) {
  const next = verifyState.idxs.find((i) => !verifyState.filled[i]);
  if (next == null) return;
  verifyState.filled[next] = chip.dataset.word;
  chip.classList.add('on');
  $(`#verifySlots [data-slot="${next}"]`).innerHTML = `<b>${next + 1}</b>${chip.dataset.word}`;
  updateVerifyProgress();
  // Only turns on once every blank actually has a word in it - previously Confirm was always
  // clickable and just toasted an error on a wrong/incomplete attempt after the fact.
  $('#verifyDone').disabled = !verifyState.idxs.every((i) => verifyState.filled[i]);
}

$('#verifyReset').onclick = () => startVerify();
$('#verifyDone').onclick = () => {
  const wrong = verifyState.idxs.filter((i) => verifyState.filled[i] !== verifyState.words[i]);
  // Was just a toast that vanished in ~2s with no indication of WHICH word(s) were wrong - now
  // the mismatched slot(s) themselves turn red and stay that way (through a Reset, if needed)
  // alongside a message that doesn't disappear until the user actually acts on it.
  $$('#verifySlots [data-slot]').forEach((el) => el.classList.remove('wrong'));
  if (wrong.length) {
    wrong.forEach((i) => $(`#verifySlots [data-slot="${i}"]`).classList.add('wrong'));
    $('#verifyError').textContent = `${wrong.length} word${wrong.length > 1 ? 's' : ''} in the wrong spot - check the highlighted slot${wrong.length > 1 ? 's' : ''} below.`;
    $('#verifyError').classList.remove('hidden');
    return;
  }
  $('#verifyError').classList.add('hidden');
  finishOnboard(true);
};

async function finishOnboard(backupDone) {
  try {
    await call('createWallet', { password: pwDraft, mnemonic: seedDraft, backupDone });
    seedDraft = pwDraft = null;
    toast('Wallet ready');
    await refresh();
  } catch (e) { toast(e.message); }
}

$('#vaultRestore').onclick = async () => {
  const f = $('#vaultFile').files?.[0];
  if (!f) return toast('Choose a vault file');
  try {
    const file = JSON.parse(await f.text());
    const overwrite = await confirmDialog('Restore vault', 'If a wallet already exists on this device it will be replaced. Make sure you still have its recovery phrase.', { okLabel: 'Restore', danger: true });
    if (!overwrite) return;
    await call('importVault', { file, password: $('#vaultPw').value, overwrite: true });
    toast('Vault restored');
    await refresh();
  } catch (e) { toast(e.message.slice(0, 90)); }
};

/* ---------------- lock ---------------- */

$('#btnUnlock').onclick = async () => {
  const btn = $('#btnUnlock');
  const field = $('#unlockPw');
  $('#unlockPwError').textContent = '';
  if (!field.value) return toast('Enter your password');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  try {
    await call('unlock', { password: field.value });
    field.value = '';
    field.style.borderColor = '';
    await refresh();
  } catch (e) {
    field.style.borderColor = 'var(--red)';
    // A toast alone fades in ~2s and is easy to miss - this stays on screen until the next
    // attempt, same pattern as importSeedError on the import-wallet screen.
    $('#unlockPwError').textContent = e.message === 'Wrong password' ? 'Wrong password. Please try again.' : e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
};
$('#unlockPw').addEventListener('input', (e) => {
  e.target.style.borderColor = '';
  $('#unlockPwError').textContent = '';
});
$('#unlockPw').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btnUnlock').click());
$('#btnForgot').onclick = async () => {
  if (!(await confirmDialog('Reset wallet', 'Every account on this device will be erased. Only your 12-word recovery phrase can restore them.', { okLabel: 'Reset', danger: true }))) return;
  if (NativeBiometric) { try { await NativeBiometric.deleteCredentials({ server: BIOMETRIC_SERVER }); } catch {} }
  await call('resetWallet'); location.reload();
};

async function biometricUnlock() {
  try {
    await NativeBiometric.verifyIdentity({ reason: 'Unlock FutureWallet', title: 'Unlock wallet' });
    const creds = await NativeBiometric.getCredentials({ server: BIOMETRIC_SERVER });
    await call('unlock', { password: creds.password });
    await refresh();
  } catch (e) {
    // The fingerprint/face check itself can fail or be cancelled - that's a normal, silent
    // fallback to the password field. But if biometry succeeded and the vault then rejected the
    // stored credential (a stale password from before a change password did not sync - e.g. this
    // build predates that fix), say so instead of leaving a "successful" biometric prompt that
    // quietly does nothing.
    if (e?.message === 'Wrong password') {
      $('#unlockPwError').textContent = 'Saved fingerprint no longer matches your password. Unlock with your password, then re-enable biometric unlock in Settings.';
    }
  }
}
$('#btnBiometricUnlock').onclick = () => { biometricAutoTried = true; biometricUnlock(); };

/* ---------------- nav ---------------- */

$$('[data-back]').forEach((b) => (b.onclick = () => goBack(b.dataset.back)));
$$('[data-goto]').forEach((b) => (b.onclick = () => { closeSheets(); openScreen(b.dataset.goto); }));
$$('[data-close-sheet]').forEach((b) => (b.onclick = closeSheets));
// Tokens / NFTs / Activity are separate screens now, reached from the bottom nav.
$$('.tab').forEach((t) => (t.onclick = () => openTab(t.dataset.tab === 'tokens' ? 'assets' : t.dataset.tab)));

function closeSheets() { $$('.sheet').forEach((s) => s.classList.add('hidden')); }
function openSheet(id) { closeSheets(); $(id).classList.remove('hidden'); }

async function openScreen(id) {
  if (id === 'settings') fillSettings();
  if (id === 'networks') renderNetworkManage();
  if (id === 'contacts') renderContacts();
  if (id === 'permissions') renderSites();
  if (id === 'walletconnect') return openWalletConnect();
  if (id === 'approvals') return openApprovals();
  view(id, false);
}

$('#acctBtn').onclick = () => { renderAccounts(); openSheet('#sheetAccounts'); };
$('#netBtn').onclick = () => { $('#netSearch').value = ''; renderNetworkPick(); openSheet('#sheetNetworks'); };
$('#netSearch').oninput = (e) => renderNetworkPick(e.target.value);
$('#netManageSearch').oninput = (e) => renderNetworkManage(e.target.value);
$('#searchBtn').onclick = () => { $('#globalSearchInput').value = ''; renderGlobalSearch(''); openSheet('#sheetSearch'); };
/** In-app notification inbox (bell icon) - a history of everything the admin has sent via
 * remote config, separate from the single dismissible announcement banner. Opening it marks the
 * newest entry as seen (clears the unread dot); it does not affect whether/when the one-time OS
 * notification already fired for each entry (that's tracked server-side in state, independently). */
function renderNotifications() {
  const items = [...(S.notifications || [])].reverse();
  if (!items.length) {
    $('#notifList').innerHTML = '<p class="muted" style="text-align:center;padding:20px 0">No notifications yet.</p>';
    return;
  }
  $('#notifList').innerHTML = items
    .map(
      (n) => `<div class="notif-row d-flex justify-content-between align-items-start gap-2" data-id="${esc(n.id)}">
        <div class="grow">
          <div class="title">${esc(n.title || '')}</div>
          ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
          <div class="time">${n.ts ? timeAgo(n.ts) : ''}</div>
        </div>
        <button type="button" class="link btn btn-link text-decoration-none notif-del" style="padding:0;font-size:16px;line-height:1">&times;</button>
      </div>`
    )
    .join('');
  // This only hides the row on THIS device (see deleteNotification in background/index.js) - it
  // never touches the shared admin-sent list, so one user clearing their inbox can't make a
  // notification disappear for everyone else.
  $$('#notifList .notif-del').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.notif-row');
      const id = row.dataset.id;
      row.remove();
      S.notifications = (S.notifications || []).filter((n) => n.id !== id);
      if (!S.notifications.length) renderNotifications();
      await call('deleteNotification', { id }).catch(() => {});
    };
  });
}
$('#clearAllNotifs').onclick = async () => {
  S.notifications = [];
  renderNotifications();
  await call('clearAllNotifications').catch(() => {});
};
$('#btnNotifications').onclick = async () => {
  renderNotifications();
  openSheet('#sheetNotifications');
  // Bypasses the background poll's 30-min throttle - opening the sheet should always show what's
  // actually in Firestore right now, not whatever was last cached.
  await call('checkNotifications').catch(() => toast("Couldn't refresh - showing last known notifications"));
  S = await call('status').catch(() => S);
  renderNotifications();
  if (S.hasUnseenNotifications) {
    $('#notifDot').classList.add('hidden');
    call('markNotificationsSeen').catch(() => {});
  }
};

/** Full list view of every active announcement (the ticker scrolls them but is hard to read
 * mid-scroll) - opened from its own icon, separate from the ticker's dismiss-all "x". */
function renderAnnouncementsList() {
  const items = [...(S.announcements || [])].reverse();
  if (!items.length) {
    $('#annListSheet').innerHTML = '<p class="muted" style="text-align:center;padding:20px 0">No announcements right now.</p>';
    return;
  }
  $('#annListSheet').innerHTML = items
    .map((a) => {
      let when = '';
      if (a.startDate && a.endDate) when = `${new Date(a.startDate).toLocaleDateString()} – ${new Date(a.endDate).toLocaleDateString()}`;
      else if (a.startDate) when = `From ${new Date(a.startDate).toLocaleDateString()}`;
      else if (a.endDate) when = `Until ${new Date(a.endDate).toLocaleDateString()}`;
      return `<div class="notif-row d-flex justify-content-between align-items-start gap-2" data-id="${esc(a.id)}">
        <div class="grow">
          <div class="title">${esc(a.title || '')}</div>
          ${a.body ? `<div class="body">${esc(a.body)}</div>` : ''}
          ${when ? `<div class="time">${when}</div>` : ''}
        </div>
        <button type="button" class="link btn btn-link text-decoration-none ann-list-del" style="padding:0;font-size:16px;line-height:1">&times;</button>
      </div>`;
    })
    .join('');
  // Local-only hide (see deleteAnnouncement in background/index.js) - never touches the shared
  // admin-published list.
  $$('#annListSheet .ann-list-del').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.notif-row');
      const id = row.dataset.id;
      row.remove();
      S.announcements = (S.announcements || []).filter((a) => a.id !== id);
      if (!S.announcements.length) renderAnnouncementsList();
      renderAnnouncementBanner();
      await call('deleteAnnouncement', { id }).catch(() => {});
    };
  });
}
$('#clearAllAnns').onclick = async () => {
  S.announcements = [];
  renderAnnouncementsList();
  renderAnnouncementBanner();
  await call('dismissAnnouncements').catch(() => {});
};
$('#btnAnnouncements').onclick = async () => {
  renderAnnouncementsList();
  openSheet('#sheetAnnouncements');
  // Bypasses the background poll's throttle, same as the notification bell - opening the list
  // should always reflect what's actually published right now.
  await call('checkNotifications').catch(() => {});
  S = await call('status').catch(() => S);
  renderAnnouncementsList();
  renderAnnouncementBanner();
};
$('#globalSearchInput').oninput = (e) => renderGlobalSearch(e.target.value.trim().toLowerCase());
/** Universal search, reachable from the header on every screen - covers the two things people
 * actually look up on the fly: a token they hold, or a contact they want to send to. Reuses
 * assetRow()/openToken() and the same contact-pick-then-resolveTo() flow the Send screen's own
 * contact chips already use, so results behave exactly like tapping them anywhere else would. */
function renderGlobalSearch(q) {
  const el = $('#globalSearchResults');
  el.innerHTML = '';
  if (!q) { el.innerHTML = '<div class="empty">Type to search your tokens and contacts</div>'; return; }

  const native = { address: null, symbol: S.network.symbol, decimals: 18, balance: OV.native.formatted, fiat: OV.fiat?.value ?? null, change24h: OV.fiat?.change24h ?? null, price: OV.fiat?.price ?? null };
  const tokenMatches = [native, ...OV.tokens.map((t) => ({ ...t, fiat: t.fiat ?? null }))]
    .filter((t) => t.symbol.toLowerCase().includes(q) || (t.address || '').toLowerCase().includes(q));
  const contactMatches = (S.contacts || []).filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q));

  if (!tokenMatches.length && !contactMatches.length) { el.innerHTML = '<div class="empty">No matches</div>'; return; }

  const heading = (text) => {
    const h = document.createElement('div');
    h.className = 'muted';
    h.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:10px 4px 4px';
    h.textContent = text;
    return h;
  };

  if (tokenMatches.length) {
    el.appendChild(heading('Tokens'));
    tokenMatches.forEach((t) => {
      const row = assetRow(t);
      row.onclick = () => { closeSheets(); openToken(t); };
      el.appendChild(row);
    });
  }
  if (contactMatches.length) {
    el.appendChild(heading('Contacts'));
    contactMatches.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'rowitem';
      d.innerHTML = `<img class="ident" width="32" height="32" src="${identicon(c.address, 32)}" /><div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${short(c.address, 6)}</div></div>`;
      d.onclick = () => { closeSheets(); openSend('native'); $('#sendTo').value = c.address; resolveTo(); };
      el.appendChild(d);
    });
  }
}
$('#mLock').onclick = async () => { await call('lock'); biometricAutoTried = false; refresh(); };
$('#mExpand').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('ui/popup.html?expanded=1') });
$('#mExplorer').onclick = () => openExplorerUrl(S.network?.explorer ? `${S.network.explorer.replace(/\/$/, '')}/address/${S.selectedAddress}` : null);
$('#btnBrowser').onclick = () => openDapp();
// Not `= openSwap` directly - the DOM calls an onclick handler with the click's PointerEvent as
// its first argument, and openSwap's first parameter is a from-asset address. Wiring it directly
// silently passed that event object through as fromAssetAddress on every tap, so swapFromValue
// was never actually 'native' from here - assetByValue() then couldn't resolve it against
// anything in OV.tokens and the "From" side rendered blank.
$('#btnSwap').onclick = () => openSwap();
$('#doBackup').onclick = () => openScreen('security');
$('#annDismiss').onclick = () => {
  $('#announceBanner').classList.add('hidden');
  call('dismissAnnouncements').catch(() => {});
};

/* ---------------- accounts / networks ---------------- */

function renderAccounts() {
  const el = $('#accountList');
  el.innerHTML = '';
  S.accounts.forEach((a) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    const img = document.createElement('img');
    img.className = 'ident'; img.width = img.height = 32; img.src = identicon(a.address, 32);
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(a.name)} ${a.address === S.selectedAddress ? `<span style="color:var(--accent-2);display:inline-flex;vertical-align:middle">${icon('check', { size: 13 })}</span>` : ''}</div>
      <div class="sub">${short(a.address, 6)}</div>`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = a.type === 'pk' ? 'imported' : a.type === 'watch' ? 'watch' : 'HD';
    const edit = document.createElement('button');
    edit.className = 'iconbtn';
    edit.innerHTML = icon('more', { size: 16 });
    edit.title = 'Manage account';
    edit.onclick = (e) => { e.stopPropagation(); manageAccount(a); };
    d.append(img, meta, badge, edit);
    meta.onclick = async () => { await call('selectAccount', { address: a.address }); closeSheets(); await refresh(); };
    img.onclick = meta.onclick;
    el.appendChild(d);
  });
}

async function manageAccount(a) {
  const choice = await chooseDialog(a.name, short(a.address, 8), [
    { label: 'Rename', value: 'rename', style: 'primary' },
    { label: 'Copy address', value: 'copy' },
    { label: 'View on explorer', value: 'explorer' },
    { label: 'Remove account', value: 'remove', style: 'danger' }
  ]);
  if (!choice) return;

  if (choice === 'copy') return copy(a.address);
  if (choice === 'explorer') return openExplorerUrl(S.network?.explorer ? `${S.network.explorer.replace(/\/$/, '')}/address/${a.address}` : null);
  if (choice === 'rename') {
    const name = await promptDialog('Rename account', { label: 'Account name', value: a.name, okLabel: 'Rename' });
    if (!name) return;
    try { await call('renameAccount', { id: a.id, name }); S = await call('status'); renderAccounts(); await refresh(); toast('Renamed'); }
    catch (e) { toast(e.message.slice(0, 110)); }
    return;
  }
  if (choice === 'remove') {
    const warn = a.type === 'hd'
      ? 'This account comes from your recovery phrase, so it can be restored later by creating accounts again in order.'
      : 'This account was imported. If you have not backed up its private key it will be gone for good.';
    if (!(await confirmDialog('Remove account', `${a.name}\n${short(a.address, 8)}\n\n${warn}`, { okLabel: 'Remove', danger: true }))) return;
    try { await call('removeAccount', { id: a.id }); S = await call('status'); renderAccounts(); await refresh(); toast('Account removed'); }
    catch (e) { toast(e.message.slice(0, 130)); }
  }
}

async function createAccount() {
  try { await call('addAccount', {}); S = await call('status'); renderAccounts(); } catch (e) { toast(e.message); }
}
async function importPrivateKey() {
  const pk = await promptDialog('Import private key', { label: 'Private key', placeholder: '0x…', type: 'password', body: 'This key is stored in your encrypted vault. Never paste a key you received from someone else.', okLabel: 'Import' });
  if (!pk) return;
  try { await call('importPrivateKey', { privateKey: pk }); S = await call('status'); renderAccounts(); toast('Imported'); } catch (e) { toast(e.message); }
}
async function watchAddress() {
  const a = await promptDialog('Add watch-only account', { label: 'Address', placeholder: '0x…', body: 'You will be able to see this balance but not sign anything with it.', okLabel: 'Add' });
  if (!a) return;
  try { await call('addWatchAccount', { address: a }); S = await call('status'); renderAccounts(); toast('Added'); } catch (e) { toast(e.message); }
}
$('#btnAccountMenu').onclick = async () => {
  const choice = await chooseDialog('Add account', '', [
    { label: 'Create account', value: 'create', style: 'primary' },
    { label: 'Import private key', value: 'import' },
    { label: 'Watch address', value: 'watch' }
  ]);
  if (choice === 'create') createAccount();
  else if (choice === 'import') importPrivateKey();
  else if (choice === 'watch') watchAddress();
};

function visibleNetworks(q = '') {
  const term = q.trim().toLowerCase();
  return S.networks.filter((n) => {
    if (!S.settings.showTestNetworks && n.testnet && n.key !== S.network.key) return false;
    if (!term) return true;
    return n.name.toLowerCase().includes(term) || String(n.chainId).includes(term) || n.symbol.toLowerCase().includes(term);
  });
}

function renderNetworkPick(q = '') {
  const el = $('#networkPickList');
  el.innerHTML = '';
  const list = visibleNetworks(q);
  if (!list.length) el.innerHTML = '<div class="empty">No networks matched</div>';
  list.forEach((n) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.appendChild(chainLogo(n.chainId, n.symbol, 26, S.settings.showTokenLogos));
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(n.name)} ${n.key === S.network.key ? '✓' : ''}</div>
      <div class="sub" style="font-family:inherit">Chain ID ${n.chainId}</div>`;
    d.appendChild(meta);
    if (n.testnet) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'test'; d.appendChild(b); }
    d.onclick = async () => { await call('selectNetwork', { key: n.key }); closeSheets(); await refresh(); };
    el.appendChild(d);
  });
}

function renderNetworkManage(q = '') {
  const el = $('#networkManageList');
  el.innerHTML = '';
  const term = q.trim().toLowerCase();
  S.networks.filter((n) => !term || n.name.toLowerCase().includes(term) || String(n.chainId).includes(term)).forEach((n) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.appendChild(chainLogo(n.chainId, n.symbol, 26, S.settings.showTokenLogos));
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(n.name)}</div><div class="sub" style="font-family:inherit">${esc(n.rpcUrl)}</div>`;
    const rm = document.createElement('span'); rm.className = 'badge'; rm.textContent = 'remove';
    d.append(meta, rm);
    d.onclick = async () => {
      if (await confirmDialog('Remove network', `${n.name} will be removed from your network list.`, { okLabel: 'Remove', danger: true })) {
        await call('removeNetwork', { key: n.key }); S = await call('status'); renderNetworkManage();
      }
    };
    el.appendChild(d);
  });
}

$('#netSave').onclick = async () => {
  try {
    await call('addNetwork', {
      network: { name: $('#netNameIn').value.trim(), rpcUrl: $('#netRpc').value.trim(), chainId: Number($('#netChainId').value),
        symbol: $('#netSymbol').value.trim() || 'ETH', explorer: $('#netExplorer').value.trim(), decimals: 18, testnet: false }
    });
    toast('Network added'); await refresh();
  } catch (e) { toast(e.message); }
};

/* ---------------- send ---------------- */

function openSend(assetAddress = 'native') {
  sendAssetValue = assetAddress || 'native';
  $('#contactPick').innerHTML = (S.contacts || []).map((c) => `<div class="chip" data-addr="${esc(c.address)}">${esc(c.name)}</div>`).join('');
  $$('#contactPick .chip').forEach((c) => (c.onclick = () => { $('#sendTo').value = c.dataset.addr; resolveTo(); }));
  $('#sendScan').classList.toggle('hidden', !BarcodeScanner);
  sendResolved = null; gasCfg = null; gasChoice = { preset: 'market', custom: null };
  $('#feeText').textContent = '—'; $('#sendToHint').textContent = ''; updateBal();
  view('send');
}
$('#btnSend').onclick = () => openSend('native');

/** Shared by the Send, Receive and Swap asset pickers - all list native + every tracked token on
 * the current network in the same #sheetAssets sheet, just with a different selected value and a
 * different action once one is tapped. Swap's two pickers also pass excludeValue (whatever the
 * *other* side is currently set to) so the same asset can never end up picked on both sides. */
function renderAssetPickList(selectedValue, onPick, excludeValue = null) {
  const el = $('#assetPickList');
  el.innerHTML = '';
  const chainId = S?.network?.chainId;
  const rows = [{ value: 'native', address: null, symbol: S.network.symbol, balance: OV.native.formatted }]
    .concat(OV.tokens.map((t) => ({ value: t.address, address: t.address, symbol: t.symbol, balance: t.balance })))
    .filter((r) => r.value !== excludeValue);
  rows.forEach((r) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.appendChild(tokenLogo(chainId, r.address, r.symbol, 30));
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(r.symbol)} ${r.value === selectedValue ? '✓' : ''}</div>
      <div class="sub" style="font-family:inherit">${fmt(r.balance)} ${esc(r.symbol)}</div>`;
    d.appendChild(meta);
    d.onclick = () => { closeSheets(); onPick(r); };
    el.appendChild(d);
  });
}

$('#sendAssetPick').onclick = () => { renderAssetPickList(sendAssetValue, onPickSendAsset); openSheet('#sheetAssets'); };
function onPickSendAsset(r) {
  sendAssetValue = r.value;
  // A typed amount is in the OLD asset's units - carrying it over silently would let someone
  // switch BNB -> USDT and send an amount they only ever meant for BNB. Clear it instead.
  $('#sendAmount').value = '';
  updateBal();
  prepGas();
}
function updateBal() {
  const v = sendAssetValue;
  const t = v === 'native' ? null : OV.tokens.find((x) => x.address === v);
  $('#sendBal').textContent = `Available: ${t ? fmt(t.balance) + ' ' + t.symbol : fmt(OV.native.formatted) + ' ' + S.network.symbol}`;
  $('#sendAssetTitle').textContent = t ? t.symbol : S.network.symbol;

  const logoSlot = $('#sendAssetLogo');
  logoSlot.innerHTML = '';
  const chainId = S?.network?.chainId;
  if (chainId) logoSlot.appendChild(tokenLogo(chainId, t?.address || null, t?.symbol || S.network.symbol, 22));
  updateFiatEq();
  updateSendAmountWarn();
}

/** Live "≈ $x" line under the amount input - only shown when a per-unit fiat price is actually
 * known (native coin price, or a token's fiat total divided by its balance), never a guess. */
function updateFiatEq() {
  const el = $('#sendFiatEq');
  const amt = Number($('#sendAmount').value);
  const v = sendAssetValue;
  let unitPrice = null;
  if (v === 'native') {
    if (OV.fiat?.price != null) unitPrice = OV.fiat.price;
  } else {
    const t = OV.tokens.find((x) => x.address === v);
    if (t?.fiat != null && Number(t.balance) > 0) unitPrice = t.fiat / Number(t.balance);
  }
  if (unitPrice == null || !(amt > 0)) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = `≈ ${(amt * unitPrice).toFixed(2)} ${(OV.fiat?.currency || 'usd').toUpperCase()}`;
}
$('#btnMax').onclick = async () => {
  const v = sendAssetValue;
  const t = v === 'native' ? null : OV.tokens.find((x) => x.address === v);
  if (t) {
    $('#sendAmount').value = fmt(t.balance, 8);
  } else {
    // Reserve just enough native coin for gas, not a flat guess - a hardcoded ETH-sized
    // constant leaves nothing (or negative, clamped to 0) on chains/balances where gas is
    // much cheaper, like a small BNB balance. Reuse the live estimate if we already have one
    // (recipient resolved), otherwise fetch a market-rate quote for a plain transfer.
    let reserve = Number(gasCfg?.options?.[gasChoice.preset]?.feeEther);
    if (!(reserve > 0)) {
      try {
        const g = await call('gasOptions', { tx: { from: S.selectedAddress, to: S.selectedAddress, value: '0x0', data: '0x' } });
        reserve = Number(g?.options?.market?.feeEther);
      } catch { reserve = NaN; }
    }
    if (!(reserve > 0)) reserve = 0;
    const max = Math.max(0, Number(OV.native.formatted) - reserve);
    if (max <= 0 && Number(OV.native.formatted) > 0) toast(`Not enough ${S.network.symbol} left over to cover the network fee`);
    $('#sendAmount').value = fmt(max, 8);
  }
  updateFiatEq();
  updateSendAmountWarn();
  prepGas();
};

$('#sendAmount').addEventListener('input', () => { updateFiatEq(); updateSendAmountWarn(); });
$('#sendTo').addEventListener('input', resolveTo);
$('#sendTo').addEventListener('blur', resolveTo);
$('#sendAmount').addEventListener('blur', prepGas);
$('#sendScan').onclick = async () => {
  const raw = await scanQr();
  if (!raw) return;
  if (raw.startsWith('wc:')) { openScreen('walletconnect'); $('#wcUri').value = raw; $('#wcConnect').click(); return; }
  // Accept a bare address or an EIP-681 payment URI ("ethereum:0xADDR@1?...")
  const m = raw.match(/0x[a-fA-F0-9]{40}/);
  if (!m) return toast('That QR code does not contain a wallet address');
  $('#sendTo').value = m[0];
  resolveTo();
};

async function checkRecipientRisks() {
  const box = $('#sendRisks');
  box.innerHTML = '';
  if (!sendResolved) return;
  const r = await call('checkRecipient', { to: sendResolved, from: S.selectedAddress }).catch(() => null);
  if (!r) return;
  box.innerHTML = r.risks.map((x) => `<div class="alert ${x.level === 'danger' ? 'danger' : 'warn'}" style="margin-top:8px">${esc(x.text)}</div>`).join('');
  if (r.known && !r.risks.length) box.innerHTML = '<div class="alert info" style="margin-top:8px">Ye address tum pehle use kar chuke ho ✓</div>';
}

async function resolveTo() {
  const v = $('#sendTo').value.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) { sendResolved = v; $('#sendToHint').textContent = ''; checkRecipientRisks(); return prepGas(); }
  if (/\.[a-z]{2,}$/i.test(v)) {
    $('#sendToHint').textContent = 'Resolving ENS…';
    const a = await call('resolveName', { name: v }).catch(() => null);
    sendResolved = a;
    $('#sendToHint').textContent = a ? `→ ${short(a, 6)}` : 'Could not resolve ENS name';
    if (a) { checkRecipientRisks(); prepGas(); }
  } else { sendResolved = null; $('#sendToHint').textContent = ''; }
}

async function prepGas() {
  if (!sendResolved) return;
  const v = sendAssetValue;
  const token = v === 'native' ? null : OV.tokens.find((t) => t.address === v);
  // For a token send, the estimate must run against the real transfer(to, amount) calldata -
  // estimating with empty data against the token contract undershoots wildly (falls back to a
  // plain-transfer 21k gas guess) and the tx then runs out of gas on-chain, see gasOptions in
  // background/index.js.
  const tx = { from: S.selectedAddress, to: token ? undefined : sendResolved, value: '0x0', data: $('#sendData').value || '0x' };
  try {
    gasCfg = await call('gasOptions', token ? { tx, to: sendResolved, amount: $('#sendAmount').value || '0', token } : { tx });
    applyGasChoice();
  } catch { $('#feeText').textContent = 'Estimate failed'; }
}

function currentGas() {
  if (!gasCfg) return null;
  const g = gasChoice.custom || gasCfg.options[gasChoice.preset];
  return { ...g, nonce: gasChoice.custom?.nonce };
}

/** Whether the account's native balance can actually cover this gas choice (plus the amount
 * itself, for a native send) - null when it can, otherwise {need, have} so the UI can say
 * exactly why. Broadcasting anyway just gets "insufficient funds" back from the RPC after a
 * spinner, so this needs to be caught before Send is even tappable, not after. */
function gasShortfall(g) {
  if (!g) return null;
  const have = Number(OV?.native?.formatted || 0);
  const fee = Number(g.feeEther);
  const amount = sendAssetValue === 'native' ? Number($('#sendAmount').value || 0) : 0;
  const need = fee + amount;
  return need > have ? { need, have } : null;
}

/** gasShortfall() only ever checks the native coin (fee + amount, when sending native) - a token
 * send's amount was never checked against the token's own balance until Review, so typing more
 * USDT than you hold looked accepted the whole time and only failed later. This runs live on
 * every keystroke, for both asset kinds, so "Review Transaction" is disabled the moment the
 * amount goes over what's actually available - not just after the gas step already ran. */
function updateSendAmountWarn() {
  const amt = Number($('#sendAmount').value || 0);
  const v = sendAssetValue;
  const t = v === 'native' ? null : OV.tokens.find((x) => x.address === v);
  const warn = $('#sendGasWarn');
  let over = null;
  if (t) {
    if (amt > Number(t.balance)) over = `Insufficient balance - you have ${fmt(t.balance, 6)} ${t.symbol}`;
  } else {
    const short = gasShortfall(currentGas());
    if (short) over = `Not enough ${S.network.symbol} for the amount + network fee - need ≈${fmt(short.need, 6)}, have ${fmt(short.have, 6)}`;
  }
  warn.classList.toggle('hidden', !over);
  if (over) warn.textContent = over;
  $('#sendConfirm').disabled = !!over;
}

function applyGasChoice() {
  const g = currentGas();
  if (!g) return;
  $('#feeText').textContent = `≈ ${fmt(g.feeEther, 6)} ${S.network.symbol}`;
  $('#gasLabel').textContent = gasChoice.custom ? 'Advanced' : gasCfg.options[gasChoice.preset].label;
  updateSendAmountWarn();
}

$('#editGas').onclick = () => {
  if (!gasCfg) return toast('Enter an address and amount first');
  const el = $('#gasOpts');
  el.innerHTML = '';
  Object.entries(gasCfg.options).forEach(([k, o]) => {
    const d = document.createElement('div');
    d.className = 'gasopt' + (!gasChoice.custom && gasChoice.preset === k ? ' on' : '');
    d.innerHTML = `<div class="grow"><b>${o.label}</b><div class="muted">${o.eta}</div></div><div>${fmt(o.feeEther, 6)} ${S.network.symbol}</div>`;
    d.onclick = () => { gasChoice = { preset: k, custom: null }; applyGasChoice(); closeSheets(); };
    el.appendChild(d);
  });
  const g = currentGas();
  $('#gasLimitIn').value = BigInt(g.gasLimit).toString();
  $('#maxFeeIn').value = (Number(BigInt(g.maxFeePerGas)) / 1e9).toFixed(3);
  $('#tipIn').value = (Number(BigInt(g.maxPriorityFeePerGas)) / 1e9).toFixed(3);
  $('#nonceIn').value = gasCfg.nonce;
  $('#nonceLabel').classList.toggle('hidden', !S.settings.useCustomNonce);
  $('#nonceIn').classList.toggle('hidden', !S.settings.useCustomNonce);
  openSheet('#sheetGas');
};

$('#gasSave').onclick = () => {
  const limit = BigInt($('#gasLimitIn').value || '21000');
  const maxFee = BigInt(Math.round(Number($('#maxFeeIn').value || 1) * 1e9));
  const tip = BigInt(Math.round(Number($('#tipIn').value || 1) * 1e9));
  gasChoice = {
    preset: 'custom',
    custom: {
      eip1559: gasCfg.eip1559,
      gasLimit: '0x' + limit.toString(16),
      maxFeePerGas: '0x' + maxFee.toString(16),
      maxPriorityFeePerGas: '0x' + tip.toString(16),
      gasPrice: '0x' + maxFee.toString(16),
      feeEther: String(Number(maxFee * limit) / 1e18),
      nonce: S.settings.useCustomNonce ? $('#nonceIn').value : undefined
    }
  };
  applyGasChoice();
  closeSheets();
};

let lastSentHash = '';

$('#sendConfirm').onclick = async () => {
  await resolveTo();
  if (!sendResolved) return toast('Enter a valid address or ENS name');
  const amount = $('#sendAmount').value.trim();
  if (!(Number(amount) > 0)) return toast('Enter an amount');
  const v = sendAssetValue;
  const token = v === 'native' ? null : (OV?.tokens || []).find((t) => t.address === v);
  const sym = token ? token.symbol : S?.network?.symbol || 'ETH';
  if (token && Number(amount) > Number(token.balance)) return toast(`Insufficient balance - you have ${fmt(token.balance, 6)} ${sym}`);

  $('#csSendAmount').textContent = `${amount} ${sym}`;
  const fiatText = $('#sendFiatEq').textContent;
  $('#csSendFiat').textContent = fiatText || '';
  $('#csSendTo').textContent = sendResolved;
  $('#csSendNetwork').textContent = S?.network?.name || 'Network';
  $('#csSendFee').textContent = $('#feeText').textContent || '—';

  const shortfall = gasShortfall(currentGas());
  $('#csSendGasWarn').classList.toggle('hidden', !shortfall);
  if (shortfall) $('#csSendGasWarn').textContent = `Not enough ${S.network.symbol} for the network fee - need ≈${fmt(shortfall.need, 6)}, have ${fmt(shortfall.have, 6)}`;
  $('#csSendGoBtn').disabled = !!shortfall;

  view('confirmSend');
};

$('#csSendGoBtn').onclick = async () => {
  const amount = $('#sendAmount').value.trim();
  const v = sendAssetValue;
  const token = v === 'native' ? null : (OV?.tokens || []).find((t) => t.address === v);
  const sym = token ? token.symbol : S?.network?.symbol || 'ETH';
  const btn = $('#csSendGoBtn');
  // Belt-and-braces: the button is already disabled from the Review step when this is true, but
  // re-check here too in case gas/balance moved (a price refresh, a stray edit) while this
  // screen was open - broadcasting anyway just wastes a round trip for a guaranteed RPC rejection.
  const shortfall = gasShortfall(currentGas());
  if (shortfall) return toast(`Not enough ${S.network.symbol} for the network fee - need ≈${fmt(shortfall.need, 6)}, have ${fmt(shortfall.have, 6)}`, 3500);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const hash = await call('send', { to: sendResolved, amount, token, from: S.selectedAddress, gas: currentGas(), data: $('#sendData').value || '0x' });
    lastSentHash = hash;
    $('#ssAmount').textContent = `${amount} ${sym}`;
    $('#ssTo').textContent = `To: ${short(sendResolved, 6)}`;
    $('#ssHash').textContent = hash;
    $('#sendTo').value = $('#sendAmount').value = $('#sendData').value = '';
    await refresh().catch(() => {});
    view('sendSuccess');
  } catch (e) {
    // The RPC's own wording for this ("insufficient funds for gas * price + value" or similar)
    // is not something a non-technical user can act on - say the actual, fixable problem
    // instead. gasShortfall() should already have caught this before broadcast; this is the
    // fallback for a balance/gas-price that moved in the few seconds since that check ran.
    const msg = /insufficient funds/i.test(e?.message || '') ? `Not enough ${S.network.symbol} in this wallet to cover the network fee` : e?.message?.slice(0, 110) || 'Transaction failed';
    toast(msg, 3500);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

$('#ssDoneBtn').onclick = () => view('home');
$('#ssExplorerBtn').onclick = () => {
  if (!lastSentHash) return;
  openExplorerUrl(S.network?.explorer ? `${S.network.explorer.replace(/\/$/, '')}/tx/${lastSentHash}` : null);
};

/* ---------------- swap ---------------- */

let swapQ = null;
let swapFromValue = 'native';
let swapToValue = null;
// Was hardcoded to 'market' everywhere with no way to pick anything cheaper - unlike Send, which
// has a full gas picker. Low still uses the same estimateGas-based limit, just a smaller
// fee/tip multiplier (see GAS_PRESETS in config/settings.js), so it's a real saving, not a trick.
let swapGasPreset = 'market';
/** Fills the Confirm Swap screen's fee line + its "View gas details" breakdown from whichever
 * preset is currently selected - shared by the gas-speed row and the initial screen-open fill so
 * the two can't drift out of sync. */
function renderSwapGasDetail() {
  if (!swapQ?.gas) return;
  const opt = swapQ.gas.options[swapGasPreset];
  const feeText = (bnb, decimals) => {
    const native = `≈ ${fmt(bnb, decimals)} ${S.network.symbol}`;
    return OV.fiat?.price != null ? `${native} (${fmtFiat(bnb * OV.fiat.price, OV.fiat.currency)})` : native;
  };
  $('#csFee').textContent = feeText(Number(opt.feeEther), 6);
  $('#csGasLimit').textContent = BigInt(opt.gasLimit).toString();
  const gwei = (hexWei) => `${(Number(BigInt(hexWei)) / 1e9).toFixed(4)} Gwei`;
  $('#csGasPrice').textContent = gwei(opt.gasPrice);
  $('#csMaxFeeRow').classList.toggle('hidden', !opt.eip1559);
  $('#csPriorityFeeRow').classList.toggle('hidden', !opt.eip1559);
  if (opt.eip1559) {
    $('#csMaxFee').textContent = gwei(opt.maxFeePerGas);
    $('#csPriorityFee').textContent = gwei(opt.maxPriorityFeePerGas);
  }
  $('#csFeeDetail').textContent = feeText(Number(opt.feeEther), 8);
}
$$('#csGasRow .range').forEach((r) => (r.onclick = () => {
  $$('#csGasRow .range').forEach((x) => x.classList.toggle('on', x === r));
  swapGasPreset = r.dataset.preset;
  renderSwapGasDetail();
}));

function assetByValue(v) {
  const sym = S?.network?.symbol || 'ETH';
  const nativeBal = OV?.native?.formatted || '0';
  if (v === 'native') return { address: null, symbol: sym, decimals: 18, balance: nativeBal };
  return (OV?.tokens || []).find((t) => t.address === v);
}

async function openSwap(fromAssetAddress) {
  const info = await call('swapInfo', {}).catch(() => ({ supported: false }));
  const values = ['native', ...(OV?.tokens || []).map((t) => t.address)];
  swapFromValue = fromAssetAddress || 'native';
  // Default "to" to whatever isn't already picked for "from", so opening Swap never starts on
  // the same token both sides (which would just error the moment a quote is requested).
  swapToValue = values.find((v) => v !== swapFromValue) || swapFromValue;
  resetSwapQuote();
  const notice = $('#swapNotice');
  if (!info.supported) {
    notice.textContent = `Swap is not configured for ${S.network.name} - add this chain's router in src/config/swap.js, or pick an aggregator provider in Settings.`;
    notice.classList.remove('hidden');
  } else {
    notice.textContent = info.provider === 'router' ? `Route: ${info.venue} (direct on-chain)` : `Aggregator: ${info.provider}`;
    notice.classList.remove('hidden');
  }
  updateSwapAssets();
  view('swap');
  triggerAutoQuote(0);
}

function updateSwapAssets() {
  const a = assetByValue(swapFromValue);
  const b = assetByValue(swapToValue);
  $('#swapFromBal').textContent = a ? `Balance: ${fmt(a.balance)}` : '';
  $('#swapToBal').textContent = b ? `Balance: ${fmt(b.balance)}` : '';
  $('#swapFromSym').textContent = a ? a.symbol : '—';
  $('#swapToSym').textContent = b ? b.symbol : '—';

  const chainId = S?.network?.chainId;
  const fromSlot = $('#swapFromLogo');
  fromSlot.innerHTML = '';
  if (a && chainId) fromSlot.appendChild(tokenLogo(chainId, a.address, a.symbol, 22));
  const toSlot = $('#swapToLogo');
  toSlot.innerHTML = '';
  if (b && chainId) toSlot.appendChild(tokenLogo(chainId, b.address, b.symbol, 22));
}

let autoQuoteTimer = null;
let autoQuoteReqId = 0;

function resetSwapQuote() {
  clearTimeout(autoQuoteTimer);
  swapQ = null;
  $('#swapOutPreview').value = '';
  $('#swapQuoteCard').classList.add('hidden');
  $('#swapActions').classList.add('hidden');
  updateSwapAmountWarn();
}

function triggerAutoQuote(delay = 400) {
  clearTimeout(autoQuoteTimer);
  const sell = assetByValue(swapFromValue);
  const buy = assetByValue(swapToValue);
  const amount = $('#swapAmount').value.trim();
  const amtNum = Number(amount);

  if (!sell || !buy || !(amtNum > 0) || (sell && amtNum > Number(sell.balance))) {
    resetSwapQuote();
    return;
  }

  swapQ = null;
  $('#swapQuoteCard').classList.add('hidden');
  $('#swapActions').classList.add('hidden');
  $('#swapOutPreview').value = 'Fetching…';
  updateSwapAmountWarn();

  autoQuoteTimer = setTimeout(() => {
    fetchAutoSwapQuote();
  }, delay);
}

async function fetchAutoSwapQuote() {
  const currentReqId = ++autoQuoteReqId;
  const sell = assetByValue(swapFromValue);
  const buy = assetByValue(swapToValue);
  const amount = $('#swapAmount').value.trim();
  const amtNum = Number(amount);

  if (!sell || !buy || !(amtNum > 0) || (sell && amtNum > Number(sell.balance))) {
    resetSwapQuote();
    return;
  }

  try {
    const q = await call('swapQuote', { from: S.selectedAddress, sell, buy, amount });
    if (currentReqId !== autoQuoteReqId) return;
    if ($('#swapAmount').value.trim() !== amount) return;

    swapQ = q;
    $('#qOut').textContent = `${fmt(swapQ.buyFormatted, 6)} ${buy.symbol}`;
    $('#swapOutPreview').value = fmt(swapQ.buyFormatted, 6);
    $('#qRate').textContent = `1 ${sell.symbol} ≈ ${fmt(swapQ.rate, 6)} ${buy.symbol}`;
    $('#qSlip').textContent = (swapQ.slippageBps / 100).toString();
    $('#qMin').textContent = `${fmt(swapQ.minFormatted, 6)} ${buy.symbol}`;
    $('#qVenue').textContent = swapQ.venue;

    const swapFeeEth = swapQ.gas ? Number(swapQ.gas.options[swapGasPreset].feeEther) : null;
    const approvalFeeEth = swapQ.approvalGas ? Number(swapQ.approvalGas.options[swapGasPreset].feeEther) : null;

    const feeText = (bnb) => {
      const native = `≈ ${fmt(bnb, 6)} ${S.network.symbol}`;
      return OV.fiat?.price != null ? `${native} (${fmtFiat(bnb * OV.fiat.price, OV.fiat.currency)})` : native;
    };
    $('#qApprovalFeeRow').classList.toggle('hidden', approvalFeeEth == null);
    if (approvalFeeEth != null) {
      $('#qApprovalFee').textContent = feeText(approvalFeeEth);
      $('#qFeeLabel').textContent = 'Swap network fee';
    } else {
      $('#qFeeLabel').textContent = 'Network fee';
    }
    $('#qFee').textContent = swapFeeEth != null ? feeText(swapFeeEth) : '—';
    $('#qTotalFeeRow').classList.toggle('hidden', approvalFeeEth == null);
    if (approvalFeeEth != null && swapFeeEth != null) {
      $('#qTotalFee').textContent = feeText(approvalFeeEth + swapFeeEth);
    }
    $('#swapQuoteCard').classList.remove('hidden');
    $('#swapActions').classList.remove('hidden');
    $('#swapApproveBtn').classList.toggle('hidden', !swapQ.needsApproval);
    $('#swapGoBtn').disabled = swapQ.needsApproval;
  } catch (e) {
    if (currentReqId !== autoQuoteReqId) return;
    swapQ = null;
    $('#swapOutPreview').value = '';
    $('#swapQuoteCard').classList.add('hidden');
    $('#swapActions').classList.add('hidden');
    if ($('#swapAmount').value.trim() === amount && amtNum > 0) {
      toast(e.message.slice(0, 130));
    }
  }
}

function updateSwapAmountWarn() {
  const sell = assetByValue(swapFromValue);
  const amt = Number($('#swapAmount').value || 0);
  const warn = $('#swapAmountWarn');
  const over = sell && amt > Number(sell.balance);
  warn.classList.toggle('hidden', !over);
  if (over) warn.textContent = `Insufficient balance - you have ${fmt(sell.balance, 6)} ${sell.symbol}`;
  const btn = $('#swapQuoteBtn');
  if (btn) btn.disabled = !!over;
}

$('#swapFromPick').onclick = () => { renderAssetPickList(swapFromValue, onPickSwapFrom, swapToValue); openSheet('#sheetAssets'); };
function onPickSwapFrom(r) {
  swapFromValue = r.value;
  updateSwapAssets();
  triggerAutoQuote(0);
}

$('#swapToPick').onclick = () => { renderAssetPickList(swapToValue, onPickSwapTo, swapFromValue); openSheet('#sheetAssets'); };
function onPickSwapTo(r) {
  swapToValue = r.value;
  updateSwapAssets();
  triggerAutoQuote(0);
}

$('#swapFlip').onclick = () => {
  const tmp = swapFromValue;
  swapFromValue = swapToValue;
  swapToValue = tmp;
  updateSwapAssets();
  triggerAutoQuote(0);
};

$('#swapMax').onclick = async () => {
  const a = assetByValue(swapFromValue);
  if (!a) return;
  if (a.address) {
    $('#swapAmount').value = fmt(a.balance, 8);
  } else {
    let reserve = 0;
    try {
      const g = await call('gasOptions', { tx: { from: S.selectedAddress, to: S.selectedAddress, value: '0x0', data: '0x' } });
      const est = Number(g?.options?.market?.feeEther);
      if (est > 0) reserve = est * 3;
    } catch {}
    const max = Math.max(0, Number(a.balance) - reserve);
    if (max <= 0 && Number(a.balance) > 0) toast(`Not enough ${a.symbol} left over to cover the network fee`);
    $('#swapAmount').value = fmt(max, 8);
  }
  triggerAutoQuote(0);
};

$('#swapAmount').addEventListener('input', () => triggerAutoQuote(400));

$('#swapApproveBtn').onclick = async () => {
  // Was a silent no-op with zero feedback if the quote had gone stale (e.g. the user sat on this
  // screen a while, or switched account/network without re-fetching) - looked exactly like the
  // button doing nothing at all.
  if (!swapQ) return toast('Quote expired - tap "Get quote" again before approving');
  const sell = assetByValue(swapFromValue);
  if (!sell) return toast('Select a token to swap first');
  const choice = await chooseDialog('Approval amount', 'An unlimited approval means this contract can spend that token at any time in the future.', [
    { label: 'Only this amount', value: 'exact', style: 'primary' },
    { label: 'Unlimited', value: 'unlimited', style: 'danger' }
  ]);
  if (!choice) return; // user cancelled the dialog - not an error, nothing to report
  const unlimited = choice === 'unlimited';
  const apBtn = $('#swapApproveBtn');
  const apLabel = apBtn.textContent;
  apBtn.disabled = true;
  apBtn.textContent = 'Approving…';
  try {
    const h = await call('swapApprove', { from: S.selectedAddress, token: sell.address, spender: swapQ.spender, amount: swapQ.sellAmount, unlimited, preset: swapGasPreset });
    toast('Approval sent: ' + short(h, 5) + ' - refresh the quote once it confirms');
  } catch (e) { toast(e.message.slice(0, 120)); }
  finally { apBtn.disabled = false; apBtn.textContent = apLabel; }
};

$('#swapGoBtn').onclick = () => {
  if (!swapQ) return toast('Quote expired - tap "Get quote" again');
  const sell = assetByValue(swapFromValue);
  const buy = assetByValue(swapToValue);
  if (!sell || !buy) return toast('Select both tokens first');
  $('#csFromAmount').textContent = `${$('#swapAmount').value} ${sell.symbol}`;
  $('#csToAmount').textContent = `${fmt(swapQ.buyFormatted, 4)} ${buy.symbol}`;
  $('#csRate').textContent = `1 ${sell.symbol} = ${fmt(swapQ.rate, 4)} ${buy.symbol}`;
  $('#csSlippage').textContent = `${swapQ.slippageBps / 100}%`;
  renderSwapGasDetail();
  $('#csReceive').textContent = `${fmt(swapQ.buyFormatted, 4)} ${buy.symbol}`;
  view('confirmSwap');
};

$('#csConfirmBtn').onclick = async () => {
  if (!swapQ) return;
  const sell = assetByValue(swapFromValue);
  const buy = assetByValue(swapToValue);
  const btn = $('#csConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Swapping…';
  try {
    const h = await call('swapExecute', {
      tx: swapQ.tx,
      gas: swapQ.gas ? swapQ.gas.options[swapGasPreset] : null,
      summary: `Swap ${$('#swapAmount').value} ${sell.symbol} → ${buy.symbol}`
    });
    // Send has its own "Transaction Submitted" screen with the hash and an explorer link - a
    // swap used to just get a toast and get dropped back on Home, with no way to tell it went
    // through short of digging through history. Reuse the same screen; "To: 0x..." doesn't apply
    // to a swap (it's not going to another address) so that line becomes the route instead.
    lastSentHash = h;
    $('#ssAmount').textContent = `${$('#swapAmount').value} ${sell.symbol} → ${fmt(swapQ.buyFormatted, 6)} ${buy.symbol}`;
    $('#ssTo').textContent = `via ${swapQ.venue}`;
    $('#ssHash').textContent = h;
    swapQ = null;
    await refresh().catch(() => {});
    view('sendSuccess');
  } catch (e) { toast(e.message.slice(0, 130)); }
  finally { btn.disabled = false; btn.textContent = 'Review Swap'; }
};

/* ---------------- receive / tokens / nfts ---------------- */

$('#btnReceive').onclick = () => {
  receiveAssetValue = 'native';
  $('#receiveAddr').textContent = S.selectedAddress;
  $('#receiveEns').textContent = OV.ensName || '';
  updateReceiveAsset();
  view('receive');
};
$('#rcvAssetPick').onclick = () => { renderAssetPickList(receiveAssetValue, onPickReceiveAsset); openSheet('#sheetAssets'); };
function onPickReceiveAsset(r) {
  receiveAssetValue = r.value;
  updateReceiveAsset();
}
// Every asset on an EVM chain lands on the same address - picking a token here doesn't change
// what the QR encodes, only the label/logo/warning, so someone can double-check they're being
// asked to send the right asset before they copy the address out.
function updateReceiveAsset() {
  const v = receiveAssetValue;
  const t = v === 'native' ? null : OV.tokens.find((x) => x.address === v);
  const symbol = t ? t.symbol : S.network.symbol;
  $('#rcvAssetTitle').textContent = symbol;
  const logoSlot = $('#rcvAssetLogo');
  logoSlot.innerHTML = '';
  const chainId = S?.network?.chainId;
  if (chainId) logoSlot.appendChild(tokenLogo(chainId, t?.address || null, symbol, 22));
  $('#rcvWarn').textContent = `Only send ${symbol} on ${S.network.name} to this address. Sending a different asset, or using another network, may lose your funds permanently.`;
  try { drawQR($('#qr'), S.selectedAddress); } catch {}
}
$('#copyAddr').onclick = () => { copy(S.selectedAddress); const b = $('#copyAddr'); const o = b.textContent; b.textContent = 'Copied'; b.classList.add('copied'); setTimeout(() => { b.textContent = o; b.classList.remove('copied'); }, 1500); };
$('#btnAddToken').onclick = () => view('addToken');
$('#tokSave').onclick = async () => {
  const b = $('#tokSave');
  if (!/^0x[a-fA-F0-9]{40}$/.test($('#tokAddr').value.trim())) return toast('Enter a valid contract address');
  b.disabled = true; b.textContent = 'Importing…';
  try {
    await call('addToken', { address: $('#tokAddr').value.trim(), symbol: $('#tokSym').value.trim() || undefined, decimals: $('#tokDec').value ? Number($('#tokDec').value) : undefined });
    $('#tokAddr').value = $('#tokSym').value = $('#tokDec').value = '';
    toast('Token imported'); await refresh();
  } catch (e) { toast(e.message.slice(0, 100)); }
  finally { b.disabled = false; b.textContent = 'Import'; }
};
$('#btnAddNft').onclick = () => view('addNft');
$('#nftSave').onclick = async () => {
  try {
    await call('addNft', { address: S.selectedAddress, contract: $('#nftAddr').value.trim(), tokenId: $('#nftId').value.trim(), standard: $('#nftStd').value });
    $('#nftAddr').value = $('#nftId').value = '';
    toast('NFT imported'); view('home'); renderNfts();
  } catch (e) { toast(e.message.slice(0, 100)); }
};

/* ---------------- token approvals manager ---------------- */

let approvalList = [];

async function openApprovals() {
  view('approvals');
  $('#apvStatus').textContent = 'Scanning… (a large lookback can take 10-30 seconds)';
  $('#apvList').innerHTML = '';
  skeletonRows($('#apvList'), 3);
  try {
    const res = await call('scanApprovals', { address: S.selectedAddress, lookbackBlocks: Number($('#apvRange').value || 500000) });
    approvalList = res.approvals;
    $('#apvStatus').textContent = res.partial
      ? res.note
      : `${res.approvals.length} active approval${res.approvals.length === 1 ? '' : 's'} · block ${res.scannedFrom} → ${res.latest}`;
    renderApprovals();
  } catch (e) {
    $('#apvList').innerHTML = '';
    $('#apvStatus').textContent = 'Scan failed: ' + e.message.slice(0, 120);
  }
}

function renderApprovals() {
  const el = $('#apvList');
  el.innerHTML = approvalList.length ? '' : '<div class="empty">No active approvals - that is a good thing</div>';
  approvalList.forEach((a) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.appendChild(tokenLogo(S.network.chainId, a.token, a.symbol, 32, S.settings.showTokenLogos));
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(a.symbol)} · ${esc(a.display)}</div>
      <div class="sub" style="font-family:inherit">${esc(a.spenderLabel || short(a.spender, 5))}${a.kind === 'nft' ? ' · NFT' : ''}</div>`;
    const bd = document.createElement('span');
    bd.className = 'badge ' + (a.unlimited ? 'failed' : '');
    bd.textContent = 'revoke';
    d.append(meta, bd);
    d.onclick = async () => {
      const act = a.kind === 'nft' ? 'revoke' : await chooseDialog(
        `${a.symbol} approval`,
        `Spender: ${a.spenderLabel || a.spender}\nCurrent allowance: ${a.display}`,
        [{ label: 'Revoke completely', value: 'revoke', style: 'danger' },
         { label: 'Set a limit instead', value: 'limit', style: 'primary' }]);
      if (!act) return;
      if (act === 'limit') {
        const amt = await promptDialog('Set allowance limit', {
          label: `Maximum ${a.symbol} this spender may use`, placeholder: '100', okLabel: 'Set limit'
        });
        if (!amt || !(Number(amt) >= 0)) return;
        try {
          const raw = (BigInt(Math.round(Number(amt) * 10 ** Math.min(a.decimals || 18, 15))) * 10n ** BigInt(Math.max((a.decimals || 18) - 15, 0))).toString();
          const h = await call('setAllowance', { from: S.selectedAddress, token: a.token, spender: a.spender, amount: raw });
          toast('Limit set: ' + short(h, 5));
          openApprovals();
        } catch (e) { toast(e.message.slice(0, 110)); }
        return;
      }
      if (!(await confirmDialog('Revoke approval', `${a.symbol}\nSpender: ${a.spenderLabel || a.spender}\nCurrent allowance: ${a.display}\n\nThis costs one transaction.`, { okLabel: 'Revoke', danger: true }))) return;
      try {
        const h = await call('revokeApproval', { from: S.selectedAddress, token: a.token, spender: a.spender, kind: a.kind });
        toast('Revoke sent: ' + short(h, 5));
        approvalList = approvalList.filter((x) => x !== a);
        renderApprovals();
      } catch (e) { toast(e.message.slice(0, 110)); }
    };
    el.appendChild(d);
  });
}

$('#apvRescan').onclick = openApprovals;

/* ---------------- bottom navigation ---------------- */

$$('.navitem').forEach((n) => (n.onclick = () => openTab(n.dataset.nav)));

async function openTab(id) {
  navStack.length = 0;
  if (id === 'assets') { view('assets'); renderTokens(); renderAllocation(); return; }
  if (id === 'nfts') { view('nfts'); renderNfts(); return; }
  if (id === 'swap') return openSwap();
  if (id === 'history') { view('history'); loadActivity(); return; }
  if (id === 'settings') return openScreen('settings');
  view('home');
}

$('#seeAllAssets').onclick = () => openTab('assets');
$('#seeAllActivity').onclick = () => openTab('history');

$('#acctAddr').onclick = (e) => { e.stopPropagation(); if (S.selectedAddress) copy(S.selectedAddress); };

$('#btnHideBal').innerHTML = icon(balHidden ? 'eye-off' : 'eye', { size: 14 });
$('#btnHideBal').onclick = () => {
  balHidden = !balHidden;
  localStorage.setItem('fw_balHidden', balHidden ? '1' : '0');
  $('#btnHideBal').innerHTML = icon(balHidden ? 'eye-off' : 'eye', { size: 14 });
  renderBalDisplay();
};
$('#btnRefreshBal').onclick = async () => {
  const btn = $('#btnRefreshBal');
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  await loadOverview();
  btn.classList.remove('spinning');
};
$('#balRetry').onclick = () => loadOverview();

/* ---------------- portfolio timeframe ---------------- */

let sparkDays = 7;
$$('#rangeRow .range').forEach((r) => (r.onclick = () => {
  $$('#rangeRow .range').forEach((x) => x.classList.toggle('on', x === r));
  sparkDays = Number(r.dataset.days);
  loadSparkline();
}));

let tdSparkDays = 7;
$$('#tdRangeRow .range').forEach((r) => (r.onclick = () => {
  $$('#tdRangeRow .range').forEach((x) => x.classList.toggle('on', x === r));
  tdSparkDays = Number(r.dataset.days);
  loadTokenSparkline();
}));

/* ---------------- asset search ---------------- */

let assetQuery = '';
$('#assetSearch').oninput = (e) => { assetQuery = e.target.value.trim().toLowerCase(); renderTokens(); };

/* ---------------- dApp hub ---------------- */
/* browser.html has its own dApp-picker hub (shortcuts bar + grid, same shared icon-tile styling
   now) - popup.html used to duplicate that with a second, separate hub screen here that every
   entry point except the bottom-nav Discover tab already skipped. Removed rather than kept in
   sync forever: openDapp() below goes straight to the one real dApp browser. */

function openDapp(url) {
  // Telegram: a specific site (explorer link, dApp) opens in Telegram's own browser - the Mini
  // App can't inject a provider into it, dApps connect over WalletConnect instead. Discover
  // (no url) still goes to the in-app dApp launcher page.
  if (TG && url) return TG.openExternal(url);
  // theme is passed through the URL (not just left to browser.html's own status() call once it
  // loads) so that page can paint the right theme immediately on first render instead of flashing
  // its hardcoded dark fallback first - see the inline script at the top of browser.html.
  const params = new URLSearchParams();
  if (url) params.set('url', url);
  params.set('theme', S?.settings?.theme === 'light' ? 'light' : 'dark');
  const query = '?' + params.toString();
  // manifest.json registers this same popup.html as both the toolbar action's popup AND the side
  // panel's page - they need different navigation here. The action popup is a transient overlay
  // that Chrome can close the instant focus moves (a dApp's own modal, a WalletConnect prompt,
  // even just clicking an address bar), so it gets a real separate tab, same as before. The side
  // panel is a persistent, docked panel that doesn't auto-close on blur - Discover can safely
  // navigate it in place, landing inside that same panel instead of popping open a whole new tab.
  const isActionPopup = typeof chrome !== 'undefined' && chrome.extension?.getViews && chrome.extension.getViews({ type: 'popup' }).includes(window);
  if (isActionPopup) {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/browser.html' + query) });
  } else {
    window.location.href = 'browser.html' + query;
  }
}

function openExplorerUrl(url) {
  if (!url) return toast('This network has no explorer configured');
  openDapp(url);
}

/* ---------------- receive extras ---------------- */

$('#rcvCopy').onclick = () => copy(S.selectedAddress);
$('#rcvShare').onclick = async () => {
  const text = S.selectedAddress;
  // The Android WebView doesn't implement navigator.share at all, so this always fell straight
  // through to the copy fallback below - tapping "Share" silently did the same thing as tapping
  // "Copy". Use Capacitor's native Share plugin for the real OS share sheet on mobile; only fall
  // back to copying when there's truly no share mechanism available (e.g. the desktop extension
  // popup, which also lacks navigator.share). Either way, if a share sheet DID come up and the
  // user just canceled it, do nothing - don't surprise them with an unrelated "copied" toast.
  if (CapShare) { try { await CapShare.share({ title: 'My wallet address', text }); } catch {} return; }
  if (navigator.share) { try { await navigator.share({ title: 'My wallet address', text }); } catch {} return; }
  copy(text);
  toast('Address copied — share it from anywhere');
};
$('#rcvExplorer').onclick = () => openExplorerUrl(S.network?.explorer ? `${S.network.explorer.replace(/\/$/, '')}/address/${S.selectedAddress}` : null);

/* ---------------- swap flip ---------------- */

$('#swapFlip').onclick = () => {
  const a = swapFromValue, b = swapToValue;
  swapFromValue = b;
  swapToValue = a;
  updateSwapAssets();
  resetSwapQuote();
};

/* ---------------- walletconnect ---------------- */

async function openWalletConnect() {
  view('walletconnect');
  $('#wcUri').value = '';
  $('#wcScan').classList.toggle('hidden', !BarcodeScanner);
  renderWcSessions();
}

async function renderWcSessions() {
  const el = $('#wcList');
  el.innerHTML = '';
  let sessions = [];
  try {
    sessions = (await call('wcSessions', {})) || [];
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (!sessions.length) {
    el.innerHTML = '<div class="empty">No active sessions</div>';
    return;
  }
  sessions.forEach((sn) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title">${esc(sn.name || sn.peer?.name || sn.peer?.metadata?.name || 'dApp')}</div>
      <div class="sub" style="font-family:inherit">${esc(sn.url || sn.peer?.url || sn.peer?.metadata?.url || '')}</div>`;
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = 'disconnect';
    d.append(meta, b);
    d.onclick = async () => {
      if (!(await confirmDialog('Disconnect session', 'The dApp will lose access to your address immediately.', { okLabel: 'Disconnect', danger: true }))) return;
      try {
        await call('wcDisconnect', { topic: sn.topic });
        toast('Disconnected');
        renderWcSessions();
      } catch (e) { toast(e.message.slice(0, 110)); }
    };
    el.appendChild(d);
  });
}

$('#wcScan').onclick = async () => {
  const raw = await scanQr();
  if (!raw) return;
  if (!raw.startsWith('wc:')) return toast('That QR code is not a WalletConnect pairing code');
  $('#wcUri').value = raw;
  $('#wcConnect').click();
};

$('#wcPaste').onclick = async () => {
  try {
    $('#wcUri').value = await navigator.clipboard.readText();
  } catch {
    toast('Clipboard unavailable - paste manually');
  }
};

$('#wcConnect').onclick = async () => {
  const uri = $('#wcUri').value.trim();
  if (!uri.startsWith('wc:')) return toast('Paste a URI that starts with wc:');
  $('#wcConnect').disabled = true;
  $('#wcStatusBox').textContent = 'Pairing...';
  try {
    await call('wcPair', { uri });
    $('#wcUri').value = '';
    $('#wcStatusBox').textContent = 'Paired - approve the session request from the dApp.';
    setTimeout(renderWcSessions, 1500);
  } catch (e) {
    $('#wcStatusBox').textContent = 'Pairing failed: ' + e.message.slice(0, 140);
  } finally {
    $('#wcConnect').disabled = false;
  }
};

/* ---------------- contacts / sites ---------------- */

function renderContacts() {
  const el = $('#contactList');
  el.innerHTML = (S.contacts || []).length ? '' : '<div class="empty">No contacts</div>';
  (S.contacts || []).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.innerHTML = `<img class="ident" width="32" height="32" src="${identicon(c.address, 32)}" /><div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${short(c.address, 6)}</div></div><span class="badge">remove</span>`;
    d.onclick = async () => {
      if (await confirmDialog('Remove contact', `${c.name} will be removed from your address book.`, { okLabel: 'Remove', danger: true })) {
        await call('removeContact', { address: c.address }); S = await call('status'); renderContacts();
      }
    };
    el.appendChild(d);
  });
}
$('#cSave').onclick = async () => {
  let addr = $('#cAddr').value.trim();
  if (/\.[a-z]{2,}$/i.test(addr)) addr = (await call('resolveName', { name: addr })) || addr;
  try { await call('addContact', { name: $('#cName').value.trim() || 'Contact', address: addr }); S = await call('status'); $('#cName').value = $('#cAddr').value = ''; renderContacts(); }
  catch (e) { toast(e.message); }
};

function renderSites() {
  const el = $('#siteList');
  const origins = Object.keys(S.permissions || {});
  el.innerHTML = origins.length ? '' : '<div class="empty">No sites connected</div>';
  origins.forEach((o) => {
    const p = S.permissions[o];
    const d = document.createElement('div');
    d.className = 'rowitem';
    const meta = document.createElement('div');
    meta.className = 'grow';
    meta.innerHTML = `<div class="title" style="word-break:break-all">${esc(o)}</div>
      <div class="sub">${p.addresses.map((a) => short(a, 4)).join(', ')}</div>`;
    const editBtn = document.createElement('button');
    editBtn.className = 'iconbtn';
    editBtn.textContent = '⋯';
    editBtn.onclick = (e) => { e.stopPropagation(); manageSite(o, p); };
    d.append(meta, editBtn);
    meta.onclick = () => manageSite(o, p);
    el.appendChild(d);
  });
}

async function manageSite(origin, perm) {
  const choice = await chooseDialog(origin, `Currently shared with ${perm.addresses.length} account(s).`, [
    { label: 'Change accounts', value: 'edit', style: 'primary' },
    { label: 'Disconnect', value: 'off', style: 'danger' }
  ]);
  if (!choice) return;

  if (choice === 'off') {
    await call('revokeOrigin', { origin });
    S = await call('status');
    renderSites();
    return toast('Disconnected');
  }

  // account picker sheet
  const picked = new Set(perm.addresses.map((a) => a.toLowerCase()));
  const el = $('#sitePickList');
  const draw = () => {
    el.innerHTML = '';
    S.accounts.filter((a) => !a.readOnly).forEach((a) => {
      const on = picked.has(a.address.toLowerCase());
      const d = document.createElement('div');
      d.className = 'rowitem';
      d.innerHTML = `<img class="ident" width="32" height="32" src="${identicon(a.address, 32)}" />
        <div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${short(a.address, 5)}</div></div>
        <span class="badge ${on ? 'ok' : ''}">${on ? 'shared' : 'share'}</span>`;
      d.onclick = () => {
        on ? picked.delete(a.address.toLowerCase()) : picked.add(a.address.toLowerCase());
        draw();
      };
      el.appendChild(d);
    });
  };
  draw();
  $('#sitePickTitle').textContent = origin;
  openSheet('#sheetSitePerms');
  $('#sitePickSave').onclick = async () => {
    const addresses = S.accounts.filter((a) => picked.has(a.address.toLowerCase())).map((a) => a.address);
    if (!addresses.length) return toast('Select at least one account, or disconnect the site');
    await call('updateSitePermissions', { origin, addresses });
    S = await call('status');
    closeSheets();
    renderSites();
    toast('Permissions updated');
  };
}

/* ---------------- settings / security ---------------- */

function fillSettings() {
  const s = S.settings;
  // Only Dark/Light exist as <option>s now - a leftover 'binance'/'system' value from before that
  // change would otherwise leave the <select> showing blank instead of a real selection.
  $('#setTheme').value = s.theme === 'light' ? 'light' : 'dark';
  $('#setAutoLock').value = s.autoLockMinutes; $('#setHomepage').value = s.homepage;
  $('#setCurrency').value = s.currency; $('#setFiat').checked = !!s.showFiat; $('#setTestnets').checked = !!s.showTestNetworks;
  $('#setChart').checked = s.showChart !== false; $('#setLogos').checked = s.showTokenLogos !== false;
  $('#setNotif').checked = !!s.notifications; $('#setPhish').checked = !!s.phishingProtection; $('#setNonce').checked = !!s.useCustomNonce;
  $('#setWcProjectId').value = s.wcProjectId || '';
  $('#setSwapProvider').value = s.swapProvider; $('#setSwapKey').value = s.swapApiKey || '';
  $('#setSlippage').value = (s.slippageBps / 100).toString(); $('#setDeadline').value = s.deadlineMinutes;
  $('#setBiometricRow').classList.toggle('hidden', !NativeBiometric);
  $('#setBiometric').checked = !!s.biometricEnabled;
}
$('#setBiometric').addEventListener('change', async (e) => {
  const turnOn = e.target.checked;
  if (!NativeBiometric) { e.target.checked = false; return; }
  if (turnOn) {
    try {
      const avail = await NativeBiometric.isAvailable();
      if (!avail.isAvailable) { toast('No biometric method available on this device'); e.target.checked = false; return; }
      const pw = await promptDialog('Confirm password', { label: 'Password', type: 'password', body: 'Enter your wallet password once to enable biometric unlock.', okLabel: 'Continue' });
      if (!pw) { e.target.checked = false; return; }
      const ok = await call('verifyPassword', { password: pw });
      if (!ok) { toast('Wrong password'); e.target.checked = false; return; }
      await NativeBiometric.verifyIdentity({ reason: 'Confirm to enable biometric unlock', title: 'Enable biometric unlock' });
      await NativeBiometric.setCredentials({ username: 'wallet', password: pw, server: BIOMETRIC_SERVER });
      await call('updateSettings', { settings: { biometricEnabled: true } });
      S.settings.biometricEnabled = true;
      toast('Biometric unlock enabled');
    } catch (err) {
      e.target.checked = false;
      toast('Could not enable biometric unlock');
    }
  } else {
    try { await NativeBiometric.deleteCredentials({ server: BIOMETRIC_SERVER }); } catch {}
    await call('updateSettings', { settings: { biometricEnabled: false } });
    S.settings.biometricEnabled = false;
    toast('Biometric unlock disabled');
  }
});
$('#saveSettings').onclick = async () => {
  const newCurrency = $('#setCurrency').value.trim() || 'usd';
  // Every other saved setting (theme, notifications, etc.) applies instantly with nothing async
  // left to wait on. Currency is different - the new fiat total/prices have to be re-fetched from
  // the background before they're correct, and without this the old amount just sat on screen
  // (or briefly showed the native coin's symbol next to it, see refresh() above) until that fetch
  // happened to finish, with no indication anything was even loading. Re-arming the skeleton
  // loaders (same ones loadOverview() already shows on first load) for just this one refresh
  // gives the currency switch an honest "loading" moment instead of an unexplained stale flash.
  if (newCurrency !== S.settings.currency || $('#setFiat').checked !== S.settings.showFiat) overviewLoaded = false;
  await call('updateSettings', {
    settings: {
      theme: $('#setTheme').value, autoLockMinutes: Number($('#setAutoLock').value || 0), homepage: $('#setHomepage').value.trim(),
      currency: newCurrency, showFiat: $('#setFiat').checked, showTestNetworks: $('#setTestnets').checked,
      showChart: $('#setChart').checked, showTokenLogos: $('#setLogos').checked,
      notifications: $('#setNotif').checked, phishingProtection: $('#setPhish').checked, useCustomNonce: $('#setNonce').checked,
      wcProjectId: $('#setWcProjectId').value.trim(),
      swapProvider: $('#setSwapProvider').value, swapApiKey: $('#setSwapKey').value.trim(),
      slippageBps: Math.round(Number($('#setSlippage').value || 0.5) * 100), deadlineMinutes: Number($('#setDeadline').value || 20)
    }
  });
  toast('Saved'); await refresh();
};
// Both buttons stay disabled (set in the HTML) until a password is typed - matches the
// unlock/change-password screens' "Continue only turns on once the real condition is met" pattern.
$('#revealPw').addEventListener('input', (e) => {
  const has = !!e.target.value;
  $('#btnRevealSeed').disabled = !has;
  $('#btnRevealPk').disabled = !has;
  $('#revealPwError').textContent = '';
});
$('#btnRevealSeed').onclick = async () => {
  try {
    $('#revealBox').textContent = await call('revealMnemonic', { password: $('#revealPw').value });
    $('#revealBox').classList.remove('hidden');
    $('#revealPwError').textContent = '';
    await call('markBackupDone');
  } catch (e) { $('#revealPwError').textContent = e.message === 'Wrong password' ? 'Wrong password. Please try again.' : e.message; }
};
$('#btnRevealPk').onclick = async () => {
  try {
    $('#revealBox').textContent = await call('revealPrivateKey', { password: $('#revealPw').value, address: S.selectedAddress });
    $('#revealBox').classList.remove('hidden');
    $('#revealPwError').textContent = '';
  } catch (e) { $('#revealPwError').textContent = e.message === 'Wrong password' ? 'Wrong password. Please try again.' : e.message; }
};
function setChangePwMsg(text, color) {
  const el = $('#changePwMsg');
  el.textContent = text;
  el.style.color = color ? `var(--${color})` : '';
}
$('#oldPw').addEventListener('input', () => setChangePwMsg(''));
$('#newPw').addEventListener('input', () => setChangePwMsg(''));
$('#btnChangePw').onclick = async () => {
  const oldPassword = $('#oldPw').value, newPassword = $('#newPw').value;
  if (!oldPassword) return setChangePwMsg('Enter your current password', 'red');
  if (newPassword.length < 8) return setChangePwMsg('New password must be at least 8 characters', 'red');
  if (!(await confirmDialog('Update password', 'You will need this new password to unlock your wallet going forward.', { okLabel: 'Update' }))) return;
  try {
    await call('changePassword', { oldPassword, newPassword });
    // Biometric unlock stores the plaintext password in the OS secure keystore at enable time
    // (see #setBiometric above) and retrieves it later without re-asking - if it's left pointing
    // at the old password, biometry keeps "succeeding" while the unlock it triggers silently
    // fails every time. Keep it in sync here rather than forcing a disable/re-enable round trip.
    if (NativeBiometric && S.settings.biometricEnabled) {
      try { await NativeBiometric.setCredentials({ username: 'wallet', password: newPassword, server: BIOMETRIC_SERVER }); } catch {}
    }
    setChangePwMsg('Password updated successfully', 'green');
    $('#oldPw').value = $('#newPw').value = '';
  } catch (e) {
    setChangePwMsg(e.message === 'Wrong password' ? 'Current password is incorrect.' : e.message, 'red');
  }
};
$('#btnExportVault').onclick = async () => {
  let v;
  try { v = await call('exportVault'); } catch (e) { toast(e.message); return; }
  const json = JSON.stringify(v, null, 2);
  if (TG) return TG.saveBackup('futurewallet-vault.json', json);
  if (CapShare) {
    // The Android WebView has no browser-style download manager, so the <a download> blob trick
    // below silently does nothing there - route through the native share sheet instead (same
    // plugin already used for sharing the wallet address). The user picks where it lands (Drive,
    // email, a notes app, ...); a cancelled sheet isn't an error, so that's swallowed quietly.
    try { await CapShare.share({ title: 'FutureWallet vault backup', text: json, dialogTitle: 'Save vault backup' }); } catch {}
    return;
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'futurewallet-vault.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Vault exported');
};
$('#btnReset').onclick = async () => {
  if (!(await confirmDialog('Reset wallet', 'Every account, token, contact and setting on this device will be erased. Only your recovery phrase can restore your accounts.', { okLabel: 'Erase everything', danger: true }))) return;
  if (NativeBiometric) { try { await NativeBiometric.deleteCredentials({ server: BIOMETRIC_SERVER }); } catch {} }
  await call('resetWallet'); location.reload();
};

/* ---------------- keyboard ---------------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = $$('.sheet').some((x) => !x.classList.contains('hidden'));
    if (open) return closeSheets();
    const cur = $$('[data-view]').find((v) => !v.classList.contains('hidden'));
    const back = cur?.querySelector('[data-back]');
    if (back) back.click();
    else if (navStack.length) goBack();
  }
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    const cur = $$('[data-view]').find((v) => !v.classList.contains('hidden'));
    const primary = cur?.querySelector('button.primary');
    if (primary && !primary.disabled) primary.click();
  }
});

/* ---------------- go ---------------- */
refresh();
setInterval(() => { if (S?.unlocked && !$('[data-view="home"]').classList.contains('hidden')) loadOverview(); }, 15000);
