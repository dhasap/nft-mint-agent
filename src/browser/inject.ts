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
 * IMPORTANT SECURITY NOTES:
 * - Private keys are embedded in browser memory (Browserbase cloud browser)
 * - Each wallet is injected one at a time (sequential, not parallel)
 * - Browser instance should be destroyed after use
 * - Never log private keys in console
 */

import { Config } from '../config';
import { WalletManager, WalletInfo } from '../wallet';
import { shortAddress } from '../utils';

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
  }
): BrowserMintResult {
  const wallets = walletManager.getAllWallets();
  const rpcUrl = config.rpcUrl;
  const chainId = walletManager.getChainId();
  const chainIdHex = '0x' + chainId.toString(16);
  const indicesToUse = options.walletIndices || wallets.map(w => w.index);

  const result: BrowserMintResult = {
    url: options.url,
    walletScripts: [],
    multiWalletScript: '',
    autoClickScript: '',
    stepByStepGuide: [],
    warnings: [
      'Private key akan berada di browser memory selama sesi berlangsung.',
      'Gunakan browser instance yang terisolasi (Browserbase).',
      'Hancurkan browser instance setelah selesai minting.',
      'Browser minting bersifat SEQUENTIAL (satu wallet per waktu), tidak seperti direct mint yang PARALLEL.',
    ],
  };

  // Generate per-wallet injection scripts
  for (const idx of indicesToUse) {
    const wallet = wallets.find(w => w.index === idx);
    if (!wallet) continue;

    const script = generateSingleWalletScript(wallet, rpcUrl, chainId, chainIdHex);

    result.walletScripts.push({
      walletIndex: idx,
      address: wallet.address,
      injectScript: script,
    });
  }

  // Generate multi-wallet rotation script
  result.multiWalletScript = generateMultiWalletScript(
    wallets.filter(w => indicesToUse.includes(w.index)),
    rpcUrl,
    chainId,
    chainIdHex,
  );

  // Generate auto-click script
  result.autoClickScript = generateAutoClickScript();

  // Generate step-by-step guide
  result.stepByStepGuide = generateStepByStepGuide(options.url, result.walletScripts);

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
    s.src = 'https://cdn.ethers.io/lib/ethers-6.13.4.umd.min.js';
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

            console.log('[WalletInject] Sending TX:', JSON.stringify({ to: tx.to, value: tx.value?.toString(), data: tx.data?.slice(0, 66) }));
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
    s.src = 'https://cdn.ethers.io/lib/ethers-6.13.4.umd.min.js';
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
function generateStepByStepGuide(url: string, walletScripts: WalletScript[]): string[] {
  const steps: string[] = [];

  steps.push('=== BROWSER MINTING - STEP BY STEP ===');
  steps.push('');
  steps.push(`Website: ${url}`);
  steps.push(`Wallets: ${walletScripts.length} wallet(s)`);
  steps.push('');

  steps.push('--- STEP 1: Navigate to website ---');
  steps.push(`browser_navigate(url="${url}")`);
  steps.push('');

  steps.push('--- STEP 2: Wait for page to load ---');
  steps.push('browser_wait(duration=5)');
  steps.push('');

  steps.push('--- STEP 3: Inject Wallet 0 ---');
  steps.push(`browser_console(expression="<WALLET_0_INJECT_SCRIPT>")`);
  steps.push('💡 Copy the inject script from walletScripts[0].injectScript');
  steps.push('');

  steps.push('--- STEP 4: Wait for wallet to initialize ---');
  steps.push('browser_wait(duration=3)');
  steps.push('');

  steps.push('--- STEP 5: Click Connect Wallet ---');
  steps.push('Run auto-click script to find buttons, then click Connect');
  steps.push('browser_console(expression="document.querySelector(\'button\')?.click()")');
  steps.push('💡 Or use autoClickScript to find the right button');
  steps.push('');

  steps.push('--- STEP 6: Wait for connection ---');
  steps.push('browser_wait(duration=3)');
  steps.push('');

  steps.push('--- STEP 7: Click Mint ---');
  steps.push('browser_console(expression="document.querySelector(\'[class*=mint]\')?.click()")');
  steps.push('💡 Or use autoClickScript to find the Mint button');
  steps.push('');

  steps.push('--- STEP 8: Wait for TX confirmation ---');
  steps.push('browser_wait(duration=10)');
  steps.push('');

  if (walletScripts.length > 1) {
    steps.push('--- STEP 9+: Repeat for other wallets ---');
    steps.push('For each additional wallet:');
    steps.push('  a. Inject next wallet script (overwrites window.ethereum)');
    steps.push('  b. Wait 3 seconds');
    steps.push('  c. Page may auto-detect wallet change, or reload page');
    steps.push('  d. Click Connect Wallet again');
    steps.push('  e. Click Mint');
    steps.push('  f. Wait for TX');
    steps.push('');
    steps.push('💡 Or use multiWalletScript for automatic rotation');
  }

  steps.push('');
  steps.push('--- CLEANUP ---');
  steps.push('Destroy browser instance after minting to clear private keys from memory');

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
    s.src = 'https://cdn.ethers.io/lib/ethers-6.13.4.umd.min.js';
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
