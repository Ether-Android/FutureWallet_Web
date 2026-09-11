import { call, $, $$, short, toast, esc, promptDialog } from './api.js';
import { icon } from './kit.js';

/* Fills every static `data-icon="name"` placeholder with its SVG - same pattern as popup.js.
   Per-dApp emoji (🟢 🦄 🥞 …) stay as-is; this only covers the chrome/toolbar icons. */
$$('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 16 });
});

const frame = $('#frame');
let stack = [];
let idx = -1;
let S = null;
let inpageScriptText = '';

/* ------------------------------------------------------------------ *
 * Native dApp browser (Capacitor/Android only)
 *
 * A dApp loaded in this <iframe> is a different origin than this page,
 * so this page's JS can never reach into it to inject window.ethereum -
 * that's the browser's same-origin policy, not something a postMessage
 * workaround can get around. On desktop this doesn't matter: the
 * extension's manifest content-script injects into every frame
 * (including this iframe) at the browser level, bypassing this
 * entirely. There is no such mechanism in a WebView, so on Capacitor
 * dApps are instead handed to a native WebView (DappBrowserPlugin)
 * positioned over #frameWrap, where document-start injection isn't
 * crossing an origin boundary.
 * ------------------------------------------------------------------ */
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Telegram Mini App (tg/frame-bridge.js): this page is a dApp *launcher* - sites open in
// Telegram's browser and connect to the wallet over WalletConnect (no provider injection
// possible into another origin from a Telegram WebView).
const TG = window.FWTG || null;
const DappBrowser = NATIVE ? window.Capacitor.Plugins.DappBrowser : null;
let nativeOpen = false;
let nativeCurrentUrl = '';

function frameWrapBoundsPx() {
  const r = $('#frameWrap').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr)
  };
}

async function openNative(u) {
  nativeOpen = true;
  try {
    await DappBrowser.open({ url: u, inpageScript: inpageScriptText, ...frameWrapBoundsPx() });
  } catch (e) {
    nativeOpen = false;
    toast('Could not open dApp: ' + (e?.message || e));
  }
}

function closeNative() {
  if (!DappBrowser || !nativeOpen) return;
  nativeOpen = false;
  nativeCurrentUrl = '';
  DappBrowser.close().catch(() => {});
}

if (DappBrowser) {
  DappBrowser.addListener('navigate', ({ url }) => {
    if (!url) return;
    nativeCurrentUrl = url;
    $('#url').value = url;
  });
  DappBrowser.addListener('wcUri', ({ uri }) => {
    if (!uri) return;
    call('wcPair', { uri })
      .then(() => toast('WalletConnect pairing started...'))
      .catch((err) => toast('WalletConnect error: ' + (err.message || err)));
  });
  DappBrowser.addListener('providerRequest', async (data) => {
    try {
      const result = await call('provider', { origin: data.origin, request: data.request });
      DappBrowser.resolveRequest({ id: data.id, ok: true, result });
    } catch (err) {
      DappBrowser.resolveRequest({ id: data.id, ok: false, error: { message: err?.message || 'Request failed', code: err?.code || 4001 } });
    }
  });
  window.addEventListener('resize', () => {
    if (nativeOpen) DappBrowser.updateBounds(frameWrapBoundsPx()).catch(() => {});
  });
}

window.addEventListener('fw-hardware-back', (e) => {
  e.preventDefault();
  if (NATIVE && nativeOpen) {
    DappBrowser.goBack();
  } else if (!$('#dappHub').classList.contains('hidden')) {
    goToWallet();
  } else {
    navigate('home');
  }
});

const DAPPS = [
  { name: 'EravittAI', url: 'https://eravittai.com/login', icon: '🟢', desc: 'Earn Monthly Token Rewards & Web3 BSC Platform' },
  { name: 'Uniswap', url: 'https://app.uniswap.org/', icon: '🦄', desc: 'Swap tokens & trade on Decentralized Exchange' },
  { name: 'PancakeSwap', url: 'https://pancakeswap.finance/', icon: '🥞', desc: 'Trade, earn & yield farm on BNB & Ethereum' },
  { name: 'OpenSea', url: 'https://opensea.io/', icon: '⛵', desc: 'Discover, collect, and sell NFTs' },
  { name: 'Aave', url: 'https://app.aave.com/', icon: '👻', desc: 'Earn interest, borrow & lend crypto assets' },
  { name: '1inch', url: 'https://app.1inch.io/', icon: '🦄', desc: 'DEX Aggregator for best crypto swap rates' },
  { name: 'Etherscan', url: 'https://etherscan.io/', icon: '🔍', desc: 'Ethereum Blockchain Explorer & Search' }
];

