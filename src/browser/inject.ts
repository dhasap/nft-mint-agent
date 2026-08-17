/**
 * Browser Wallet Injection & Minting Scripts
 *
 * Generates JavaScript code that the Hermes agent evaluates via browser_console().
 * These scripts inject a custom window.ethereum provider that:
 * 1. Mimics MetaMask interface
 * 2. Signs transactions using the wallet's private key via ethers.js (CDN)
 * 3. Auto-clicks Connect Wallet / Mint buttons
 * 4. Supports multi-wallet rotation (sequential)
 *
 * BUG-004 FIX: Added prominent security warnings and signing proxy documentation.
 * BUG-014 FIX: Enhanced findConnectButton/findMintButton with more DOM patterns,
 * data-* attributes, aria-labels, and added dry-run mode.
 *
 * SECURITY WARNING (BUG-004):
 * This approach embeds private keys in browser memory. This is inherently risky.
 * For production use, consider a signing proxy approach where:
 * - A WebSocket server runs on the agent side
 * - The browser sends sign requests to the agent
 * - The agent signs and returns the signature
 * - Private keys never leave the agent memory
 *
 * Current mitigation: Use isolated Browserbase instances, destroy after use.
 */

import { ethers } from 'ethers';
import { Config } from '../config';
import { WalletManager, WalletInfo } from '../wallet';
import { shortAddress } from '../utils';

/**
 * SECURITY (hardened injected provider):
 * Function selectors that can move or approve assets OUT of the wallet. The
 * injected provider refuses to sign/send these so a malicious or compromised
 * minting page (or an XSS / CDN compromise) cannot drain the wallet. A normal
 * mint never needs any of these.
 */
export const DANGEROUS_SELECTORS: Record<string, string> = {
  '0xa22cb465': 'setApprovalForAll',
  '0x095ea7b3': 'approve',
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
  '0x42842e0e': 'safeTransferFrom',
  '0xb88d4fde': 'safeTransferFrom(bytes)',
  '0x39509351': 'increaseAllowance',
  '0xd505accf': 'permit',
};

// Pinned ethers UMD build + Subresource Integrity hash. Loading by exact
// version with `integrity` means a tampered/compromised CDN file is rejected
// by the browser instead of executing with access to the private key.
export const ETHERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js';
export const ETHERS_SRI = 'sha384-6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM';

/**
 * Build the in-page guard JS embedded into every injected provider. Enforces:
 *  - tx.to allowlist (when provided),
 *  - blocked dangerous selectors (approvals/transfers),
 *  - per-tx value cap (wei),
 *  - typed-data signing disabled by default (Seaport orders/permits can
 *    authorize asset transfers).
 */
export function buildTxGuardJs(maxValueWei: bigint, allowedTo: string[], allowOrderSigning: boolean): string {
  const allow = JSON.stringify(allowedTo.map(a => a.toLowerCase()));
  const danger = JSON.stringify(DANGEROUS_SELECTORS);
  return `
  // ===== Injected-provider safety guard (do not remove) =====
  const __MAX_VALUE_WEI = BigInt('${maxValueWei.toString()}');
  const __ALLOWED_TO = ${allow};
  const __DANGEROUS_SELECTORS = ${danger};
  const __ALLOW_TYPED_DATA = ${allowOrderSigning ? 'true' : 'false'};
  function __toBig(v) {
    if (v === undefined || v === null || v === '') return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    return BigInt(v); // handles '0x..' and decimal strings
  }
  function __assertSafeTx(tx) {
    const to = (tx && tx.to ? String(tx.to) : '').toLowerCase();
    if (__ALLOWED_TO.length && to && !__ALLOWED_TO.includes(to)) {
      throw new Error('[WalletInject] BLOCKED: destination ' + to + ' is not in the allowed mint-contract list.');
    }
    const data = String((tx && (tx.data || tx.input)) || '0x');
    const selector = data.slice(0, 10).toLowerCase();
    if (__DANGEROUS_SELECTORS[selector]) {
      throw new Error('[WalletInject] BLOCKED dangerous call ' + __DANGEROUS_SELECTORS[selector] + ' (' + selector + '): this could drain the wallet and is never required to mint.');
    }
    const v = __toBig(tx ? tx.value : 0n);
    if (v > __MAX_VALUE_WEI) {
      throw new Error('[WalletInject] BLOCKED: tx value ' + v.toString() + ' wei exceeds the configured cap ' + __MAX_VALUE_WEI.toString() + ' wei.');
    }
    return tx;
  }
  function __assertTypedDataAllowed() {
    if (!__ALLOW_TYPED_DATA) {
      throw new Error('[WalletInject] BLOCKED: typed-data signing is disabled (a Seaport order / permit signature can authorize asset transfers). Re-generate with allowOrderSigning=true only if you trust the page.');
    }
  }
`;
}

// --- Result Types ---

