/**
 * Token / chain logos - tries multiple CDNs, falls back to a letter circle.
 * No API key. Logos come from a CDN; your wallet address is never sent.
 */

import { symbolColor } from './kit.js';
import { esc } from './api.js';

/** chainId -> folder name in the Trust Wallet assets repo */
export const CHAIN_SLUG = {
  1: 'ethereum', 56: 'smartchain', 137: 'polygon', 43114: 'avalanchec', 42161: 'arbitrum',
  10: 'optimism', 8453: 'base', 250: 'fantom', 25: 'cronos', 100: 'xdai', 1284: 'moonbeam',
  1285: 'moonriver', 42220: 'celo', 1666600000: 'harmony', 1088: 'metis', 59144: 'linea',
  534352: 'scroll', 5000: 'mantle', 81457: 'blast', 1101: 'polygonzkevm', 324: 'zksync',
  7777777: 'zora', 1329: 'sei', 8217: 'kaia', 204: 'opbnb', 42170: 'arbitrumnova',
  169: 'manta', 252: 'fraxtal', 14: 'flare', 1313161554: 'aurora'
};

/** Testnets reuse their mainnet logo */
const TESTNET_PARENT = {
  11155111: 1, 17000: 1, 97: 56, 80002: 137, 43113: 43114, 421614: 42161,
  11155420: 10, 84532: 8453, 59141: 59144, 534351: 534352, 300: 324
};

const TW = 'https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains';
const TW_RAW = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

const toChecksumish = (a) => String(a || '');

/** Candidate URLs for an ERC-20 token (tried in order) */
export function tokenLogoUrls(chainId, address) {
  const id = TESTNET_PARENT[Number(chainId)] || Number(chainId);
  const slug = CHAIN_SLUG[id];
  const addr = toChecksumish(address);
  const urls = [];
  if (slug && addr) {
    urls.push(`${TW}/${slug}/assets/${addr}/logo.png`);
    urls.push(`${TW_RAW}/${slug}/assets/${addr}/logo.png`);
  }
  if (id === 1 && addr) urls.push(`https://tokens.1inch.io/${addr.toLowerCase()}.png`);
  return urls;
}

/** Candidate URLs for the native coin (ETH, BNB, POL…) */
export function nativeLogoUrls(chainId) {
  const id = TESTNET_PARENT[Number(chainId)] || Number(chainId);
  const slug = CHAIN_SLUG[id];
  if (!slug) return [];
  return [`${TW}/${slug}/info/logo.png`, `${TW_RAW}/${slug}/info/logo.png`];
}

/**
 * Build a logo element - tries the CDN chain, falls back to a letter circle.
 * Returns: HTMLElement (img ya div)
 */
export function logoEl({ urls = [], symbol = '?', color, size = 32, enabled = true }) {
  const fallback = () => {
    const d = document.createElement('div');
    d.className = 'tokenicon tinted';
    d.style.background = color || symbolColor(symbol);
    d.style.width = d.style.height = size + 'px';
    // Scale both the letter count and font size to the badge size so the
    // text never overflows a small circle (e.g. the 14-16px header pill).
    const chars = size < 20 ? 1 : size < 30 ? 2 : 3;
    const ratio = chars === 1 ? 0.5 : chars === 2 ? 0.4 : 0.32;
    d.style.fontSize = Math.max(7, Math.round(size * ratio)) + 'px';
    d.textContent = String(symbol).slice(0, chars).toUpperCase();
    return d;
  };

  if (!enabled || !urls.length) return fallback();

  const img = document.createElement('img');
  img.className = 'tokenlogo';
  img.width = img.height = size;
  img.style.width = img.style.height = size + 'px';
  img.alt = esc(symbol);
  img.loading = 'lazy';

  let i = 0;
  const tryNext = () => {
    if (i >= urls.length) {
      img.replaceWith(fallback());
      return;
    }
    img.src = urls[i++];
  };
  img.addEventListener('error', tryNext);
  tryNext();
  return img;
}

export const tokenLogo = (chainId, address, symbol, size, enabled) =>
  logoEl({ urls: address ? tokenLogoUrls(chainId, address) : nativeLogoUrls(chainId), symbol, size, enabled });

export const chainLogo = (chainId, name, size = 20, enabled = true) =>
  logoEl({ urls: nativeLogoUrls(chainId), symbol: name || '?', size, enabled });