function normalize(input) {
  const v = (input || '').trim();
  if (!v) return null;
  if (v.startsWith('wc:')) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v)) return 'https://' + v;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
}

function navigate(url, push = true) {
  if (!url || url === 'home' || url === 'about:blank') {
    closeNative();
    $('#dappHub').classList.remove('hidden');
    frame.classList.add('hidden');
    $('#overlay').classList.add('hidden');
    $('#url').value = '';
    return;
  }
  const u = normalize(url);
  if (!u) return;
  if (u.startsWith('wc:')) {
    call('wcPair', { uri: u })
      .then(() => toast('WalletConnect pairing started...'))
      .catch((err) => toast('WalletConnect error: ' + (err.message || err)));
    $('#url').value = '';
    return;
  }

  if (push) {
    stack = stack.slice(0, idx + 1);
    stack.push(u);
    idx = stack.length - 1;
  }
  $('#url').value = u;
  $('#dappHub').classList.add('hidden');
  $('#overlay').classList.add('hidden');

  if (TG) {
    $('#url').value = '';
    $('#dappHub').classList.remove('hidden');
    TG.openDapp(u);
    return;
  }

  if (NATIVE) {
    frame.classList.add('hidden');
    openNative(u);
    return;
  }

  frame.classList.remove('hidden');
  frame.removeAttribute('srcdoc');
  frame.src = u;
  clearTimeout(window.__ovTimer);
  window.__ovTimer = setTimeout(checkBlocked, 4500);
}

function checkBlocked() {
  try {
    const doc = frame.contentDocument;
    if (doc && doc.body && doc.body.childElementCount === 0) {
      $('#overlay').classList.remove('hidden');
    }
  } catch {
    /* Cross-origin site loaded successfully */
  }
}

function renderDappHub() {
  const grid = $('#dappGrid');
  if (!grid) return;
  
  // Bind click handlers to existing pre-rendered HTML cards
  const existingCards = $$('.dapp-card');
  if (existingCards.length > 0) {
    existingCards.forEach((card) => {
      const u = card.dataset.url;
      if (u) card.onclick = () => navigate(u);
    });
    return;
  }

  // Fallback: render cards dynamically if grid is empty
  grid.innerHTML = '';
  DAPPS.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'dapp-card';
    card.dataset.url = d.url;
    card.innerHTML = `
      <div class="dapp-card-head">
        <div class="dapp-icon">${d.icon}</div>
        <div class="dapp-name">${d.name}</div>
      </div>
      <div class="dapp-desc">${d.desc}</div>
    `;
    card.onclick = () => navigate(d.url);
    grid.appendChild(card);
  });
}

function renderShortcuts() {
  const el = $('#shortcuts');
  if (!el) return;
  const buttons = el.querySelectorAll('button');
  if (buttons.length > 0) {
    buttons.forEach((b) => {
      const u = b.dataset.url;
      if (u) b.onclick = () => navigate(u);
    });
    return;
  }
  DAPPS.forEach((s) => {
    const b = document.createElement('button');
    b.dataset.url = s.url;
    b.textContent = `${s.icon} ${s.name}`;
    b.onclick = () => navigate(s.url);
    el.appendChild(b);
  });
}

// Inpage Provider Injection
function injectProvider() {
  if (!inpageScriptText) return;
  try {
    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (doc) {
      const s = doc.createElement('script');
      s.textContent = inpageScriptText;
      (doc.head || doc.documentElement).prepend(s);
    }
  } catch (e) {
    /* Cross-origin SOP restriction - postMessage bridge handles it */
  }
}

frame.addEventListener('load', injectProvider);