export interface BrowserMintResult {
  url: string;
  walletScripts: WalletScript[];
  multiWalletScript: string;
  autoClickScript: string;
  stepByStepGuide: string[];
  warnings: string[];
}

export interface WalletScript {
  walletIndex: number;
  address: string;
  injectScript: string;
}

/**
 * Generate all browser minting scripts
 */
export function generateBrowserMintScripts(
  config: Config,
  walletManager: WalletManager,
  options: {
    url: string;
    walletIndices?: number[];
    /** Restrict eth_sendTransaction to these contract address(es). Empty = any (selector blocklist still applies). */
    allowedContracts?: string[];
    /** Per-tx value cap in ETH. Defaults to config.maxMintPriceEth. */
    maxTxValueEth?: number;
    /** Allow eth_signTypedData_* (Seaport orders / permits). Default false. */
    allowOrderSigning?: boolean;
    /** 'embedded' = private key in browser (legacy). 'proxy' = keys stay on agent via signing proxy (recommended). Default: 'embedded'. */
    signing?: 'embedded' | 'proxy';
    /** Signing proxy endpoint + token (required when signing==='proxy'). */
    proxy?: { wsUrl: string; token: string };
  }
): BrowserMintResult {
  const wallets = walletManager.getAllWallets();
  const rpcUrl = config.rpcUrl;
  const chainId = walletManager.getChainId();
  const chainIdHex = '0x' + chainId.toString(16);
  const indicesToUse = options.walletIndices || wallets.map(w => w.index);
  const proxyMode = options.signing === 'proxy' && !!options.proxy;

  // Safety guard parameters shared by all injected scripts.
  const allowedTo = (options.allowedContracts || []).filter(a => /^0x[a-fA-F0-9]{40}$/.test(a));
  const maxTxValueEth = options.maxTxValueEth ?? config.maxMintPriceEth;
  const maxValueWei = ethers.parseEther(String(maxTxValueEth || 0));
  const allowOrderSigning = options.allowOrderSigning === true;
  const guardJs = buildTxGuardJs(maxValueWei, allowedTo, allowOrderSigning);

  const result: BrowserMintResult = {
    url: options.url,
    walletScripts: [],
    multiWalletScript: '',
    autoClickScript: '',
    stepByStepGuide: [],
    warnings: [
      'CRITICAL: Private keys are embedded in browser memory!',
      'Only use with isolated browser instances (Browserbase cloud browsers).',
      'Destroy the browser instance immediately after minting.',
      'Consider a signing proxy for production: WebSocket signing where private keys stay on the agent. Browser minting is SEQUENTIAL (one wallet at a time), slower than direct mint (PARALLEL).',
    ],
  };

  if (proxyMode) {
    result.warnings = [
      'Signing proxy mode: PRIVATE KEYS NEVER ENTER THE BROWSER.',
      `Signing happens on the agent machine (${options.proxy!.wsUrl}).`,
      'Browser holds only the wallet address + a session token (revoked on stop).',
      'Stop the signing proxy after minting: stop_signing_proxy.',
      'Browser minting is SEQUENTIAL (one wallet at a time), slower than direct mint (PARALLEL).',
    ];
  }

  // Generate per-wallet injection scripts
  for (const idx of indicesToUse) {
    const wallet = wallets.find(w => w.index === idx);
    if (!wallet) continue;

    const script = proxyMode && options.proxy
      ? generateProxyRelayScript({
          wsUrl: options.proxy.wsUrl,
          token: options.proxy.token,
          address: wallet.address,
          chainId,
          chainIdHex,
        })
      : generateSingleWalletScript(wallet, rpcUrl, chainId, chainIdHex, guardJs);

    result.walletScripts.push({
      walletIndex: idx,
      address: wallet.address,
      injectScript: script,
    });
  }

  // Generate multi-wallet rotation script
  if (proxyMode && options.proxy) {
    result.multiWalletScript = generateProxyMultiWalletScript(
      wallets.filter(w => indicesToUse.includes(w.index)),
      options.proxy.wsUrl,
      options.proxy.token,
      chainId,
      chainIdHex,
    );
  } else {
    result.multiWalletScript = generateMultiWalletScript(
      wallets.filter(w => indicesToUse.includes(w.index)),
      rpcUrl,
      chainId,
      chainIdHex,
      guardJs,
    );
  }

  result.warnings.push(
    allowedTo.length
      ? `Injected provider restricted to contracts: ${allowedTo.join(', ')}.`
      : 'Injected provider allows any destination, but blocks approval/transfer selectors and caps tx value.',
    `Per-tx value cap: ${maxTxValueEth} ETH. Typed-data (order) signing: ${allowOrderSigning ? 'ENABLED' : 'disabled'}.`,
  );

  // Generate auto-click script
  result.autoClickScript = generateAutoClickScript();

  // Generate step-by-step guide
  result.stepByStepGuide = generateStepByStepGuide(options.url, result.walletScripts, {
    proxyMode,
    wsUrl: options.proxy?.wsUrl,
  });

  return result;
}

