/**
 * Signing Proxy Server — WebSocket signing service for browser minting.
 *
 * Private keys stay HERE (on the agent machine). The injected browser provider
 * (see generateProxyRelayScript in inject.ts) relays signing requests over
 * WebSocket; this server validates every request against the same safety
 * guard as the embedded provider, signs locally, and broadcasts.
 *
 * Protocol: JSON messages, { id, method, params, __addr } (__addr = target
 * wallet address embedded in the relay script). Responses: { id, result }
 * or { id, error: { code, message } }.
 *
 * Security:
 *  - Auth token via ws URL query (?token=...), checked on connection.
 *  - Server-side guard: dangerous-selector blocklist, value cap, optional
 *    contract allowlist, chainId check — enforced BEFORE signing.
 *  - Typed-data / personal signing disabled unless ALLOW_SIGNING=true.
 *  - Binds 127.0.0.1 by default. For Browser Use cloud (remote browser),
 *    expose via a tunnel (cloudflared quick tunnel) — token + guards bound
 *    the exposure; stop the proxy after the mint.
 *
 * Env:
 *   PORT (18545), TOKEN (required), RPC_URL, CHAIN (chain name/alias),
 *   WALLET_PRIVATE_KEYS (comma), MAX_TX_VALUE_ETH (default MAX_MINT_PRICE_ETH
 *   or 0.5), ALLOWED_CONTRACTS (comma, optional), ALLOW_SIGNING (true/false),
 *   MAX_GAS_PRICE_GWEI (100), GAS_MODE (aggressive|normal|eco|custom).
 *
 * Run: node dist/browser/proxy-server.js  (npm run signing-proxy)
 */
import { WebSocketServer } from 'ws';
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { DANGEROUS_SELECTORS } from './inject';

const PORT = Number(process.env.PORT || 18545);
const TOKEN = process.env.TOKEN || '';
const RPC_URL = process.env.RPC_URL || 'https://eth-mainnet.g.alchemy.com/v2/demo';
const CHAIN = (process.env.CHAIN || 'ethereum').toLowerCase();
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, polygon: 137, arbitrum: 42161, optimism: 10, base: 8453,
  zora: 7777777, blast: 81457, robinhood: 4663,
  goerli: 5, sepolia: 11155111,
};
const CHAIN_ID = CHAIN_IDS[CHAIN] || Number(CHAIN) || 1;
const keys = (process.env.WALLET_PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const maxValueEth = Number(process.env.MAX_TX_VALUE_ETH || process.env.MAX_MINT_PRICE_ETH || 0.5);
const maxValueWei = ethers.parseEther(String(Number.isFinite(maxValueEth) ? maxValueEth : 0.5));
const allowedTo = (process.env.ALLOWED_CONTRACTS || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^0x[a-f0-9]{40}$/.test(s));
const allowSigning = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_SIGNING || '').toLowerCase());
const maxGasGwei = Number(process.env.MAX_GAS_PRICE_GWEI || 100);
const gasMode = String(process.env.GAS_MODE || 'aggressive').toLowerCase();
const prioByMode: Record<string, string> = { eco: '1', normal: '2', aggressive: '5', custom: process.env.CUSTOM_PRIORITY_GWEI || '5' };

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
const wallets = keys.map(k => new ethers.Wallet(k, provider));

// ── Pure validation (exported for unit tests) ───────────────────────────────
export interface TxLike {
  to?: string | null;
  data?: string | null;
  input?: string | null;
  value?: string | bigint | number | null;
  from?: string | null;
}

