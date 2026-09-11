import { $, call, confirmDialog } from './api.js';

const p = new URLSearchParams(location.search);
// Telegram Mini App: this page is an overlay (tg/host.js) - "back" closes it and "proceed" opens
// the site in Telegram's browser instead of navigating this frame to it.
const TG = window.FWTG || null;

function setBsTheme(th) {
  // See the matching comment in popup.js's applyTheme().
  document.documentElement.setAttribute('data-bs-theme', th === 'light' ? 'light' : 'dark');
}
call('status', {}).then((s) => {
  // Only Dark/Light are offered now - anything else still saved from before that change falls
  // back to Dark.
  const resolvedTh = s?.settings?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', resolvedTh);
  setBsTheme(resolvedTh);
}).catch(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
  setBsTheme('dark');
});

$('#host').textContent = p.get('host') || '';

$('#back').onclick = () => {
  if (TG) return window.close();
  if (history.length > 1) return history.back();
  chrome.tabs.getCurrent((t) => t && chrome.tabs.remove(t.id));
};

$('#proceed').onclick = async () => {
  if (!(await confirmDialog('Open blocked site?', 'This site is on the phishing blocklist and may steal your funds. Continue only if you are completely sure.', { okLabel: 'Open anyway', danger: true }))) return;
  await call('allowSiteOnce', { host: p.get('host') });
  const url = p.get('url');
  if (!url) return;
  if (TG) {
    TG.openLinkUnchecked(url);
    window.close();
    return;
  }
  location.href = url;
};