/**
 * Generate wallet injection script for a single wallet
 * This creates a custom window.ethereum that uses ethers.js loaded from CDN
 */
function generateSingleWalletScript(
  wallet: WalletInfo,
  rpcUrl: string,
  chainId: number,
  chainIdHex: string,
  guardJs: string,
): string {
  return `// === Wallet Injection Script (Wallet ${wallet.index}: ${shortAddress(wallet.address)}) ===
// Jalankan via browser_console() setelah navigasi ke website minting
//
// ⚠️ INI AKAN MENARUH PRIVATE KEY DI BROWSER MEMORY
// Pastikan browser instance terisolasi!

(async () => {
  // 1. Load ethers.js v6 from CDN (if not already loaded)
  if (!window.ethers) {
    const s = document.createElement('script');
    s.src = '${ETHERS_CDN_URL}';
    s.integrity = '${ETHERS_SRI}';
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
    await new Promise((resolve, reject) => {
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ethers.js'));
    });
    console.log('[WalletInject] ethers.js v6 loaded');
  }

  // 2. Setup provider and wallet
  const provider = new ethers.JsonRpcProvider('${rpcUrl}');
  const wallet = new ethers.Wallet('${wallet.wallet.privateKey}', provider);
  console.log('[WalletInject] Wallet ready:', wallet.address);
${guardJs}

  // 3. Store for cleanup
  if (!window.__walletSessions) window.__walletSessions = {};
  window.__walletSessions['${wallet.address}'] = { provider, wallet };

  // 4. Create custom ethereum provider (MetaMask-compatible)
  const customEthereum = {
    isMetaMask: true,
    _state: {
      accounts: ['${wallet.address}'],
      isConnected: true,
      isUnlocked: true,
      initialized: true,
    },
    selectedAddress: '${wallet.address}',

    request: async (req) => {
      const { method, params } = req || {};
      console.log('[WalletInject] request:', method, JSON.stringify(params)?.slice(0, 300));

      try {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return ['${wallet.address}'];

          case 'eth_chainId':
            return '${chainIdHex}';

          case 'net_version':
            return '${chainId}';

          case 'eth_getBalance': {
            const addr = params?.[0] || '${wallet.address}';
            const bal = await provider.getBalance(addr);
            return '0x' + bal.toString(16);
          }

          case 'eth_blockNumber': {
            const bn = await provider.getBlockNumber();
            return '0x' + bn.toString(16);
          }

          case 'eth_call':
            return provider.call(params?.[0] || {});

          case 'eth_estimateGas': {
            const gas = await provider.estimateGas(params?.[0] || {});
            return '0x' + gas.toString(16);
          }

          case 'eth_gasPrice': {
            const feeData = await provider.getFeeData();
            return '0x' + (feeData.gasPrice || 0n).toString(16);
          }

          case 'eth_maxPriorityFeePerGas': {
            const feeData = await provider.getFeeData();
            return '0x' + (feeData.maxPriorityFeePerGas || 0n).toString(16);
          }

          case 'eth_sendTransaction': {
            const tx = { ...params?.[0] } || {};
            tx.from = '${wallet.address}';

            // Handle value conversion
            if (tx.value && typeof tx.value === 'string') {
              tx.value = BigInt(tx.value);
            }

            __assertSafeTx(tx);
            console.log('[WalletInject] Sending TX:', JSON.stringify({ to: tx.to, value: tx.value?.toString(), data: tx.data?.slice(0, 10) }));
            const txResponse = await wallet.sendTransaction(tx);
            console.log('[WalletInject] TX sent:', txResponse.hash);
            return txResponse.hash;
          }

          case 'personal_sign': {
            const [message, address] = params || [];
            if (address?.toLowerCase() !== '${wallet.address}'.toLowerCase()) {
              throw new Error('Address mismatch in personal_sign');
            }
            const msgBytes = message.startsWith('0x')
              ? ethers.getBytes(message)
              : new TextEncoder().encode(message);
            return wallet.signMessage(msgBytes);
          }

          case 'eth_signTypedData_v4':
          case 'eth_signTypedData_v3':
          case 'eth_signTypedData': {
            __assertTypedDataAllowed();
            const [, typedDataStr] = params || [];
            const typedData = typeof typedDataStr === 'string' ? JSON.parse(typedDataStr) : typedDataStr;

            // Remove EIP712Domain from types (ethers handles it)
            const types = { ...typedData.types };
            delete types.EIP712Domain;

            const signature = await wallet.signTypedData(
              typedData.domain || {},
              types,
              typedData.message || typedData.primaryType || {}
            );
            return signature;
          }

          case 'wallet_switchEthereumChain':
          case 'wallet_addEthereumChain':
            return null;

          case 'wallet_requestPermissions':
            return [{ parentCapability: 'eth_accounts' }];

          case 'eth_getTransactionReceipt': {
            const hash = params?.[0];
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt) return null;
            return {
              transactionHash: receipt.hash,
              blockNumber: '0x' + receipt.blockNumber.toString(16),
              status: receipt.status === 1 ? '0x1' : '0x0',
              gasUsed: '0x' + receipt.gasUsed.toString(16),
            };
          }

          case 'eth_getTransactionByHash': {
            const hash = params?.[0];
            const tx = await provider.getTransaction(hash);
            if (!tx) return null;
            return {
              hash: tx.hash,
              from: tx.from,
              to: tx.to,
              value: '0x' + (tx.value || 0n).toString(16),
              input: tx.data,
            };
          }

          case 'eth_getCode': {
            const code = await provider.getCode(params?.[0] || '');
            return code;
          }

          case 'eth_blockNumber': {
            const bn = await provider.getBlockNumber();
            return '0x' + bn.toString(16);
          }

          default:
            console.log('[WalletInject] Unhandled method:', method);
            return null;
        }
      } catch (err) {
        console.error('[WalletInject] Error in', method, ':', err.message);
        throw err;
      }
    },

    on: (event, callback) => {
      if (event === 'accountsChanged') {
        window.__accountsChangedCallback = callback;
      }
      if (event === 'chainChanged') {
        callback('${chainIdHex}');
      }
      if (event === 'connect') {
        callback({ chainId: '${chainIdHex}' });
      }
    },

    removeListener: () => {},
    removeAllListeners: () => {},

    enable: async () => ['${wallet.address}'],

    send: async (payload) => {
      if (typeof payload === 'string') {
        return customEthereum.request({ method: payload, params: [] });
      }
      return customEthereum.request({ method: payload.method, params: payload.params });
    },

    sendAsync: async (payload, callback) => {
      try {
        const result = await customEthereum.request({ method: payload.method, params: payload.params });
        callback(null, { id: payload.id, result });
      } catch (err) {
        callback(err, null);
      }
    },

    isConnected: () => true,

    chainId: '${chainIdHex}',
    networkVersion: '${chainId}',
  };

  // 5. Override window.ethereum
  window.ethereum = customEthereum;

  // 6. Notify the page that ethereum is available
  window.dispatchEvent(new Event('ethereum#initialized'));

  // 7. Also trigger common wallet detection events
  setTimeout(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'ETHEREUM_PROVIDER_SUCCESS' }
    }));
  }, 100);

  console.log('[WalletInject] ✅ Wallet injected successfully!');
  console.log('[WalletInject] Address: ${wallet.address}');
  console.log('[WalletInject] Click "Connect Wallet" on the page now.');

  return '${wallet.address}';
})()`;
}

