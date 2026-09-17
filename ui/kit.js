/* Reusable UI primitives - no dependencies */

/* ---------- deterministic identicon (jazzicon-style) ---------- */

const PALETTE = [
  ['#6d5efc', '#a78bfa'], ['#0376c9', '#4ee1a0'], ['#f0b90b', '#ff7a45'],
  ['#e84142', '#ff9f7f'], ['#28a0f0', '#8c8dfc'], ['#00d66f', '#0af0a0'],
  ['#ff007a', '#ff8ac2'], ['#814625', '#e0a468'], ['#8247e5', '#c9a2ff'], ['#1e293b', '#64748b']
];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i), (h |= 0);
  return Math.abs(h);
}

/** Builds a unique gradient + shapes SVG data URI from an address */
export function identicon(address, size = 32) {
  const seed = hashCode((address || '0x0').toLowerCase());
  const [a, b] = PALETTE[seed % PALETTE.length];
  const [c] = PALETTE[(seed >> 3) % PALETTE.length];
  const r1 = (seed % 40) - 20;
  const r2 = ((seed >> 5) % 60) - 30;
  const x1 = ((seed >> 7) % 60) + 10;
  const y1 = ((seed >> 11) % 60) + 10;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<rect x="${x1 - 30}" y="${y1 - 30}" width="70" height="70" fill="${c}" opacity=".55" transform="rotate(${r1} 50 50)"/>` +
    `<circle cx="${x1}" cy="${y1}" r="26" fill="${b}" opacity=".5" transform="rotate(${r2} 50 50)"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Same as identicon(), but returns the address's chosen NFT avatar image when one is set
 * (avatarsMap is S.accountAvatars, address.toLowerCase() -> {image}) - falls back to the
 * deterministic identicon otherwise. Only meaningful for the wallet's own accounts; contacts have
 * no avatar concept. */
export function avatarFor(address, size = 32, avatarsMap) {
  const set = avatarsMap && avatarsMap[(address || '').toLowerCase()];
  return (set && set.image) || identicon(address, size);
}

export function avatarEl(address, size = 32) {
  const img = document.createElement('img');
  img.src = identicon(address, size);
  img.width = img.height = size;
  img.className = 'ident';
  img.style.width = img.style.height = size + 'px';
  return img;
}

/* ---------- token symbol se stable color ---------- */

export function symbolColor(sym) {
  const [a] = PALETTE[hashCode(sym || 'X') % PALETTE.length];
  return a;
}

/* ---------- fiat currency formatting ---------- */
/* Covers exactly the currencies in Settings' #setCurrency list. A code with no common single-
   glyph symbol (AED, CHF) falls back to its own uppercase code as a prefix instead - still reads
   as "AED 12.30", never as a bare, ambiguous number. */

const FIAT_SYMBOLS = {
  usd: '$', eur: '€', gbp: '£', inr: '₹', jpy: '¥', aud: 'A$', cad: 'C$',
  cny: '¥', sgd: 'S$', krw: '₩', brl: 'R$', rub: '₽'
};

export function fiatSymbol(code) {
  const c = (code || '').toLowerCase();
  return FIAT_SYMBOLS[c] || `${c.toUpperCase()} `;
}

export function fmtFiat(value, code) {
  const n = Number(value);
  return `${fiatSymbol(code)}${isFinite(n) ? n.toFixed(2) : '0.00'}`;
}

/* ---------- relative time ---------- */

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}

/* ---------- skeleton ---------- */

export function skeletonRows(container, n = 3) {
  container.innerHTML = Array.from({ length: n })
    .map(
      () => `<div class="rowitem" style="pointer-events:none">
        <div class="sk sk-circle"></div>
        <div class="grow"><div class="sk sk-line" style="width:45%"></div><div class="sk sk-line" style="width:28%;height:9px"></div></div>
        <div class="sk sk-line" style="width:52px"></div></div>`
    )
    .join('');
}

/* ---------- sparkline ---------- */

/** points: number[] - smooth area chart on a canvas. Pass activeIndex (from a touch/drag handler)
 * to overlay a dashed guide line + dot at that point, for a scrubbable/interactive feel - the
 * caller owns turning pointer events into an index and reading back points[activeIndex] for its
 * own tooltip text, this just draws the marker. */
