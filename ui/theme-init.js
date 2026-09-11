// Blocking + synchronous on purpose, before either stylesheet loads: openDapp() in popup.js
// passes the current theme as a ?theme= query param specifically so this can set data-theme
// before first paint, instead of waiting on browser.js's own async call('status') round-trip
// (which still runs, for staying in sync afterward, but was the only source of truth before -
// the markup's static data-theme="binance" fallback painted first every single time, then
// flipped to the real theme moments later once that round-trip resolved. That flash is what a
// synchronous read of the URL - already known before this page even started loading - avoids.
//
// A separate file, not an inline <script> tag, because manifest.json's CSP for extension pages
// is `script-src 'self'` with no 'unsafe-inline' - Manifest V3 doesn't allow that to be relaxed
// even if asked to. An inline block here would silently never run (blocked, logged as a CSP
// violation in the extension's own Errors page) while everything downstream just fell back to
// the flash this was written to avoid. A plain (non-module, non-async/defer) <script src=...>
// keeps the exact same before-first-paint timing an inline block would have had.
try {
  var qTheme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', qTheme);
  document.documentElement.setAttribute('data-bs-theme', qTheme);
} catch (e) {}