// Web3 PostMessage Bridge (EIP-1193 & EIP-6963 dApp requests)
window.addEventListener('message', async (evt) => {
  const msg = evt.data;
  if (!msg || msg.target !== 'fw-content' || msg.kind !== 'request') return;

  const reqId = msg.id;
  const request = msg.request;

  try {
    const origin = evt.origin || (frame.src && frame.src.startsWith('http') ? new URL(frame.src).origin : location.origin);
    const res = await call('provider', { origin, request });
    const targetSource = evt.source || frame.contentWindow;
    if (targetSource && typeof targetSource.postMessage === 'function') {
      targetSource.postMessage({ target: 'fw-inpage', kind: 'response', id: reqId, ok: true, result: res }, '*');
    }
  } catch (err) {
    const targetSource = evt.source || frame.contentWindow;
    if (targetSource && typeof targetSource.postMessage === 'function') {
      targetSource.postMessage(
        {
          target: 'fw-inpage',
          kind: 'response',
          id: reqId,
          ok: false,
          error: { message: err?.message || 'User rejected request', code: err?.code || 4001 }
        },
        '*'
      );
    }
  }
});

// Input & Nav Action Handlers
$('#url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(e.target.value);
});
$('#back').onclick = () => {
  if (NATIVE && nativeOpen) {
    DappBrowser.goBack();
    return;
  }
  if (idx > 0) {
    idx--;
    navigate(stack[idx], false);
  } else {
    navigate('home');
  }
};
$('#fwd').onclick = () => {
  if (NATIVE && nativeOpen) {
    DappBrowser.goForward();
    return;
  }
  if (idx < stack.length - 1) {
    idx++;
    navigate(stack[idx], false);
  }
};
$('#reload').onclick = () => {
  if (NATIVE && nativeOpen) {
    DappBrowser.reload();
    return;
  }
  if (frame.classList.contains('hidden')) {
    renderDappHub();
  } else {
    try {
      frame.contentWindow?.location?.reload?.();
    } catch {
      frame.src = frame.src;
    }
  }
};

const goToWallet = () => {
  closeNative();
  window.location.href = 'popup.html';
};

$('#btnBackToWallet').onclick = goToWallet;
const toWalletBtn = $('#toWallet');
if (toWalletBtn) toWalletBtn.onclick = goToWallet;

$('#home').onclick = () => {
  if (!$('#dappHub').classList.contains('hidden')) {
    goToWallet();
  } else {
    navigate('home');
  }
};

$('#ovOpen').onclick = () => {
  const u = $('#url').value;
  if (u) window.open(u, '_system');
};

async function refreshStatus() {
  try {
    S = await call('status');
    // browser.html hardcodes data-theme="binance" in markup as a pre-JS fallback and this page
    // never updated it afterward, so the dApp browser hub always looked dark/gold regardless of
    // what the user picked in Settings - the exact bug already fixed for the main app in
    // popup.js's applyTheme(). Mirrored here since this is a separate page with its own <html>.
    const resolvedTheme = S?.settings?.theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-bs-theme', resolvedTheme);
    if (S && S.network) {
      $('#netName').textContent = S.network.symbol || S.network.name || 'ETH';
      if (S.network.color) $('#netDot').style.background = S.network.color;
      const a = S.accounts?.find((x) => x.address === S.selectedAddress);
      $('#acctName').textContent = a ? short(a.address, 4) : 'Account';
    }
  } catch (e) {}
}

$('#acctPill').onclick = goToWallet;

