import { call, $, $$, short, toast, fmt, esc } from './api.js';

try { const port = chrome.runtime.connect?.({ name: 'fw-keepalive' }); port?.onMessage?.addListener?.(() => {}); } catch {}

const id = new URLSearchParams(location.search).get('id');
let ctx = null, chosen = [], gasCfg = null, gasChoice = { preset: 'market', custom: null };

const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`;
const weiToEth = (v) => {
  const b = BigInt(v || 0);
  const i = b / 10n ** 18n;
  const f = (b % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return f ? `${i}.${f}` : String(i);
};

function alerts(list) {
  $('#alerts').innerHTML = (list || []).map((r) => `<div class="alert ${r.level === 'danger' ? 'danger' : 'warn'}">${esc(r.text)}</div>`).join('');
}

async function load() {
  ctx = await call('getApproval', { id });
  const { type, data, origin } = ctx.payload;
  $('#netName').textContent = ctx.network.name;
  $('#netDot').style.background = ctx.network.color || '#0376c9';
  $('#origin').textContent = origin;
  const acct = ctx.accounts.find((a) => a.address === ctx.selectedAddress);
  $('#acctName').textContent = acct?.name || 'Locked';
  $('#acctAddr').textContent = acct ? short(acct.address, 5) : '';
  // Only Dark/Light are offered now - anything else still saved from before that change falls
  // back to Dark (see the matching comment in popup.js's applyTheme()).
  const resolvedTh = ctx.settings?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', resolvedTh);
  // See the matching comment in popup.js's applyTheme() - this stays in sync defensively even
  // though app.css's Bootstrap bridge no longer depends on it, since Bootstrap's own vendor CSS
  // still reads this attribute in a few places (native color-scheme included) independently of it.
  document.documentElement.setAttribute('data-bs-theme', resolvedTh === 'light' ? 'light' : 'dark');
  if (!ctx.unlocked || type === 'unlock') $('#unlockCard').classList.remove('hidden');

  if (type === 'connect') {
    $('#title').textContent = 'Connect Wallet';
    const defaultAddr = ctx.selectedAddress || ctx.accounts?.find((a) => !a.readOnly)?.address || ctx.accounts?.[0]?.address;
    chosen = ctx.selectedAddress ? [ctx.selectedAddress] : (defaultAddr ? [defaultAddr] : []);
    $('#body').innerHTML = `<p class="muted">Select account to connect to <b>${esc(origin)}</b></p><div id="accs" style="margin-top:12px"></div>`;
    if (ctx.unlocked) renderAccounts();
    $('#approve').textContent = 'Connect';
  }

  if (type === 'wcSession') {
    const meta = data.proposer || {};
    $('#title').textContent = 'WalletConnect Request';
    const defaultAddr = ctx.selectedAddress || ctx.accounts?.find((a) => !a.readOnly)?.address || ctx.accounts?.[0]?.address;
    chosen = ctx.selectedAddress ? [ctx.selectedAddress] : (defaultAddr ? [defaultAddr] : []);
    const iconUrl = meta.icons?.[0] || '';
    const iconHtml = iconUrl ? `<img src="${esc(iconUrl)}" style="width:36px;height:36px;border-radius:10px;margin-bottom:8px;" />` : '🔗';
    $('#body').innerHTML = `
      <div style="text-align:center;margin-bottom:12px;">
        ${iconHtml}
        <div style="font-size:16px;font-weight:700;">${esc(meta.name || 'Web3 dApp')}</div>
        <div class="muted" style="font-size:12px;">${esc(meta.url || origin)}</div>
      </div>
      <p class="muted">Select account(s) to connect via WalletConnect:</p>
      <div id="accs" style="margin-top:12px"></div>
    `;
    if (ctx.unlocked) renderAccounts();
    $('#approve').textContent = 'Approve Session';
  }

  if (type === 'unlock') {
    $('#title').textContent = 'Unlock wallet';
    $('#body').innerHTML = '<p class="muted">Unlock to continue with this request.</p>';
    $('#approve').textContent = 'Unlock';
  }

  if (type === 'transaction') {
    const tx = data.tx, d = data.decoded;
    $('#title').textContent = d?.summary || 'Confirm transaction';
    alerts([...(d?.risks || []), ...(data.extraRisks || [])]);
    if (data.preflight && data.preflight.ok === false) {
      $('#approve').textContent = 'Confirm anyway';
      $('#approve').classList.add('danger');
      $('#approve').classList.remove('primary');
    }
    $('#body').innerHTML =
      kv('From', short(tx.from, 6)) +
      kv('To', tx.to ? short(tx.to, 6) : 'Contract deploy') +
      kv('Value', `${weiToEth(tx.value || '0x0')} ${ctx.network.symbol}`) +
      kv('Method', d?.method || 'transfer') +
      (d?.args?.length ? `<label>Decoded parameters</label><div class="code">${d.args.map((a) => `${esc(a.name)} (${esc(a.type)}): ${esc(a.value)}`).join('\n')}</div>` : '') +
      (tx.data && tx.data !== '0x' ? `<label>Raw data</label><div class="code">${esc(tx.data)}</div>` : '');
    gasCfg = data.gas;
    if (gasCfg) {
      $('#gasCard').classList.remove('hidden');
      applyGas();
      if (gasCfg.estimateFailed)
        alerts([...(d?.risks || []), { level: 'danger', text: 'Gas estimate fail hua — matlab ye tx revert ho sakti hai. Fallback gas limit lagayi hai; confirm karne se pehle soch lo.' }]);
    }
  }

  if (type === 'signMessage') {
    $('#title').textContent = data.siwe ? 'Sign-in request' : 'Signature request';
    alerts(data.risks);
    $('#body').innerHTML = data.siwe
      ? kv('Site', data.siwe.domain) + kv('Account', short(data.address, 6)) + kv('Chain ID', data.siwe.chainId || '—') +
        kv('Nonce', data.siwe.nonce || '—') + kv('Expires', data.siwe.expiry || '—') +
        `<label>Statement</label><div class="code">${esc(data.siwe.statement || '')}</div>`
      : kv('Account', short(data.address, 6)) + `<label>Message</label><div class="code">${esc(data.message)}</div>`;
    $('#approve').textContent = 'Sign';
  }

  if (type === 'signTypedData') {
    $('#title').textContent = 'Typed data signature';
    let pretty = data.data;
    try { pretty = JSON.stringify(JSON.parse(data.data), null, 2); } catch {}
    $('#body').innerHTML = kv('Account', short(data.address, 6)) + `<label>EIP-712 data</label><div class="code">${esc(pretty)}</div>`;
    $('#approve').textContent = 'Sign';
  }

  if (type === 'switchChain') {
    $('#title').textContent = 'Switch network';
    $('#body').innerHTML = kv('Network', data.network.name) + kv('Chain ID', data.network.chainId) + kv('RPC', data.network.rpcUrl);
    $('#approve').textContent = 'Switch';
  }

  if (type === 'addChain') {
    $('#title').textContent = 'Add network';
    alerts([{ level: 'warn', text: 'Only add RPCs you trust - a malicious RPC can show you false data.' }]);
    $('#body').innerHTML = kv('Network', data.network.name) + kv('Chain ID', data.network.chainId) + kv('RPC', data.network.rpcUrl) + kv('Symbol', data.network.symbol);
    $('#approve').textContent = 'Add';
  }

  if (type === 'watchAsset') {
    $('#title').textContent = 'Add token';
    $('#body').innerHTML = kv('Symbol', data.token.symbol || '?') + kv('Address', short(data.token.address, 6)) + kv('Decimals', data.token.decimals ?? 18);
    $('#approve').textContent = 'Add token';
  }
}

function renderAccounts() {
  const el = $('#accs');
  if (!el) return;
  el.innerHTML = '';
  let list = (ctx.accounts || []).filter((a) => !a.readOnly);
  if (list.length === 0 && ctx.selectedAddress) {
    list = [{ name: 'Account 1', address: ctx.selectedAddress }];
  }
  if (!chosen.length && list.length) {
    chosen = [list[0].address];
  }
  list.forEach((a) => {
    const on = chosen.includes(a.address);
    const d = document.createElement('div');
    d.className = 'rowitem';
    d.style.margin = '0 0 8px 0';
    d.innerHTML = `<div class="tokenicon">${(a.name || 'A1').slice(0, 2)}</div><div class="grow"><div class="title">${esc(a.name || 'Account 1')}</div><div class="sub">${short(a.address, 6)}</div></div>
      <span class="badge ${on ? 'ok' : ''}">${on ? 'Selected ✓' : 'Select'}</span>`;
    d.onclick = () => { chosen = on ? chosen.filter((x) => x !== a.address) : [...chosen, a.address]; renderAccounts(); };
    el.appendChild(d);
  });
}

function currentGas() {
  if (!gasCfg) return null;
  return gasChoice.custom || gasCfg.options[gasChoice.preset];
}
function applyGas() {
  const g = currentGas();
  if (!g) return;
  $('#feeText').textContent = `≈ ${fmt(g.feeEther, 6)} ${ctx.network.symbol}`;
  $('#gasLabel').textContent = gasChoice.custom ? 'Advanced' : gasCfg.options[gasChoice.preset].label;
}

$('#editGas').onclick = () => {
  const el = $('#gasOpts');
  el.innerHTML = '';
  Object.entries(gasCfg.options).forEach(([k, o]) => {
    const d = document.createElement('div');
    d.className = 'gasopt' + (!gasChoice.custom && gasChoice.preset === k ? ' on' : '');
    d.innerHTML = `<div class="grow"><b>${o.label}</b><div class="muted">${o.eta}</div></div><div>${fmt(o.feeEther, 6)} ${ctx.network.symbol}</div>`;
    d.onclick = () => { gasChoice = { preset: k, custom: null }; applyGas(); $('#sheetGas').classList.add('hidden'); };
    el.appendChild(d);
  });
  const g = currentGas();
  $('#gasLimitIn').value = BigInt(g.gasLimit).toString();
  $('#maxFeeIn').value = (Number(BigInt(g.maxFeePerGas)) / 1e9).toFixed(3);
  $('#tipIn').value = (Number(BigInt(g.maxPriorityFeePerGas)) / 1e9).toFixed(3);
  $('#nonceIn').value = gasCfg.nonce;
  $('#sheetGas').classList.remove('hidden');
};
$('#gasCancel').onclick = () => $('#sheetGas').classList.add('hidden');
$('#gasSave').onclick = () => {
  const limit = BigInt($('#gasLimitIn').value || '21000');
  const maxFee = BigInt(Math.round(Number($('#maxFeeIn').value || 1) * 1e9));
  const tip = BigInt(Math.round(Number($('#tipIn').value || 1) * 1e9));
  gasChoice = { preset: 'custom', custom: {
    eip1559: gasCfg.eip1559, gasLimit: '0x' + limit.toString(16), maxFeePerGas: '0x' + maxFee.toString(16),
    maxPriorityFeePerGas: '0x' + tip.toString(16), gasPrice: '0x' + maxFee.toString(16),
    feeEther: String(Number(maxFee * limit) / 1e18), nonce: $('#nonceIn').value } };
  applyGas();
  $('#sheetGas').classList.add('hidden');
};

$('#reject').onclick = async () => { await call('resolveApproval', { id, approved: false }).catch(() => {}); window.close(); };

$('#approve').onclick = async () => {
  const { type, data } = ctx.payload;
  try {
    if (!ctx.unlocked || type === 'unlock') {
      await call('unlock', { password: $('#pw').value });
      ctx = await call('getApproval', { id });
      $('#unlockCard').classList.add('hidden');
      if (type === 'unlock') { await call('resolveApproval', { id, approved: true, result: true }); return window.close(); }
      if (type === 'connect') { chosen = ctx.selectedAddress ? [ctx.selectedAddress] : [ctx.accounts[0].address]; renderAccounts(); return toast('Ab Connect dabao'); }
    }
    let result = true;
    if (type === 'connect' || type === 'wcSession') { if (!chosen.length) return toast('Select an account'); result = chosen; }
    if (type === 'transaction') {
      const g = currentGas();
      const tx = { ...data.tx };
      if (g) {
        tx.gas = g.gasLimit;
        if (g.nonce != null && g.nonce !== '') tx.nonce = g.nonce;
        if (g.eip1559) { tx.maxFeePerGas = g.maxFeePerGas; tx.maxPriorityFeePerGas = g.maxPriorityFeePerGas; delete tx.gasPrice; }
        else { tx.gasPrice = g.gasPrice; }
      }
      result = tx;
    }
    await call('resolveApproval', { id, approved: true, result });
    window.close();
  } catch (e) { toast(e.message); }
};

load().catch((e) => { $('#title').textContent = 'Request expired'; $('#body').innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