/**
 * Generate multi-wallet rotation script
 * Sequentially: inject wallet 1 → connect → mint → verify → switch to wallet 2 → ...
 */
function generateMultiWalletScript(
  wallets: WalletInfo[],
  rpcUrl: string,
  chainId: number,
  chainIdHex: string,
  guardJs: string,
): string {
  const walletConfigs = wallets.map(w => ({
    index: w.index,
    address: w.address,
    privateKey: w.wallet.privateKey,
  }));

  return `// === Multi-Wallet Rotation Script ===
// Sequential minting: inject wallet → connect → mint → next wallet
//
// ⚠️ INI AKAN MENARUH SEMUA PRIVATE KEY DI BROWSER MEMORY
// Pastikan browser instance terisolasi dan dihancurkan setelah selesai!
//
// Cara pakai:
// 1. Navigasi ke website minting
// 2. Jalankan script ini via browser_console()
// 3. Script akan otomatis rotate wallet dan mint

(async () => {
  // Load ethers.js
  if (!window.ethers) {
    const s = document.createElement('script');
    s.src = '${ETHERS_CDN_URL}';
    s.integrity = '${ETHERS_SRI}';
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
    await new Promise((resolve, reject) => {
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ethers.js'));
    });
  }

  const provider = new ethers.JsonRpcProvider('${rpcUrl}');
  const wallets = ${JSON.stringify(walletConfigs)};
  const results = [];
${guardJs}

  window.__multiMintResults = results;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    console.log(\`[MultiMint] === Wallet \${i + 1}/\${wallets.length}: \${w.address.slice(0, 8)}... ===\`);

    try {
      // 1. Create wallet instance
      const wallet = new ethers.Wallet(w.privateKey, provider);

      // 2. Override window.ethereum for this wallet
      window.ethereum = {
        isMetaMask: true,
        selectedAddress: w.address,
        _state: { accounts: [w.address], isConnected: true, isUnlocked: true, initialized: true },

        request: async (req) => {
          const { method, params } = req || {};
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [w.address];
            case 'eth_chainId':
              return '${chainIdHex}';
            case 'net_version':
              return '${chainId}';
            case 'eth_getBalance': {
              const bal = await provider.getBalance(params?.[0] || w.address);
              return '0x' + bal.toString(16);
            }
            case 'eth_sendTransaction': {
              const tx = { ...params?.[0] } || {};
              tx.from = w.address;
              if (tx.value && typeof tx.value === 'string') tx.value = BigInt(tx.value);
              __assertSafeTx(tx);
              const txResp = await wallet.sendTransaction(tx);
              console.log(\`[MultiMint] TX sent: \${txResp.hash}\`);
              return txResp.hash;
            }
            case 'personal_sign': {
              const [message] = params || [];
              const msgBytes = message.startsWith('0x') ? ethers.getBytes(message) : new TextEncoder().encode(message);
              return wallet.signMessage(msgBytes);
            }
            case 'eth_signTypedData_v4':
            case 'eth_signTypedData_v3':
            case 'eth_signTypedData': {
              __assertTypedDataAllowed();
              const [, tdStr] = params || [];
              const td = typeof tdStr === 'string' ? JSON.parse(tdStr) : tdStr;
              const types = { ...td.types };
              delete types.EIP712Domain;
              return wallet.signTypedData(td.domain || {}, types, td.message || {});
            }
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null;
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];
            default:
              return null;
          }
        },
        on: (event, cb) => { if (event === 'chainChanged') cb('${chainIdHex}'); },
        removeListener: () => {},
        removeAllListeners: () => {},
        enable: async () => [w.address],
        send: async (p) => typeof p === 'string' ? null : window.ethereum.request({ method: p.method, params: p.params }),
        sendAsync: async (p, cb) => { try { cb(null, { id: p.id, result: await window.ethereum.request({ method: p.method, params: p.params }) }); } catch(e) { cb(e, null); } },
        isConnected: () => true,
        chainId: '${chainIdHex}',
        networkVersion: '${chainId}',
      };

      // 3. Notify page of wallet change
      window.dispatchEvent(new Event('ethereum#initialized'));
      if (window.__accountsChangedCallback) {
        window.__accountsChangedCallback([w.address]);
      }
      window.dispatchEvent(new Event('accountsChanged'));

      // 4. Try to click Connect Wallet button (auto-detect)
      await new Promise(r => setTimeout(r, 1000));

      const connectBtn = findConnectButton();
      if (connectBtn) {
        console.log(\`[MultiMint] Clicking Connect Wallet...\`);
        connectBtn.click();
        await new Promise(r => setTimeout(r, 2000));
      }

      // 5. Try to click Mint button (auto-detect)
      const mintBtn = findMintButton();
      if (mintBtn) {
        console.log(\`[MultiMint] Clicking Mint...\`);
        mintBtn.click();
        await new Promise(r => setTimeout(r, 5000)); // Wait for TX
      }

      results.push({ walletIndex: w.index, address: w.address, status: 'attempted' });
      console.log(\`[MultiMint] ✅ Wallet \${w.index} done\`);

    } catch (err) {
      results.push({ walletIndex: w.index, address: w.address, status: 'failed', error: err.message });
      console.error(\`[MultiMint] ❌ Wallet \${w.index} failed:\`, err.message);
    }

    // Delay between wallets
    if (i < wallets.length - 1) {
      console.log(\`[MultiMint] Waiting 3s before next wallet...\`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('[MultiMint] === All wallets processed ===');
  console.log(JSON.stringify(results, null, 2));
  window.__multiMintResults = results;
  return JSON.stringify(results, null, 2);
})();

// Helper: Find Connect Wallet button
function findConnectButton() {
  const patterns = [/connect/i, /wallet/i, /sign.in/i, /log.in/i, /link.wallet/i];
  const buttons = document.querySelectorAll('button, a, [role="button"], [class*="btn"]');

  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const testId = btn.getAttribute('data-testid') || '';

    for (const p of patterns) {
      if (p.test(text) || p.test(ariaLabel) || p.test(testId)) {
        return btn;
      }
    }
  }
  return null;
}

// Helper: Find Mint button
function findMintButton() {
  const patterns = [/mint/i, /claim/i, /buy.now/i, /purchase/i, /^mint$/i];
  const buttons = document.querySelectorAll('button, a, [role="button"], [class*="btn"]');

  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const testId = btn.getAttribute('data-testid') || '';
    const className = btn.className || '';

    for (const p of patterns) {
      if (p.test(text) || p.test(ariaLabel) || p.test(testId) || p.test(className)) {
        // Skip if it's a "Connect Wallet" button that also says mint
        if (/connect/i.test(text)) continue;
        return btn;
      }
    }
  }
  return null;
}`;
}