export function drawSparkline(canvas, points, color = '#0376c9', activeIndex = null) {
  if (!canvas || !points || points.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 48;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const px = (i) => (i / (points.length - 1)) * w;
  const py = (v) => h - 4 - ((v - min) / span) * (h - 10);

  ctx.beginPath();
  ctx.moveTo(px(0), py(points[0]));
  for (let i = 1; i < points.length; i++) {
    const cx = (px(i - 1) + px(i)) / 2;
    ctx.bezierCurveTo(cx, py(points[i - 1]), cx, py(points[i]), px(i), py(points[i]));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '4d');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();

  if (activeIndex != null && points[activeIndex] != null) {
    const x = px(activeIndex), y = py(points[activeIndex]);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color + '99';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/* ---------- donut chart ---------- */

/** slices: {value, color}[] - portfolio allocation, etc. Punches a hole via
 * destination-out rather than stroking a ring, so segments still meet cleanly at the center. */
export function drawDonut(canvas, slices) {
  if (!canvas || !slices?.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return;
  const cx = w / 2, cy = h / 2;
  const outerR = Math.min(w, h) / 2 - 1;
  let start = -Math.PI / 2;
  for (const s of slices) {
    const angle = (s.value / total) * Math.PI * 2;
    if (angle <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    start += angle;
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, outerR * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/* ---------- icon set ---------- */
/* Inline SVG, stroke-based, currentColor - no icon font/CDN so this keeps working offline in
   both the Capacitor WebView and the Chrome extension. Replaces the app's previous per-screen
   Unicode/emoji glyphs (↑ ↓ ⇄ ◎ ⌂ …) with one consistent set. */

const ICONS = {
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9h5v-5h2v5h5v-9"/>',
  assets: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  swap: '<path d="M6 8h11l-3-3"/><path d="M18 16H7l3 3"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6z"/>',
  profile: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6"/>',
  send: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
  receive: '<path d="M17 7 7 17"/><path d="M15 17H7V9"/>',
  copy: '<rect x="9" y="9" width="10" height="10" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  share: '<circle cx="6" cy="12" r="2.3"/><circle cx="17" cy="6" r="2.3"/><circle cx="17" cy="18" r="2.3"/><path d="M8.1 10.8 14.9 7.2M8.1 13.2l6.8 3.6"/>',
  explorer: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5-5"/>',
  wallet: '<path d="M4 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2h-6a3 3 0 0 0 0 6h6v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  // A ring of evenly-spaced radiating lines around a circle reads as a sun/brightness icon, not
  // settings - this is a proper gear (Feather icons' "settings"), the shape people actually
  // recognize for a settings screen.
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  nft: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M5 17l4.5-5 3 3 2-2.5L20 17"/>',
  bridge: '<path d="M3 16c2.5-6 5.5-9 9-9s6.5 3 9 9"/><path d="M3 16h18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  flip: '<path d="M8 3v13"/><path d="M4.5 12.5 8 16l3.5-3.5"/><path d="M16 21V8"/><path d="M19.5 11.5 16 8l-3.5 3.5"/>',
  down: '<path d="M12 4v14"/><path d="M6 12l6 6 6-6"/>',
  network: '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8 8l6.5 3M16 8l-3 8"/>',
  reload: '<path d="M4 12a8 8 0 0 1 14-5.3L21 9"/><path d="M21 3v6h-6"/><path d="M20 12a8 8 0 0 1-14 5.3L3 15"/><path d="M3 21v-6h6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="3" height="3" fill="currentColor" stroke="none"/><rect x="18" y="14" width="3" height="3" fill="currentColor" stroke="none"/><rect x="14" y="18" width="3" height="3" fill="currentColor" stroke="none"/><rect x="18" y="18" width="3" height="3" fill="currentColor" stroke="none"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-3.1 4.1M6.5 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.6-.3 3.7-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  megaphone: '<path d="M3 11v2a2 2 0 0 0 2 2h1l1 5h2l-1-5h1l9 4V6l-9 4H6a2 2 0 0 0-2 2z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'
};

/** Inline <svg> markup for one of the app's built-in icon names. Falls back to a blank square. */
export function icon(name, { size = 20, strokeWidth = 2 } = {}) {
  const body = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* ---------- password strength ---------- */

export function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^\w\s]/.test(pw)) score++;
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  const colors = ['#d73a49', '#d73a49', '#f8a233', '#f8a233', '#28a745', '#28a745'];
  return { score, pct: (score / 5) * 100, label: labels[score], color: colors[score] };
}
