/*
 * FutureWallet Telegram Mini App - deployment settings.
 *
 * Everything deployment-specific lives here; nothing in tg/*.js or dist/background.js needs to
 * be edited to rebrand, move domains, or point at your own chain. Loaded as a plain script before
 * the wallet engine, which reads it as window.FW_CONFIG.
 *
 * NEVER put secrets here (bot token, API keys you pay for) - this file is public.
 */
window.FW_CONFIG = {
  version: '2.0.0-tg',

  telegram: {
    // Used for "Open in Telegram" links and share deep links: https://t.me/<botUsername>/<appShortName>
    botUsername: 'FutureWalletBot',
    appShortName: 'wallet',
    // Refuse to run outside Telegram (shows an "Open in Telegram" screen). Set false for local dev.
    requireTelegram: true,
    // Full-screen mode (Bot API 8.0+). false = normal expanded Mini App under Telegram's header.
    fullscreen: false,
    // Stop the swipe-down-to-close gesture from firing while scrolling long lists (Bot API 7.7+).
    disableVerticalSwipes: true,
    // Ask before closing while a signature/transaction approval is on screen.
    confirmCloseDuringApproval: true
  },

  // Settings merged into the engine's APP defaults (src/config/settings.js).
  app: {
    defaultNetworkKey: 'bsc',
    autoLockMinutes: 15,
    homepage: 'https://pancakeswap.finance/'
  },

  // Required for dApp connections - the Mini App cannot inject window.ethereum into other sites,
  // so WalletConnect is how dApps connect. Free project id: https://cloud.reown.com
  walletConnect: {
    projectId: '',
    metadata: {
      name: 'FutureWallet',
      description: 'Multi-chain Web3 wallet in Telegram',
      url: 'https://wallet.example.com',
      icons: ['https://wallet.example.com/icons/icon128.png']
    }
  },

  // Your own backend (server/). Used for "send vault backup to my Telegram chat".
  // Leave baseUrl '' to serve the API from the same origin as this Mini App.
  api: {
    enabled: true,
    baseUrl: ''
  },

  storage: {
    prefix: 'fw',
    // Keep each Telegram account's wallet separate on shared devices.
    namespaceByTelegramUser: true,
    // Mirror wallet data to Telegram DeviceStorage (Bot API 9.0+) so a WebView cache clear
    // doesn't wipe the wallet.
    deviceStorageMirror: true,
    // Also keep the ENCRYPTED vault in Telegram CloudStorage (per user, synced across the user's
    // devices). Off by default: it is only as strong as the user's password.
    cloudVaultBackup: false
  },

  // Per-chain RPC URLs tried before the built-in ones (HTTPS only - http is blocked in the WebView).
  rpcOverrides: {
    // 7777: ['https://rpc.futurechain.example.com']
  },

  // Field overrides for built-in networks, keyed by chainId (key/chainId cannot be changed).
  networkOverrides: {
    7777: {
      name: 'Future Chain',
      rpcUrl: 'https://rpc.futurechain.example.com',
      explorer: 'https://scan.futurechain.example.com',
      symbol: 'FTC',
      testnet: false
    }
  },

  // Networks added for every user (skipped if the chainId already exists).
  extraNetworks: [
    // { key: 'my-chain', name: 'My Chain', chainId: 12345, rpcUrl: 'https://rpc.mychain.io', symbol: 'MYC', explorer: 'https://scan.mychain.io', color: '#6d5efc' }
  ],

  // Default tokens per chainId.
  extraTokens: {
    // 56: [{ address: '0x...', symbol: 'TOKEN', decimals: 18 }]
  },

  // Extra phishing domains (merged with the built-in and remote lists).
  phishingBlocklist: [],

  // Firestore remote config (maintenance switch, announcements, notifications, rpcOverrides).
  // Set projectId: '' to disable.
  remoteConfig: {
    projectId: 'futurewallet-84d19'
  },

  // dApp shortcuts shown on the Discover screen - opened in Telegram's browser, connected over WalletConnect.
  dapps: [
    { name: 'PancakeSwap', url: 'https://pancakeswap.finance/', icon: '🥞', desc: 'Trade, earn & farm on BNB Chain' },
    { name: 'Uniswap', url: 'https://app.uniswap.org/', icon: '🦄', desc: 'Swap tokens on Ethereum & L2s' },
    { name: 'EravittAI', url: 'https://eravittai.com/login', icon: '🟢', desc: 'Monthly token rewards on BSC' },
    { name: 'OpenSea', url: 'https://opensea.io/', icon: '⛵', desc: 'Discover, collect and sell NFTs' },
    { name: 'Aave', url: 'https://app.aave.com/', icon: '👻', desc: 'Lend and borrow crypto' },
    { name: '1inch', url: 'https://app.1inch.io/', icon: '🔀', desc: 'DEX aggregator, best swap rates' }
  ]
};