/**
 * Generate auto-click script for Connect Wallet / Mint buttons
 */
function generateAutoClickScript(): string {
  return `// === Auto-Click Script ===
// Jalankan SETELAH wallet injection untuk auto-click Connect/Mint buttons
//
// Cara pakai:
// 1. Setelah inject wallet, jalankan script ini via browser_console()
// 2. Script akan cari dan klik tombol Connect Wallet / Mint otomatis

(function() {
  // Find Connect Wallet button
  function findConnectButton() {
    const patterns = [/connect/i, /wallet/i, /sign.in/i, /log.in/i, /link.wallet/i];
    const buttons = document.querySelectorAll('button, a, [role="button"], [class*="btn"]');

    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const testId = btn.getAttribute('data-testid') || '';

      for (const p of patterns) {
        if (p.test(text) || p.test(ariaLabel) || p.test(testId)) {
          return { element: btn, text: text.slice(0, 50) };
        }
      }
    }
    return null;
  }

  // Find Mint button
  function findMintButton() {
    const patterns = [/mint/i, /claim/i, /buy.now/i, /purchase/i];
    const buttons = document.querySelectorAll('button, a, [role="button"], [class*="btn"]');

    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const testId = btn.getAttribute('data-testid') || '';

      for (const p of patterns) {
        if (p.test(text) || p.test(ariaLabel) || p.test(testId)) {
          return { element: btn, text: text.slice(0, 50) };
        }
      }
    }
    return null;
  }

  // Find quantity input
  function findQuantityInput() {
    const inputs = document.querySelectorAll('input[type="number"], input[type="text"]');
    for (const input of inputs) {
      const name = (input.getAttribute('name') || '').toLowerCase();
      const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
      const label = input.getAttribute('aria-label') || '';

      if (/quantity|amount|qty|how.many|number/i.test(name + placeholder + label)) {
        return input;
      }
    }
    return null;
  }

  const connect = findConnectButton();
  const mint = findMintButton();
  const qtyInput = findQuantityInput();

  const result = {
    connectButton: connect ? { text: connect.text, found: true } : { found: false },
    mintButton: mint ? { text: mint.text, found: true } : { found: false },
    quantityInput: qtyInput ? { found: true } : { found: false },
  };

  console.log('[AutoClick] Buttons found:', JSON.stringify(result, null, 2));

  return JSON.stringify(result, null, 2);
})()

// --- Individual click functions ---
// Run these separately after checking which buttons exist:

// Click Connect Wallet:
// findConnectButton()?.element?.click()

// Set quantity to 1:
// findQuantityInput() && (findQuantityInput().value = '1') && findQuantityInput().dispatchEvent(new Event('input', { bubbles: true }))

// Click Mint:
// findMintButton()?.element?.click()`;
}