$('#netPill').onclick = async () => {
  try {
    S = await call('status');
    if (!S || !S.networks) return;
    const list = $('#netList');
    list.innerHTML = '';
    S.networks.forEach((n) => {
      const isCurrent = n.key === S.currentNetworkKey;
      const item = document.createElement('div');
      // Was hardcoded hex colors throughout (background/border/text) - always looked dark
      // regardless of theme, since none of it referenced the app's CSS variables. Themed to match
      // the rest of the sheet, which already reads var(--bg-alt)/var(--text)/etc correctly.
      item.style.cssText = `
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;border-radius:12px;background:${isCurrent ? 'var(--accent-bg)' : 'var(--bg-alt)'};
        border:1px solid ${isCurrent ? 'var(--accent)' : 'var(--line-soft)'};cursor:pointer;
      `;
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:10px;height:10px;border-radius:50%;background:${n.color || 'var(--accent)'};"></div>
          <div>
            <div style="font-weight:700;font-size:14px;color:var(--text);">${esc(n.name)}</div>
            <div style="font-size:11px;color:var(--muted);">Chain ID: ${n.chainId} (${esc(n.symbol)})</div>
          </div>
        </div>
        ${isCurrent ? '<span style="color:var(--green);font-weight:700;font-size:12px;">✓ Active</span>' : ''}
      `;
      item.onclick = async () => {
        try {
          await call('selectNetwork', { key: n.key });
          toast(`Switched to ${n.name}`);
          $('#sheetNetwork').classList.add('hidden');
          await refreshStatus();
        } catch (err) {
          toast(err?.message || 'Failed to switch network');
        }
      };
      list.appendChild(item);
    });
    $('#sheetNetwork').classList.remove('hidden');
  } catch (e) {
    toast('Network list error');
  }
};

$('#closeNetSheet').onclick = () => {
  $('#sheetNetwork').classList.add('hidden');
};

$('#btnInjectedConnect').onclick = async () => {
  try {
    let currentOrigin = location.origin;
    if (NATIVE && nativeCurrentUrl) currentOrigin = new URL(nativeCurrentUrl).origin;
    else if (frame.src && frame.src.startsWith('http')) currentOrigin = new URL(frame.src).origin;
    const res = await call('provider', { origin: currentOrigin, request: { method: 'eth_requestAccounts' } });
    const addr = Array.isArray(res) ? res[0] : res;
    if (addr) {
      toast(`Connected: ${short(addr, 5)}`);
      $('#btnInjectedConnect').textContent = `✓ ${short(addr, 4)}`;
      $('#btnInjectedConnect').style.background = '#0ecb81';
      $('#btnInjectedConnect').style.color = '#ffffff';
    }
  } catch (err) {
    toast(err?.message || 'Connection cancelled');
  }
};

const btnPairWc = $('#btnPairWc');
if (btnPairWc) {
  btnPairWc.onclick = async () => {
    try {
      const clipText = await navigator.clipboard?.readText?.().catch(() => '');
      const uri = await promptDialog('Pair WalletConnect', { label: 'WalletConnect URI', placeholder: 'wc:...', value: clipText && clipText.startsWith('wc:') ? clipText : '', okLabel: 'Pair' });
      if (uri && uri.trim()) navigate(uri.trim());
    } catch (e) {
      toast('Invalid WC URI');
    }
  };
}

function setupTelegramLauncher() {
  if (TG.dapps && TG.dapps.length) DAPPS.splice(0, DAPPS.length, ...TG.dapps);
  $('#dappGrid').innerHTML = '';
  $$('#shortcuts button[data-url]').forEach((b) => b.remove());
  DAPPS.forEach((d) => {
    const b = document.createElement('button');
    b.dataset.url = d.url;
    b.textContent = `${d.icon || '🌐'} ${d.name}`;
    b.onclick = () => navigate(d.url);
    $('#shortcuts').appendChild(b);
  });
  const hint = document.createElement('div');
  hint.className = 'tg-wc-hint';
  hint.innerHTML = '<b>How to connect:</b> open a dApp, tap <b>Connect Wallet → WalletConnect</b>, then scan the QR or paste the <code>wc:</code> link in FutureWallet.';
  $('#dappHub').prepend(hint);
  $('#url').placeholder = 'Enter dApp URL or paste wc: link…';
}

async function boot() {
  if (TG) setupTelegramLauncher();
  renderDappHub();
  renderShortcuts();

  // Must be loaded before any navigate() that could open a dApp (below), otherwise the very
  // first dApp opened from a ?url= deep link would get an empty inpage script injected.
  if (!TG) try {
    const inpageUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('dist/inpage.js') : '../dist/inpage.js';
    inpageScriptText = await fetch(inpageUrl).then((r) => r.text()).catch(() => '');
  } catch (e) {}

  const urlParams = new URLSearchParams(window.location.search);
  const initialUrl = urlParams.get('url');
  if (initialUrl) {
    navigate(initialUrl);
  } else {
    navigate('home');
  }

  try {
    await refreshStatus();
  } catch (e) {}

  setInterval(() => refreshStatus().catch(() => {}), 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
