/*
 * FutureWallet - UI frame bridge (Telegram Mini App).
 *
 * Loaded as the FIRST script of every ui/*.html page. The page runs inside a same-origin iframe
 * of index.html; this wires its `chrome` global to the engine running in the host document and
 * exposes the Telegram adapters as window.FWTG. Classic script so it runs before the page's
 * module scripts (api.js, popup.js, ...).
 */
(function () {
  'use strict';
  var de = document.documentElement;
  de.classList.add('mobile');

  var H = null;
  try {
    if (window.parent && window.parent !== window && window.parent.FW_HOST) H = window.parent.FW_HOST;
  } catch (e) { H = null; }

  if (!H) {
    // Opened directly (not through index.html) - there is no engine here. Send the user to the host.
    if (window.parent === window && !/[?&]standalone=1/.test(location.search)) {
      location.replace(new URL('../index.html', location.href).href);
    }
    return;
  }

  de.classList.add('tg');
  var api = H.attachFrame(window);
  try {
    Object.defineProperty(window, 'chrome', { value: api.chrome, writable: true, configurable: true });
  } catch (e) {
    window.chrome = api.chrome;
  }
  window.FWTG = api.FWTG;

  // approve.js / phishing.js call window.close() when done - close the overlay instead.
  try { window.close = function () { H.closeFrame(window); }; } catch (e) {}

  // Native alert/confirm/prompt are unreliable in Telegram WebViews (iOS ignores some of them).
  // Pages use themed dialogs from api.js; these are last-resort fallbacks via the host.
  window.alert = function (msg) { try { api.FWTG.toast(String(msg || '')); } catch (e) {} };

  var raf = 0;
  function changed() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () { try { H.frameChanged(window); } catch (e) {} });
  }
  function themed() { try { H.themeChanged(window); } catch (e) {} }

  new MutationObserver(themed).observe(de, { attributes: true, attributeFilter: ['data-theme'] });

  function onReady() {
    if (document.body) document.body.classList.add('mobile');
    new MutationObserver(changed).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    changed();
    themed();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