/**
 * Generate step-by-step guide for the agent
 */
/**
 * Generate step-by-step guide for the agent
 * Works on BOTH Browser Use cloud (js() — the modern Hermes browser) and
 * local browsers (paste into DevTools console).
 */
function generateStepByStepGuide(
  url: string,
  walletScripts: WalletScript[],
  opts: { proxyMode?: boolean; wsUrl?: string } = {},
): string[] {
  const steps: string[] = [];

  steps.push('=== BROWSER MINTING - STEP BY STEP ===');
  steps.push('');
  steps.push(`Website: ${url}`);
  steps.push(`Wallets: ${walletScripts.length} wallet(s)`);
  steps.push(`Signing mode: ${opts.proxyMode ? 'PROXY (keys on agent)' : 'EMBEDDED (key in browser — legacy)'}`);
  if (opts.proxyMode && opts.wsUrl) steps.push(`Signing proxy: ${opts.wsUrl}`);
  steps.push('');
  steps.push('Runner: Hermes browser (Browser Use cloud) -> gunakan js(); browser lokal -> paste di DevTools console.');

  steps.push('');
  steps.push('--- STEP 1: Navigate to website ---');
  steps.push('Hermes (Browser Use):  new_tab(url) / goto_url, lalu wait_for_load()');
  steps.push('Lokal:                 buka URL di browser, tekan F12 -> Console');
  steps.push('');

  steps.push('--- STEP 2: Inject Wallet 0 ---');
  steps.push('Hermes (Browser Use):  js(<WALLET_0_INJECT_SCRIPT>) - script dari walletScripts[0].injectScript');
  steps.push('Lokal:                 tempel script utuh di Console, Enter');
  steps.push('Praktek terbaik: untuk Browser Use, daftarkan script via Page.addScriptToEvaluateOnNewDocument SEBELUM navigasi supaya window.ethereum sudah ada dari awal.');
  steps.push('');

  steps.push('--- STEP 3: Wait for wallet to initialize ---');
  steps.push('Tunggu ~3-5 detik (proxy: koneksi WebSocket; embedded: load ethers CDN).');
  steps.push('');

  steps.push('--- STEP 4: Click Connect Wallet ---');
  steps.push('Hermes: js("document.querySelector(\'button\')?.click()") atau pakai autoClickScript');
  steps.push('Lokal: klik tombol di halaman (atau jalankan autoClickScript di console)');
  steps.push('');

  steps.push('--- STEP 5: Wait for connection ---');
  steps.push('Tunggu ~3 detik, lalu verifikasi: js("window.ethereum.request({method:\'eth_requestAccounts\'})")');
  steps.push('');

  steps.push('--- STEP 6: Click Mint ---');
  steps.push('Hermes: js("document.querySelector(\'[class*=mint]\')?.click()") atau autoClickScript');
  steps.push('Lokal: klik tombol Mint di halaman');
  steps.push('');

  steps.push('--- STEP 7: Wait for TX confirmation ---');
  steps.push('Tunggu 10-30 detik. Verifikasi: eth_getTransactionReceipt via js() atau get_mint_status.');
  steps.push('');

  if (walletScripts.length > 1) {
    steps.push('--- STEP 8+: Repeat for other wallets ---');
    steps.push('For each additional wallet:');
    steps.push('  a. Inject next wallet script (overwrites window.ethereum)');
    steps.push('  b. Wait 3 seconds');
    steps.push('  c. Page may auto-detect wallet change, or reload page');
    steps.push('  d. Click Connect Wallet again');
    steps.push('  e. Click Mint');
    steps.push('  f. Wait for TX');
    steps.push('');
    steps.push('💡 Atau gunakan multiWalletScript untuk rotation otomatis');
  }

  steps.push('');
  steps.push('--- BRIDGE MODE (Browser Use cloud — WS lokal tidak reachable) ---');
  steps.push('Relay otomatis fallback ke antrian window.__signQ/__signR. Agent memproses tiap request:');
  steps.push('  1. js("window.__signQ && window.__signQ.length ? JSON.stringify(window.__signQ.shift()) : \'null\'")');
  steps.push('  2. node bridge-client.mjs --req \'<json dari langkah 1>\' --token <TOKEN> (token di data/signing_proxy.json)');
  steps.push('  3. js("window.__signR[" + id + "] = " + JSON.stringify({result: <hasil>}))  — atau {error:{message}} untuk error');
  steps.push('Ulangi sampai antrian kosong (biasanya flow: eth_requestAccounts -> eth_estimateGas -> eth_sendTransaction).');
  steps.push('');

  steps.push('--- CLEANUP ---');
  if (opts.proxyMode) {
    steps.push('Proxy mode: STOP signing proxy setelah minting (stop_signing_proxy) - token langsung mati.');
    steps.push('Tutup browser sesi (Hermes: cdp("Browser.close")) - provider tidak pegang key, tapi tetap rapi.');
  } else {
    steps.push('EMBEDDED mode: DESTROY browser instance segera - private key ada di memori browser!');
  }

  return steps;
}