export function validateTxRequest(
  tx: TxLike,
  opts: { chainId: number; maxValueWei: bigint; allowedTo: string[]; walletAddress: string },
): { ok: true; to: string; data: string; value: bigint } | { ok: false; error: string } {
  const { chainId, maxValueWei, allowedTo, walletAddress } = opts;
  if (!tx || typeof tx !== 'object') return { ok: false, error: 'tx is required' };
  if (tx.from && String(tx.from).toLowerCase() !== walletAddress.toLowerCase()) {
    return { ok: false, error: `from mismatch: relay wallet is ${walletAddress}, tx.from is ${tx.from}` };
  }
  const to = String(tx.to || '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return { ok: false, error: 'tx.to must be a valid address' };
  const toL = to.toLowerCase();
  if (allowedTo.length && !allowedTo.includes(toL)) {
    return { ok: false, error: `BLOCKED: destination ${to} is not in the allowed mint-contract list.` };
  }
  const data = String(tx.data || tx.input || '0x');
  if (data && data !== '0x') {
    const selector = data.slice(0, 10).toLowerCase();
    if (DANGEROUS_SELECTORS[selector]) {
      return { ok: false, error: `BLOCKED dangerous call ${DANGEROUS_SELECTORS[selector]} (${selector}): could drain the wallet and is never required to mint.` };
    }
  }
  let value: bigint;
  try {
    value = tx.value === undefined || tx.value === null || tx.value === ''
      ? 0n
      : (typeof tx.value === 'bigint' ? tx.value : BigInt(String(tx.value)));
  } catch {
    return { ok: false, error: `tx.value unparseable: ${String(tx.value).slice(0, 60)}` };
  }
  if (value > maxValueWei) {
    return { ok: false, error: `BLOCKED: tx value ${value.toString()} wei exceeds the configured cap ${maxValueWei.toString()} wei.` };
  }
  return { ok: true, to, data, value };
}

// ── Request handling ────────────────────────────────────────────────────────
const READ_PASSTHROUGH = new Set([
  'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getCode', 'eth_call', 'eth_estimateGas',
  'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_syncing',
  'web3_clientVersion', 'eth_chainId', 'net_version', 'eth_protocolVersion',
]);

async function handleRequest(method: string, params: any[], addr: string, id: number): Promise<any> {
  // Resolve target wallet by address (from the relay script's __addr).
  const wallet = wallets.find(w => w.address.toLowerCase() === String(addr).toLowerCase());
  if (!wallet) throw new Error(`wallet ${String(addr).slice(0, 10)}... not configured on the signing proxy`);

  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [wallet.address];

    case 'eth_chainId':
      return '0x' + CHAIN_ID.toString(16);
    case 'net_version':
      return String(CHAIN_ID);

    case 'wallet_switchEthereumChain': {
      const target = params?.[0]?.chainId;
      if (String(target).toLowerCase() === '0x' + CHAIN_ID.toString(16)) return null;
      throw Object.assign(new Error(`chain ${target} not supported; proxy is on chainId ${CHAIN_ID}`), { code: 4902 });
    }

    case 'eth_sendTransaction': {
      const tx = params?.[0] || {};
      const v = validateTxRequest(tx, { chainId: CHAIN_ID, maxValueWei, allowedTo, walletAddress: wallet.address });
      if (!v.ok) throw new Error(v.error);

      // Server-authoritative gas (EIP-1559), capped; generous upfront limit.
      const [feeData, block, nonce] = await Promise.all([
        provider.getFeeData(),
        provider.getBlock('latest').catch(() => null),
        provider.getTransactionCount(wallet.address, 'pending'),
      ]);
      const baseFee = block?.baseFeePerGas || feeData.gasPrice || ethers.parseUnits('20', 'gwei');
      const prioBase = ethers.parseUnits(prioByMode[gasMode] || '5', 'gwei');
      let priority = feeData.maxPriorityFeePerGas || prioBase;
      if (priority < prioBase) priority = prioBase;
      const mult = gasMode === 'eco' ? 1.25 : gasMode === 'normal' ? 2 : gasMode === 'custom' ? Number(process.env.CUSTOM_GAS_MULTIPLIER || 3) : 4;
      let maxFee = BigInt(Math.ceil(Number(baseFee) * mult)) + priority;
      const cap = ethers.parseUnits(String(maxGasGwei), 'gwei');
      if (maxFee > cap) maxFee = cap;
      if (priority > maxFee) priority = maxFee > 0n ? maxFee : 1n;
      if (priority <= 0n) priority = 1n;

      let gasLimit: bigint;
      try {
        gasLimit = await provider.estimateGas({ from: wallet.address, to: v.to, data: v.data, value: v.value });
        gasLimit = (gasLimit * 125n) / 100n; // +25% buffer
      } catch {
        gasLimit = 650000n; // conservative fallback; unused gas is refunded
      }
      const txReq = {
        type: 2 as const, chainId: CHAIN_ID, to: v.to, data: v.data, value: v.value,
        nonce, gasLimit,
        maxFeePerGas: maxFee, maxPriorityFeePerGas: priority,
      };
      const raw = await wallet.signTransaction(txReq);
      const sent = await provider.broadcastTransaction(raw);
      console.error(`[SigningProxy] tx ${sent.hash} wallet ${wallet.address.slice(0, 10)} value ${ethers.formatEther(v.value)} ETH`);
      return sent.hash;
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
    case 'personal_sign':
    case 'eth_sign':
      if (!allowSigning) {
        throw new Error(`BLOCKED: ${method} is disabled on the signing proxy (ALLOW_SIGNING=false). A typed-data/permit signature can authorize asset transfers.`);
      }
      {
        const data = method === 'personal_sign' ? params?.[0] : method === 'eth_sign' ? params?.[1] : params?.[1];
        const sig = await wallet.signMessage(String(data ?? ''));
        return sig;
      }

    default:
      if (READ_PASSTHROUGH.has(method)) {
        // Read-only passthrough (raw JSON-RPC).
        return provider.send(method, params ?? []);
      }
      throw new Error(`method not allowed on signing proxy: ${method}`);
  }
}

// ── Server ──────────────────────────────────────────────────────────────────
// Guarded: only start the listener when run directly (node .../proxy-server.js).
// When imported (unit tests / tool layer), expose only the pure validation.
let isMain = false;
try { isMain = typeof require !== 'undefined' && require.main === module; } catch { /* ESM env */ }

if (isMain) {
  if (!TOKEN) {
    console.error('Signing proxy: TOKEN env required. Refusing to start without auth token.');
    process.exit(1);
  }
  if (!keys.length) {
    console.error('Signing proxy: WALLET_PRIVATE_KEYS empty. Refusing to start.');
    process.exit(1);
  }

  // HTTP origin + WS upgrade: cloudflared proxies both transparently
  // (a pure ws:// origin misbehaves through quick tunnels).
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'nft-mint-agent signing proxy', chain: CHAIN, chainId: CHAIN_ID }));
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) {
      console.error('[SigningProxy] rejected connection: bad token');
      ws.close(4001, 'bad token');
      return;
    }
    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const { id, method, params, __addr } = msg || {};
      if (!id || !method) return;
      try {
        const result = await handleRequest(method, Array.isArray(params) ? params : [], __addr || wallets[0]?.address || '', id);
        ws.send(JSON.stringify({ id, result }));
      } catch (e: any) {
        const code = e?.code || -32603;
        ws.send(JSON.stringify({ id, error: { code, message: String(e?.message || e).slice(0, 300) } }));
      }
    });
  });

  httpServer.listen(PORT, '127.0.0.1');
  console.error(`[SigningProxy] ready on ws://127.0.0.1:${PORT} | chain ${CHAIN} (${CHAIN_ID}) | ${wallets.length} wallet(s) | value cap ${ethers.formatEther(maxValueWei)} ETH | allowedTo ${allowedTo.length ? allowedTo.join(',') : '(any, selector-blocklist applies)'} | ALLOW_SIGNING=${allowSigning}`);
  console.error(`[SigningProxy] token: ${TOKEN.slice(0, 8)}... (${TOKEN.length} chars)`);
}
