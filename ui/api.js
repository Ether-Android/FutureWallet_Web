function getChromeObj() {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) return chrome;
  if (typeof window !== 'undefined') {
    try { if (window.chrome?.runtime?.sendMessage) return window.chrome; } catch { }
    try { if (window.parent && window.parent.chrome?.runtime?.sendMessage) return window.parent.chrome; } catch { }
    try { if (window.top && window.top.chrome?.runtime?.sendMessage) return window.top.chrome; } catch { }
    try { if (window.opener && window.opener.chrome?.runtime?.sendMessage) return window.opener.chrome; } catch { }
  }
  if (typeof globalThis !== 'undefined' && globalThis.chrome?.runtime?.sendMessage) return globalThis.chrome;
  return null;
}

export async function call(method, params = {}) {
  let retries = 0;
  let ch = getChromeObj();
  while (!ch && retries < 100) {
    await new Promise((r) => setTimeout(r, 50));
    ch = getChromeObj();
    retries++;
  }
  if (!ch) {
    console.warn('[FutureWallet API] Chrome runtime bridge not ready for method:', method);
    return null;
  }
  let res;
  try {
    res = await ch.runtime.sendMessage({ target: 'fw-background', kind: 'ui', method, params });
  } catch (err) {
    console.warn('[FutureWallet API] call error:', err);
    throw new Error(err?.message || 'Request failed');
  }
  if (!res) return null;
  // A rejected/failed background call (e.g. a send that reverted) must reach the caller as a
  // thrown error - every call site that shows a real error toast (unlock, send, swap, ...)
  // does `try { await call(...) } catch (e) { toast(e.message) }` expecting exactly this. This
  // used to throw dasdasdasdasdaand then immediately get caught by the try/catch above it was written in,
  // silently turning every failure into `null` - callers had no way to tell success from
  // failure, so a failed send still fell through to the "Transaction Submitted!" screen with an
  // empty hash instead of showing the actual error.
  if (!res.ok) throw new Error(res.error?.message || 'Request failed');
  return res.result;
}

const warnedMissing = new Set();

export const $ = (sel, root = document) => {
  const el = root.querySelector(sel);
  if (el) return el;
  if (!warnedMissing.has(sel)) {
    warnedMissing.add(sel);
    console.warn('[FutureWallet] UI element not found:', sel);
  }
  return new Proxy(document.createElement('div'), {
    get(target, prop) {
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
};
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const short = (a, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : '');

export function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function show(viewId) {
  $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== viewId));
}

export async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast('Copied');
}

export const fmt = (v, d = 8) => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toFixed(d).replace(/\.?0+$/, '') || '0';
};

/** HTML escape - token symbols, NFT names, ENS names and origins all come from the chain or a dApp and are untrusted */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only safe image URLs - blocks schemes like javascript: and data:text */
export function safeImg(url) {
  const u = String(url || '');
  return /^(https?:|ipfs:|data:image\/)/i.test(u) ? esc(u) : '';
}


/* ------------------------------------------------------------------ */
/* In-app dialogs — native confirm()/prompt() cannot be themed and are  */
/* blocking; on Android they also look nothing like the rest of the app */
/* ------------------------------------------------------------------ */

function buildDialog({ title, body, fields = [], actions }) {
  const wrap = document.createElement('div');
  wrap.className = 'dlg-backdrop';
  const fieldHtml = fields
    .map(
      (f) => `<label for="dlg-${f.name}">${esc(f.label || '')}</label>
        <input id="dlg-${f.name}" type="${f.type || 'text'}" placeholder="${esc(f.placeholder || '')}"
               value="${esc(f.value || '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} />`
    )
    .join('');
  wrap.innerHTML = `
    <div class="dlg" role="dialog" aria-modal="true">
      <div class="dlg-title"></div>
      <div class="dlg-body"></div>
      ${fieldHtml}
      <div class="dlg-actions"></div>
    </div>`;
  wrap.querySelector('.dlg-title').textContent = title || '';
  const bodyEl = wrap.querySelector('.dlg-body');
  if (body) bodyEl.textContent = body;
  else bodyEl.remove();

  const actionsEl = wrap.querySelector('.dlg-actions');
  // 2 short actions (Cancel/Confirm) read fine side by side; 3+ - or chooseDialog's longer
  // option labels - squeeze each button toward square under equal flex, and the pill radius
  // then renders them as circles. Stack instead, same as any native action sheet.
  actionsEl.classList.toggle('stacked', actions.length > 2);
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = a.style || 'plain';
    b.textContent = a.label;
    b.dataset.value = a.value;
    actionsEl.appendChild(b);
  });
  document.body.appendChild(wrap);
  const first = wrap.querySelector('input');
  if (first) setTimeout(() => first.focus(), 30);
  return wrap;
}

function runDialog(opts) {
  return new Promise((resolve) => {
    const wrap = buildDialog(opts);
    const close = (val) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const collect = () => {
      const out = {};
      (opts.fields || []).forEach((f) => (out[f.name] = wrap.querySelector('#dlg-' + f.name)?.value ?? ''));
      return out;
    };
    wrap.querySelectorAll('.dlg-actions button').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.value;
        if (v === 'false') return close(false);
        close(opts.fields?.length ? collect() : v);
      });
    });
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(false);
    });
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && opts.fields?.length) close(collect());
    }
    document.addEventListener('keydown', onKey);
  });
}

/** Themed replacement for window.confirm. Resolves true/false. */
export function confirmDialog(title, body, { okLabel = 'Confirm', danger = false } = {}) {
  return runDialog({
    title,
    body,
    actions: [
      { label: 'Cancel', value: 'false', style: 'plain' },
      { label: okLabel, value: 'true', style: danger ? 'danger' : 'primary' }
    ]
  });
}

/** Themed replacement for window.prompt. Resolves the string, or null if cancelled. */
export async function promptDialog(title, { label, placeholder = '', value = '', type = 'text', body, okLabel = 'Save' } = {}) {
  const r = await runDialog({
    title,
    body,
    fields: [{ name: 'v', label: label || '', placeholder, value, type }],
    actions: [
      { label: 'Cancel', value: 'false', style: 'plain' },
      { label: okLabel, value: 'true', style: 'primary' }
    ]
  });
  return r === false ? null : (r.v || '').trim();
}

/** Multi-choice dialog. Resolves the chosen option's value, or null. */
export function chooseDialog(title, body, options) {
  return runDialog({
    title,
    body,
    actions: [...options.map((o) => ({ label: o.label, value: o.value, style: o.style || 'plain' })), { label: 'Cancel', value: 'false', style: 'plain' }]
  }).then((r) => (r === false ? null : r));
}

/** Runs an async action with a busy label on the button, so nothing looks frozen. */
export async function withBusy(btn, label, fn) {
  const el = typeof btn === 'string' ? $(btn) : btn;
  const original = el.textContent;
  el.disabled = true;
  el.textContent = label;
  try {
    return await fn();
  } finally {
    el.disabled = false;
    el.textContent = original;
  }
}