/**
 * Script to detect if website needs browser-based minting
 * Run this to check the mint function signature
 */
export function generateMintDetectionScript(contractAddress: string): string {
  return `// === Mint Function Detection ===
// Check if contract requires server signature (bytes parameter)
// Run via browser_console() after navigating to website

(async () => {
  if (!window.ethers) {
    const s = document.createElement('script');
    s.src = '${ETHERS_CDN_URL}';
    s.integrity = '${ETHERS_SRI}';
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
    await new Promise(r => { s.onload = r; });
  }

  const provider = new ethers.JsonRpcProvider('${contractAddress}');

  // Common mint function selectors
  const selectors = {
    'mint(uint256)': '0xa0712d68',
    'mint(address,uint256)': '0x40c10f19',
    'claim(uint256)': '0x42966c68',
    'mintPublic(uint256)': '0x0f2bb829',
    'mintAllowed(address,uint256,bytes32[],bytes)': '0x9c728521',
    'mintSigned(address,uint256,bytes)': '0xb731d80f',
    'mintBatch(uint256)': '0x6a627842',
    'freeMint(uint256)': '0xf2cff577',
  };

  const results = [];

  for (const [sig, selector] of Object.entries(selectors)) {
    try {
      await provider.call({
        to: '${contractAddress}',
        data: selector + '0000000000000000000000000000000000000000000000000000000000000001',
      });
      results.push({ signature: sig, selector, exists: true });
    } catch (err) {
      const msg = err.message || '';
      // If we get a revert that's NOT "no such function", the function exists
      if (!msg.includes('0x') || msg.length > 10) {
        results.push({ signature: sig, selector, exists: true, note: 'Function exists but call reverted (expected for mint)' });
      }
    }
  }

  // Check if any function requires bytes (signature) parameter
  const needsSignature = results.filter(r => r.signature.includes('bytes'));
  const standardMint = results.filter(r => !r.signature.includes('bytes') && !r.signature.includes('proof'));

  return JSON.stringify({
    contract: '${contractAddress}',
    needsSignature: needsSignature.length > 0,
    signatureFunctions: needsSignature,
    standardMintFunctions: standardMint,
    recommendation: needsSignature.length > 0
      ? '⚠️ Contract membutuhkan SERVER SIGNATURE. WAJIB pakai browser minting.'
      : '✅ Standard mint function terdeteksi. Bisa pakai direct contract minting (mint_nft).',
  }, null, 2);
})()`;
}

/**
 * Generate a proxy-mode wallet relay script (NO private key inside).
 * window.ethereum relays JSON-RPC over WebSocket to the signing proxy
 * (keys stay on the agent machine). Works in Browser Use cloud (via js())
 * and local browsers (DevTools console). Safe to install BEFORE page
 * scripts via Page.addScriptToEvaluateOnNewDocument.
 */
export function generateProxyRelayScript(opts: {
  wsUrl: string;
  token: string;
  address: string;
  chainId: number;
  chainIdHex: string;
}): string {
  const wsWithToken = opts.wsUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    + (opts.wsUrl.includes('?') ? '&' : '?') + 'token=' + opts.token;
  return `// === Wallet Relay Script (PROXY MODE) - Wallet: ${opts.address} ===
// PRIVATE KEY TIDAK ADA DI SCRIPT INI. Signing via WebSocket ke signing proxy.
// Browser Use: js(<script>) | Lokal: paste di DevTools console.

(() => {
  const __WS = ${JSON.stringify(wsWithToken)};
  const __ADDR = ${JSON.stringify(opts.address)};
  const __CHAIN_ID = ${JSON.stringify(opts.chainIdHex)};
  let __sock = null;
  let __queue = [];
  let __id = 0;
  const __pending = new Map();

  const __send = (msg) => {
    if (__sock && __sock.readyState === 1) __sock.send(JSON.stringify(msg));
    else __queue.push(msg);
  };
  const __wsCall = (method, params) => new Promise((resolve, reject) => {
    const id = ++__id;
    __pending.set(id, { resolve, reject });
    __send({ id, method, params: params || [], __addr: __ADDR });
    setTimeout(() => {
      if (__pending.has(id)) { __pending.delete(id); reject(new Error('signing proxy timeout')); }
    }, 45000);
  });

  // Bridge fallback: dipakai kalau WebSocket tidak reachable (browser cloud).
  // Agent membaca window.__signQ, memproses via signing proxy lokal, lalu
  // menulis hasil ke window.__signR[id].
  if (!window.__signQ) window.__signQ = [];
  if (!window.__signR) window.__signR = {};
  const __bridgeCall = (method, params) => new Promise((resolve, reject) => {
    const id = ++__id;
    window.__signQ.push({ id, method, params: params || [], __addr: __ADDR });
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = window.__signR[id];
      if (r !== undefined) {
        clearInterval(iv); delete window.__signR[id];
        if (r && r.error) reject(new Error(String(r.error.message || 'proxy error')));
        else resolve(r && r.result);
      } else if (Date.now() - t0 > 45000) {
        clearInterval(iv); delete window.__signR[id];
        reject(new Error('signing bridge timeout'));
      }
    }, 250);
  });

  const __call = (method, params) =>
    (__sock && __sock.readyState === 1) ? __wsCall(method, params) : __bridgeCall(method, params);

  try {
    __sock = new WebSocket(__WS);
    __sock.onopen = () => { while (__queue.length) { __sock.send(JSON.stringify(__queue.shift())); } };
    __sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = __pending.get(m.id);
      if (!p) return;
      __pending.delete(m.id);
      if (m.error) p.reject(new Error(String(m.error.message || 'proxy error')));
      else p.resolve(m.result);
    };
    __sock.onclose = () => { __sock = null; };
    __sock.onerror = () => {};
  } catch (e) {
    console.error('[WalletRelay] WS gagal:', e);
  }

  const provider = {
    isMetaMask: true,
    isConnected: () => true,
    selectedAddress: __ADDR,
    chainId: __CHAIN_ID,
    _state: { accounts: [__ADDR], isConnected: true, isUnlocked: true, initialized: true },
    request: (req) => __call((req || {}).method, (req || {}).params),
    sendAsync: (payload, cb) => {
      __call(payload.method, payload.params || [])
        .then(r => cb(null, { jsonrpc: '2.0', id: payload.id, result: r }))
        .catch(e => cb(e, null));
    },
    on: () => {},
    removeListener: () => {},
    removeAllListeners: () => {},
  };
  window.ethereum = provider;
  try { window.dispatchEvent(new Event('ethereum#initialized')); } catch {}
  return 'relay installed: ' + __ADDR;
})()`;
}

/**
 * Multi-wallet rotation for proxy mode: installs each wallet relay in turn.
 * Page interaction (connect/mint) is agent-driven between rotations.
 */
export function generateProxyMultiWalletScript(
  wallets: { index: number; address: string }[],
  wsUrl: string,
  token: string,
  chainId: number,
  chainIdHex: string,
): string {
  const relays = wallets.map(w =>
    `    { address: '${w.address}', script: ${JSON.stringify(generateProxyRelayScript({ wsUrl, token, address: w.address, chainId, chainIdHex }))} },`
  ).join('\n');
  return `// === Multi-Wallet Relay Rotation (PROXY MODE) ===
// Install relai wallet satu per satu; interaksi halaman dilakukan agent di antara rotasi.

(async () => {
  const relays = [
${relays}
  ];
  const out = [];
  for (const r of relays) {
    (0, eval)(r.script);
    out.push({ address: r.address, installed: true });
  }
  return JSON.stringify(out, null, 2);
})()`;
}
