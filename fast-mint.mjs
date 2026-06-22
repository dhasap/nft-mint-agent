#!/usr/bin/env node
/**
 * Competitive SeaDrop fast-mint runner (v2 — low-latency).
 *
 * Latency optimizations vs v1:
 * - PRE-SIGN in parallel BEFORE target time (only network I/O happens at T0).
 * - MULTI-RPC fan-out broadcast (send raw tx to every RPC at once, first win).
 * - RBF auto re-broadcast: if a tx is not mined within N ms, bump gas (same nonce) and resend.
 * - CLOCK calibration against RPC server `Date` header so broadcast timing matches real time.
 * - Higher, mode-scaled priority fee so the tx is ordered near the front of the block.
 *
 * Goals (unchanged):
 * - No agent/scheduler/estimateGas delay at mint time.
 * - Use live on-chain SeaDrop price/max, not stale OpenSea UI/SSR.
 * - Never silently lower gas to fit low wallet balance; skip/warn instead.
 * - Output all times in WIB (Asia/Jakarta).
 *
 * Examples:
 *   node fast-mint.mjs --contract 0xNFT --time 2026-06-07T16:00:51Z --qty max --wallets 0,1
 *   node fast-mint.mjs --url https://opensea.io/collection/plop-fun/overview --time auto --qty max --gas-mode aggressive
 *   node fast-mint.mjs --contract 0xNFT --status
 *
 * New flags:
 *   --priority-gwei <n>      Priority (tip) fee. Defaults are now mode-scaled & higher.
 *   --max-fee-gwei <n>       Hard cap for maxFeePerGas.
 *   --max-price-eth <n>      Hard cap for per-unit mint price (aborts if exceeded).
 *                            Defaults to MAX_MINT_PRICE_ETH env or 0.5 ETH.
 *   --rbf-after-ms <n>       Re-broadcast with bumped gas if unmined after this (default 13000 = ~1 ETH block).
 *   --rbf-max <n>            Max RBF bumps per wallet (default 4).
 *   --rbf-bump <f>           Gas bump factor per RBF (default 1.18 = +18%).
 *   --presign-lead-ms <n>    How early to pre-sign attempt #1 before broadcast (default 1500).
 *   --no-clock-sync          Disable RPC clock calibration.
 *   --clock-offset-ms <n>    Manual clock offset (serverTime - localTime), overrides calibration.
 *   --broadcast-rpcs a,b,c   Extra RPC URLs for fan-out broadcast (or env BROADCAST_RPC_URLS).
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { gasParamsFrom, bumpGas, defaultGasLimit as libDefaultGasLimit, shouldFireOnBlock } from './lib/fastmint-gas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const OPENSEA_COLLECTION_RE = /opensea\.io\/collection\/([a-zA-Z0-9_-]+)/;
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

const SEADROP_CANDIDATES = {
  1: [
    '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    '0x00005ea67ac36d4aa7f7be4d33385971bae75dee',
  ],
  8453: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  10: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  137: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  42161: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
};

const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns (bool)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  'error IncorrectPayment(uint256 got,uint256 want)',
  'error MintQuantityExceedsMaxSupply(uint256 total,uint256 maxSupply)',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 allowed)',
  'error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)',
];

const NFT_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
];

const iface = new ethers.Interface(SEADROP_ABI);
const nftIface = new ethers.Interface(NFT_ABI);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else if (!out._) out._ = [a];
    else out._.push(a);
  }
  // Backward compatibility: node fast-mint.mjs <target_iso> <quantity> [stage]
  if (out._?.length && !out.time && !out.contract && !out.url) {
    out.time = out._[0];
    out.qty = out._[1] || '1';
    out.stage = out._[2] || 'unknown';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function wib(dateLike = new Date()) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} WIB`;
}
function line(ch = '═', n = 72) { return ch.repeat(n); }
function shortAddr(a) { return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-'; }
function shortTx(h) { return h ? `${h.slice(0, 10)}...${h.slice(-8)}` : '-'; }
function eth(v, digits = 8) { return Number(ethers.formatEther(v)).toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''); }
function gwei(v, digits = 4) { return Number(ethers.formatUnits(v, 'gwei')).toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowMs() { return Date.now(); }
function asBool(v) { return v === true || v === 'true' || v === '1' || v === 'yes'; }
function decodeErr(e) {
  const data = e?.data || e?.info?.error?.data;
  if (data) {
    try {
      const parsed = iface.parseError(data);
      return `${parsed.name}(${parsed.args.map(x => x.toString()).join(', ')})`;
    } catch {}
  }
  return (e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 300);
}
async function retry(fn, label, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = decodeErr(e);
      if (i < attempts && /missing response|timeout|429|rate|temporarily|network|server|ECONN/i.test(msg)) {
        console.log(`⚠️ RPC ${label} gagal (${msg}) — retry ${i + 1}/${attempts}`);
        await sleep(500 * i);
        continue;
      }
      throw e;
    }
  }
  throw last;
}
function parseList(s, fallback) {
  if (s === undefined || s === true || s === '') return fallback;
  return String(s).split(',').map(x => x.trim()).filter(Boolean).map(Number);
}
function parseStrList(s, fallback) {
  if (s === undefined || s === true || s === '') return fallback;
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}
function min(a, b) { return a < b ? a : b; }
function max(a, b) { return a > b ? a : b; }

// ── Clock calibration ────────────────────────────────────────────────────────
// Measures offset between local wall-clock and the RPC server's clock (NTP-synced
// in practice) using the HTTP `Date` response header, compensating for RTT/2.
// Returns offsetMs where realTime ≈ Date.now() + offsetMs.
async function calibrateClock(rpcUrl, samples = 6) {
  const offsets = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'eth_blockNumber', params: [] }),
      });
      const t1 = Date.now();
      const dateHdr = res.headers.get('date');
      if (!dateHdr) continue;
      const serverMs = Date.parse(dateHdr);
      if (Number.isNaN(serverMs)) continue;
      // Server header is whole-second; midpoint of request window approximates serverMs.
      const localMid = (t0 + t1) / 2;
      offsets.push(serverMs - localMid);
      await res.text().catch(() => {});
    } catch {}
    await sleep(60);
  }
  if (offsets.length < 3) return { offsetMs: 0, samples: offsets.length, ok: false };
  offsets.sort((a, b) => a - b);
  // median (robust to outliers)
  const median = offsets[Math.floor(offsets.length / 2)];
  return { offsetMs: Math.round(median), samples: offsets.length, ok: true };
}

// ── Multi-RPC broadcast fan-out (raw eth_sendRawTransaction + keep-alive) ─────
// Direct node:http(s) JSON-RPC with persistent keep-alive sockets. This skips the
// ethers provider overhead on the hot path and lets us PRE-WARM the TCP/TLS
// connection so the broadcast at T0 only pays one round-trip, not a handshake.
function makeBroadcastEndpoints(primaryUrl) {
  const extra = parseStrList(args['broadcast-rpcs'] ?? process.env.BROADCAST_RPC_URLS, []);
  const urls = [primaryUrl, ...extra].filter((u, i, arr) => u && arr.indexOf(u) === i);
  return urls.map(u => {
    const isHttps = u.startsWith('https');
    const AgentCls = isHttps ? https.Agent : http.Agent;
    // keepAlive reuses the socket; maxSockets>1 allows concurrent wallets per RPC.
    const agent = new AgentCls({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16 });
    return { url: u, agent };
  });
}

// Low-overhead JSON-RPC POST over a persistent socket.
function rpcPost(endpoint, method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(endpoint.url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      agent: endpoint.agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) {
            const err = new Error(j.error.message || JSON.stringify(j.error));
            err.data = j.error.data;
            reject(err);
          } else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('rpc timeout')));
    req.write(payload);
    req.end();
  });
}

// Open & warm every socket ahead of broadcast (DNS + TCP + TLS done early).
async function prewarmSockets(endpoints) {
  await Promise.all(endpoints.map(ep =>
    rpcPost(ep, 'eth_chainId', [], 4000).then(() => true).catch(() => false)
  ));
}

// Treats "already known / nonce too low / replacement underpriced" as a soft-success:
// the tx (or a better one) is already in flight, so we keep the hash we have.
function isBenignBroadcastErr(msg) {
  return /already known|alreadyknown|nonce too low|replacement transaction underpriced|known transaction|transaction underpriced/i.test(msg || '');
}

async function broadcastFanout(endpoints, raw, expectedHash, label) {
  const attempts = endpoints.map((ep) =>
    rpcPost(ep, 'eth_sendRawTransaction', [raw])
      .then(hash => ({ ok: true, hash: hash || expectedHash, url: ep.url }))
      .catch(e => {
        const msg = decodeErr(e);
        if (isBenignBroadcastErr(msg)) return { ok: true, hash: expectedHash, url: ep.url, benign: true, msg };
        return { ok: false, url: ep.url, msg };
      })
  );
  // Resolve as soon as any RPC accepts it.
  return new Promise((resolve) => {
    let settled = 0; let firstErr = null;
    for (const p of attempts) {
      p.then(r => {
        if (r.ok) return resolve(r);
        firstErr = firstErr || r;
        if (++settled === attempts.length) resolve(firstErr || { ok: false, msg: 'all RPCs failed' });
      });
    }
  });
}

async function resolveContract(input, apiKey) {
  if (!input) throw new Error('Butuh --contract 0x... atau --url OpenSea collection');
  const direct = String(input).match(ADDRESS_RE)?.[0];
  if (direct && !String(input).includes('opensea.io/collection/')) return ethers.getAddress(direct);

  const slug = String(input).match(OPENSEA_COLLECTION_RE)?.[1] || (String(input).startsWith('slug:') ? String(input).slice(5) : null);
  if (!slug) {
    if (direct) return ethers.getAddress(direct);
    throw new Error(`Tidak bisa resolve contract dari input: ${input}`);
  }

  const url = `https://api.opensea.io/api/v2/collections/${slug}`;
  const headers = { 'user-agent': 'Mozilla/5.0' };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`OpenSea API gagal ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const addr = data?.contracts?.[0]?.address;
  if (!addr) throw new Error(`OpenSea API tidak mengembalikan contract untuk slug ${slug}`);
  return ethers.getAddress(addr);
}

async function resolveSeaDrop(provider, chainId, nftContract) {
  const candidates = SEADROP_CANDIDATES[Number(chainId)] || [];
  for (const c of candidates) {
    try {
      const code = await retry(() => provider.getCode(c), `getCode ${shortAddr(c)}`);
      if (!code || code === '0x') continue;
      const sea = new ethers.Contract(c, SEADROP_ABI, provider);
      await retry(() => sea.getPublicDrop(nftContract), `getPublicDrop ${shortAddr(c)}`);
      return ethers.getAddress(c);
    } catch {}
  }
  throw new Error(`SeaDrop address tidak ditemukan/valid untuk chain ${chainId}`);
}

// gasParamsFrom + bumpGas now live in ./lib/fastmint-gas.mjs (pure + unit-tested).

function defaultGasLimit(qty) {
  // Intentionally conservative. Unused gas is refunded, but the wallet must afford upfront maxFee * gasLimit.
  const base = BigInt(args['gas-limit'] || process.env.FAST_MINT_GAS_LIMIT || '650000');
  return libDefaultGasLimit(qty, base);
}

// Build a WebSocketProvider, using the global WebSocket if present (Node 22+),
// else the optional `ws` package. Returns null if neither is available.
async function makeWsProvider(url) {
  try {
    if (typeof WebSocket !== 'undefined') return new ethers.WebSocketProvider(url);
  } catch {}
  try {
    const { default: WS } = await import('ws');
    return new ethers.WebSocketProvider(() => new WS(url));
  } catch {
    return null;
  }
}

// Resolve when it's time to broadcast. Races the calibrated timer against an
// optional WS newHeads watcher that fires once a block timestamp >= startSec.
// Always falls back to the timer if WS is unavailable or errors.
async function waitForBroadcast({ broadcastMs, realNow, startSec, wsUrl, useWs, log }) {
  const timer = (async () => {
    const wait = broadcastMs - realNow();
    if (wait > 0) await sleep(wait);
    return 'timer';
  })();

  if (!useWs || !wsUrl) {
    await timer;
    return 'timer';
  }

  let wsProvider = null;
  const wsRace = new Promise((resolve) => {
    makeWsProvider(wsUrl).then((wp) => {
      if (!wp) { log('⚠️ WS unavailable (install `ws` or use Node 22+) — using timer.'); return; }
      wsProvider = wp;
      log('🔌 WS newHeads watch armed — will fire when drop goes active on-chain.');
      wp.on('block', async (bn) => {
        try {
          const blk = await wp.getBlock(bn);
          if (blk && shouldFireOnBlock(blk.timestamp, startSec)) {
            log(`🟢 WS: block ${bn} ts ${blk.timestamp} >= start ${startSec} — drop ACTIVE.`);
            resolve('ws-active');
          }
        } catch {}
      });
    }).catch(() => {});
  });

  const who = await Promise.race([timer, wsRace]);
  try { if (wsProvider) await wsProvider.destroy(); } catch {}
  return who;
}

async function main() {
  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) throw new Error('RPC_URL belum di-set di .env');
  const keys = (process.env.WALLET_PRIVATE_KEYS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!keys.length) throw new Error('WALLET_PRIVATE_KEYS kosong di .env');

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const network = await retry(() => provider.getNetwork(), 'getNetwork');
  const chainId = Number(network.chainId);

  const input = args.contract || args.url || args.slug;
  const nftContract = await resolveContract(input, process.env.OPENSEA_API_KEY);
  const seadropAddress = args.seadrop ? ethers.getAddress(args.seadrop) : await resolveSeaDrop(provider, chainId, nftContract);
  const sea = new ethers.Contract(seadropAddress, SEADROP_ABI, provider);
  const nft = new ethers.Contract(nftContract, NFT_ABI, provider);

  // Fan-out broadcast endpoints (primary + any extras), with keep-alive sockets.
  const bcEndpoints = makeBroadcastEndpoints(RPC_URL);

  const walletIndices = parseList(args.wallets, keys.map((_, i) => i));
  const wallets = walletIndices.map(i => {
    if (!keys[i]) throw new Error(`Wallet index ${i} tidak ada di WALLET_PRIVATE_KEYS`);
    const wallet = new ethers.Wallet(keys[i], provider);
    return { index: i, wallet, address: wallet.address };
  });

  // Clock calibration (best-effort, ~±0.5s due to 1s Date header granularity).
  let clockOffsetMs = 0;
  if (args['clock-offset-ms'] !== undefined) {
    clockOffsetMs = Number(args['clock-offset-ms']) || 0;
    console.log(`🕰️ Clock offset (manual): ${clockOffsetMs} ms`);
  } else if (!asBool(args['no-clock-sync'])) {
    const cal = await calibrateClock(RPC_URL);
    clockOffsetMs = cal.ok ? cal.offsetMs : 0;
    console.log(`🕰️ Clock offset: ${clockOffsetMs} ms (${cal.ok ? cal.samples + ' samples' : 'calibration failed, using 0'})`);
  }
  const realNow = () => Date.now() + clockOffsetMs;

  let [name, symbol, drop, feeRecipients, feeData, block, totalSupply, maxSupply] = await Promise.all([
    retry(() => nft.name(), 'nft.name').catch(() => 'NFT'),
    retry(() => nft.symbol(), 'nft.symbol').catch(() => 'NFT'),
    retry(() => sea.getPublicDrop(nftContract), 'getPublicDrop'),
    retry(() => sea.getAllowedFeeRecipients(nftContract), 'getAllowedFeeRecipients').catch(() => []),
    retry(() => provider.getFeeData(), 'getFeeData'),
    retry(() => provider.getBlock('latest'), 'getBlock'),
    retry(() => nft.totalSupply(), 'totalSupply').catch(() => 0n),
    retry(() => nft.maxSupply(), 'maxSupply').catch(() => 0n),
  ]);

  // BUG FIX: getAllowedFeeRecipients returns an ethers Result. For unrestricted
  // drops it's EMPTY, and ethers v6 throws RangeError ("out of result range") on
  // out-of-bounds index access — so `feeRecipients?.[0]` crashes the whole mint
  // instead of yielding undefined. Guard with a length check.
  const firstAllowedFeeRecipient = (feeRecipients && feeRecipients.length > 0) ? feeRecipients[0] : undefined;
  let feeRecipient = args['fee-recipient'] ? ethers.getAddress(args['fee-recipient']) : (firstAllowedFeeRecipient || '0x0000a26b00c1F0DF003000390027140000fAa719');
  if (drop.restrictFeeRecipients) {
    const ok = await retry(() => sea.getFeeRecipientIsAllowed(nftContract, feeRecipient), 'feeRecipient allowed').catch(() => false);
    if (!ok) throw new Error(`Fee recipient ${feeRecipient} tidak allowed; allowed=${feeRecipients.join(',')}`);
  }

  const onchainStartMs = Number(drop.startTime) * 1000;
  const onchainEndMs = Number(drop.endTime) * 1000;
  let targetMs;
  if (args.status) targetMs = onchainStartMs;
  else if (!args.time || args.time === 'auto') targetMs = onchainStartMs;
  else {
    targetMs = Date.parse(args.time);
    if (Number.isNaN(targetMs)) throw new Error(`--time tidak valid: ${args.time}`);
  }

  const earlyMs = Number(args['early-ms'] ?? process.env.FAST_MINT_EARLY_MS ?? 750);
  const pollMs = Number(args['poll-ms'] ?? process.env.FAST_MINT_POLL_MS ?? 250);
  const presignLeadMs = Number(args['presign-lead-ms'] ?? process.env.FAST_MINT_PRESIGN_LEAD_MS ?? 1500);
  const rbfAfterMs = Number(args['rbf-after-ms'] ?? process.env.FAST_MINT_RBF_AFTER_MS ?? 13000);
  const rbfMax = Number(args['rbf-max'] ?? process.env.FAST_MINT_RBF_MAX ?? 4);
  const rbfBump = Number(args['rbf-bump'] ?? process.env.FAST_MINT_RBF_BUMP ?? 1.18);
  // SECURITY: per-unit mint price cap. Mirrors MAX_MINT_PRICE_ETH used by the
  // agent/MCP path so the competitive CLI can't silently overpay for a drop
  // whose on-chain price is inflated or changes at the last second.
  const maxPriceEth = Number(args['max-price-eth'] ?? process.env.MAX_MINT_PRICE_ETH ?? 0.5);
  const maxPriceWei = ethers.parseEther(String(Number.isFinite(maxPriceEth) ? maxPriceEth : 0.5));
  const qtyArg = String(args.qty ?? args.quantity ?? '1').toLowerCase();
  const stageName = args.stage || name;
  let latestDrop = drop;
  let latestFeeData = feeData;
  let latestBlock = block;
  let latestTotalSupply = totalSupply;

  const gas = gasParamsFrom(latestBlock?.baseFeePerGas, latestFeeData, {
    gasMode: args['gas-mode'], maxFeeGwei: args['max-fee-gwei'], priorityGwei: args['priority-gwei'],
  });

  console.log('\n' + line());
  console.log(`🚀 FAST AUTO-MINT (v2 low-latency) — ${name} (${symbol})`);
  console.log(line());
  console.log(`🕘 Sekarang       : ${wib(realNow())}`);
  console.log(`🎯 Target start   : ${wib(targetMs)} (${new Date(targetMs).toISOString()})`);
  console.log(`📤 Broadcast      : ${wib(targetMs - earlyMs)} (early ${earlyMs}ms)`);
  console.log(`✍️  Pre-sign       : ${wib(targetMs - earlyMs - presignLeadMs)} (lead ${presignLeadMs}ms)`);
  if (onchainEndMs) console.log(`🏁 End            : ${wib(onchainEndMs)}`);
  console.log(`🔗 Chain          : ${chainId}`);
  console.log(`🎨 NFT            : ${nftContract}`);
  console.log(`🌊 SeaDrop        : ${seadropAddress}`);
  console.log(`📡 Broadcast RPCs : ${bcEndpoints.length} endpoint(s)`);
  console.log(`🔁 RBF            : after ${rbfAfterMs}ms, max ${rbfMax}x, bump ${Math.round((rbfBump - 1) * 100)}%`);
  console.log(`💸 Live price     : ${ethers.formatEther(drop.mintPrice)} ETH (cap ${maxPriceEth} ETH)`);
  if (drop.mintPrice > maxPriceWei) {
    throw new Error(`Live mint price ${ethers.formatEther(drop.mintPrice)} ETH exceeds MAX_MINT_PRICE_ETH (${maxPriceEth} ETH). Aborting. Raise the cap with --max-price-eth or MAX_MINT_PRICE_ETH if intended.`);
  }
  console.log(`🎒 Max/wallet     : ${Number(drop.maxTotalMintableByWallet)}`);
  console.log(`📊 Supply         : ${totalSupply.toString()} / ${maxSupply.toString() || '?'}`);
  console.log(`⛽ Gas mode       : ${gas.mode} | maxFee ${gwei(gas.maxFeePerGas)} gwei | prio ${gwei(gas.maxPriorityFeePerGas)} gwei | cap ${gwei(gas.cap)} gwei`);
  console.log(`💰 Fee recipient  : ${shortAddr(feeRecipient)}${drop.restrictFeeRecipients ? ' (restricted)' : ''}`);

  console.log('\n👛 Wallet Plan');
  console.log(line('─'));
  // Prepare all wallets concurrently (balance, nft balance, mint stats, nonce).
  const plans = await Promise.all(wallets.map(async (w) => {
    const [balance, nftBal, stats, nonce] = await Promise.all([
      retry(() => provider.getBalance(w.address), `balance ${w.index}`),
      retry(() => nft.balanceOf(w.address), `nft balance ${w.index}`).catch(() => 0n),
      retry(() => nft.getMintStats(w.address), `mint stats ${w.index}`).catch(() => [0n, totalSupply, maxSupply]),
      retry(() => provider.getTransactionCount(w.address, 'pending'), `nonce ${w.index}`),
    ]);
    const minted = Number(stats[0] || 0n);
    const maxPerWallet = Number(drop.maxTotalMintableByWallet) || 1;
    const remainingWallet = Math.max(0, maxPerWallet - minted);
    const remainingSupply = maxSupply > 0n ? Number(maxSupply - totalSupply) : Number.MAX_SAFE_INTEGER;
    const requested = qtyArg === 'max' ? remainingWallet : Number(qtyArg);
    if (!Number.isFinite(requested) || requested < 1) throw new Error(`Quantity tidak valid: ${qtyArg}`);
    const qty = Math.max(0, Math.min(requested, remainingWallet, remainingSupply));
    const gasLimit = qty > 0 ? defaultGasLimit(qty) : 0n;
    const value = BigInt(drop.mintPrice) * BigInt(qty);
    const upfront = qty > 0 ? value + gasLimit * gas.maxFeePerGas : 0n;
    const enough = qty > 0 && balance >= upfront;
    return { ...w, balance, nftBal, minted, qty, nonce, gasLimit, value, upfront, enough };
  }));
  for (const p of plans) {
    console.log(`• Wallet ${p.index} ${shortAddr(p.address)}`);
    console.log(`  Balance ETH    : ${eth(p.balance)} ETH`);
    console.log(`  NFT balance    : ${p.nftBal.toString()} | sudah mint: ${p.minted}`);
    console.log(`  Akan mint      : ${p.qty} NFT`);
    if (p.qty > 0) console.log(`  Need upfront   : ${eth(p.upfront)} ETH (${p.enough ? 'OK' : 'KURANG'})`);
    else console.log(`  Need upfront   : - (qty 0 / sold out atau limit tercapai)`);
  }

  if (args.status) {
    console.log('\n✅ Status only — tidak kirim transaksi.');
    console.log(line() + '\n');
    return;
  }

  if (plans.every(p => p.qty <= 0)) throw new Error('Tidak ada wallet dengan quantity > 0.');

  const executable = plans.filter(p => p.qty > 0 && p.enough);
  const skipped = plans.filter(p => p.qty <= 0 || !p.enough);
  if (skipped.length) {
    console.log('\n⚠️ Wallet yang di-skip sebelum broadcast:');
    for (const p of skipped) console.log(`  • Wallet ${p.index}: ${p.qty <= 0 ? 'qty=0' : `ETH kurang; need ${eth(p.upfront)} ETH, punya ${eth(p.balance)} ETH`}`);
  }
  if (!executable.length) throw new Error('Semua wallet kurang balance/qty=0. Tidak broadcast.');

  // Keep latest drop/gas cached without blocking at submit time.
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try {
        [latestDrop, latestFeeData, latestBlock, latestTotalSupply] = await Promise.all([
          sea.getPublicDrop(nftContract), provider.getFeeData(), provider.getBlock('latest'), nft.totalSupply().catch(() => latestTotalSupply),
        ]);
      } catch {}
      await sleep(pollMs);
    }
  })();

  const broadcastMs = targetMs - earlyMs;
  const presignMs = broadcastMs - presignLeadMs;

  // 1) Wait until pre-sign window (using calibrated clock).
  if (realNow() < presignMs) {
    const wait = presignMs - realNow();
    console.log(`\n⏳ Pre-warmed. Pre-sign dalam: ${Math.floor(wait / 60000)}m ${Math.floor((wait % 60000) / 1000)}s...`);
    await sleep(wait);
  }

  // 2) PRE-SIGN attempt #1 in parallel using the latest cached drop/gas.
  //    Only network broadcast remains for T0 — signing (local CPU) is done up front.
  const liveMaxPerWallet = Number(latestDrop.maxTotalMintableByWallet) || Number(drop.maxTotalMintableByWallet) || 1;
  const livePrice = BigInt(latestDrop.mintPrice);
  // SECURITY: re-check the cap against the freshest on-chain price right before
  // we pre-sign/broadcast (price can change after startup).
  if (livePrice > maxPriceWei) {
    polling = false;
    throw new Error(`Live mint price at T0 ${ethers.formatEther(livePrice)} ETH exceeds MAX_MINT_PRICE_ETH (${maxPriceEth} ETH). Aborting before broadcast.`);
  }
  const liveGas = gasParamsFrom(latestBlock?.baseFeePerGas, latestFeeData, {
    gasMode: args['gas-mode'], maxFeeGwei: args['max-fee-gwei'], priorityGwei: args['priority-gwei'],
  });

  const signed = await Promise.all(executable.map(async (p) => {
    const qty = Math.min(p.qty, liveMaxPerWallet - p.minted);
    if (qty <= 0) return { ...p, skipped: true, error: 'qty=0 after live max update' };
    const value = livePrice * BigInt(qty);
    const upfront = value + p.gasLimit * liveGas.maxFeePerGas;
    if (p.balance < upfront) return { ...p, qty, skipped: true, error: `ETH kurang after live update; need ${eth(upfront)} ETH, punya ${eth(p.balance)} ETH` };
    const data = iface.encodeFunctionData('mintPublic', [nftContract, feeRecipient, ethers.ZeroAddress, qty]);
    const gasState = { maxFeePerGas: liveGas.maxFeePerGas, maxPriorityFeePerGas: liveGas.maxPriorityFeePerGas };
    const rawTxReq = {
      type: 2, chainId, to: seadropAddress, nonce: p.nonce, data, value,
      gasLimit: p.gasLimit, maxFeePerGas: gasState.maxFeePerGas, maxPriorityFeePerGas: gasState.maxPriorityFeePerGas,
    };
    const raw = await p.wallet.signTransaction(rawTxReq);
    const expectedHash = ethers.keccak256(raw);
    return { ...p, qty, value, gasState, rawTxReq, raw, expectedHash };
  }));

  const ready = signed.filter(s => s.raw);
  console.log(`\n✍️  Pre-signed ${ready.length} tx in parallel @ ${wib(realNow())}`);

  // 3) Keep broadcast sockets warm during the wait (periodic eth_chainId every
  //    ~20s so DNS+TCP+TLS stay established), then fire the instant the trigger
  //    resolves — no fresh handshake on the hot path.
  let warming = true;
  const warmer = (async () => {
    while (warming) {
      await prewarmSockets(bcEndpoints).catch(() => {});
      await sleep(20000);
    }
  })();

  // Trigger: either the calibrated timer OR (opt-in) a WebSocket newHeads watcher
  // that fires the moment the chain reports the drop is active — avoids both
  // `NotActive` reverts (too early) and lateness (too slow). Enable with --ws-active
  // (requires RPC_WS_URL). Default stays the proven timer path.
  const startSec = Number(latestDrop.startTime) || Number(drop.startTime) || Math.floor(targetMs / 1000);
  const fireReason = await waitForBroadcast({
    broadcastMs, realNow, startSec,
    wsUrl: process.env.RPC_WS_URL,
    useWs: asBool(args['ws-active']),
    log: (m) => console.log(m),
  });
  warming = false;

  console.log('\n' + line());
  console.log(`📨 BROADCAST RAW TX (${fireReason}, fan-out ${bcEndpoints.length} RPC, sockets warmed) — ${wib(realNow())}`);
  console.log(line());
  console.log(`💸 Final price    : ${ethers.formatEther(livePrice)} ETH`);
  console.log(`🎒 Final max/wal. : ${liveMaxPerWallet}`);
  console.log(`📊 Latest supply  : ${latestTotalSupply.toString()} / ${maxSupply.toString() || '?'}`);
  console.log(`⛽ Final gas      : maxFee ${gwei(liveGas.maxFeePerGas)} gwei | prio ${gwei(liveGas.maxPriorityFeePerGas)} gwei`);

  // 4) Per-wallet submit + RBF auto-rebroadcast. All wallets run concurrently.
  const submitWithRbf = async (s) => {
    if (!s.raw) return { ...s, success: false, error: s.error || 'not signed' };
    let raw = s.raw;
    let expectedHash = s.expectedHash;
    let gasState = s.gasState;
    let lastHash = null;
    const deadline = realNow() + rbfAfterMs * (rbfMax + 1) + 5000;

    for (let attempt = 0; attempt <= rbfMax; attempt++) {
      // Broadcast (fan-out). First RPC to accept wins.
      const b = await broadcastFanout(bcEndpoints, raw, expectedHash, `w${s.index}`);
      if (b.ok && b.hash) {
        lastHash = b.hash;
        const tag = attempt === 0 ? 'TX' : `RBF#${attempt}`;
        console.log(`📨 Wallet ${s.index} ${tag}: ${b.hash}${b.benign ? ' (already in flight)' : ''} via ${shortAddr(b.url || '')}`);
      } else {
        console.log(`❌ Wallet ${s.index}: broadcast gagal — ${b.msg || 'unknown'}`);
        if (!lastHash) return { ...s, success: false, error: b.msg || 'broadcast failed' };
      }

      // Wait for inclusion up to rbfAfterMs; if mined, done.
      try {
        const receipt = await provider.waitForTransaction(lastHash, 1, rbfAfterMs);
        if (receipt) {
          const tokenIds = [];
          for (const l of (receipt.logs || [])) {
            if (l.address.toLowerCase() !== nftContract.toLowerCase()) continue;
            try {
              const parsed = nftIface.parseLog({ topics: l.topics, data: l.data });
              if (parsed?.name === 'Transfer') tokenIds.push(parsed.args.tokenId.toString());
            } catch {}
          }
          return { ...s, txHash: lastHash, success: receipt.status === 1, receipt, tokenIds, attempts: attempt + 1,
            error: receipt.status === 1 ? null : 'transaction reverted' };
        }
      } catch { /* timeout → fall through to RBF */ }

      if (attempt >= rbfMax || realNow() > deadline) break;

      // RBF: bump gas on the SAME nonce and re-sign for the next attempt.
      gasState = bumpGas(gasState, rbfBump, liveGas.cap);
      const rbfReq = { ...s.rawTxReq, maxFeePerGas: gasState.maxFeePerGas, maxPriorityFeePerGas: gasState.maxPriorityFeePerGas };
      raw = await s.wallet.signTransaction(rbfReq);
      expectedHash = ethers.keccak256(raw);
      console.log(`🔁 Wallet ${s.index} RBF bump → maxFee ${gwei(gasState.maxFeePerGas)} gwei | prio ${gwei(gasState.maxPriorityFeePerGas)} gwei`);
    }

    // Final check: maybe it mined right at the edge.
    if (lastHash) {
      try {
        const receipt = await provider.getTransactionReceipt(lastHash);
        if (receipt) {
          const tokenIds = [];
          for (const l of (receipt.logs || [])) {
            if (l.address.toLowerCase() !== nftContract.toLowerCase()) continue;
            try {
              const parsed = nftIface.parseLog({ topics: l.topics, data: l.data });
              if (parsed?.name === 'Transfer') tokenIds.push(parsed.args.tokenId.toString());
            } catch {}
          }
          return { ...s, txHash: lastHash, success: receipt.status === 1, receipt, tokenIds, error: receipt.status === 1 ? null : 'transaction reverted' };
        }
      } catch {}
    }
    return { ...s, txHash: lastHash, success: false, error: 'tidak ter-mine setelah RBF (mungkat sold out / nonce dipakai tx lain)' };
  };

  const skippedSigned = signed.filter(s => !s.raw);
  for (const p of skippedSigned) console.log(`⏭️  Wallet ${p.index}: skip — ${p.error}`);

  const results = await Promise.all(ready.map(submitWithRbf));
  polling = false;
  await Promise.race([poller, sleep(pollMs + 100)]).catch(() => {});

  console.log('\n' + line());
  console.log(`📋 HASIL FAST AUTO-MINT — ${wib(realNow())}`);
  console.log(line());
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);
  console.log(`✅ Berhasil : ${ok.length} wallet`);
  console.log(`❌ Gagal    : ${fail.length} wallet\n`);
  for (const r of [...results, ...skippedSigned]) {
    if (r.success) {
      console.log(`✅ Wallet ${r.index} ${shortAddr(r.address)}`);
      console.log(`   Qty       : ${r.qty}`);
      console.log(`   TX        : ${r.txHash}`);
      console.log(`   Explorer  : ${explorerTxUrl(chainId, r.txHash)}`);
      console.log(`   Block     : ${r.receipt.blockNumber}`);
      console.log(`   Gas used  : ${r.receipt.gasUsed.toString()}`);
      if (r.attempts) console.log(`   Attempts  : ${r.attempts} (incl. RBF)`);
      if (r.tokenIds?.length) console.log(`   Token IDs : ${r.tokenIds.join(', ')}`);
    } else {
      console.log(`❌ Wallet ${r.index} ${shortAddr(r.address)}`);
      console.log(`   Qty       : ${r.qty ?? '-'}`);
      if (r.txHash) console.log(`   TX        : ${r.txHash}`);
      console.log(`   Error     : ${r.error || 'Unknown error'}`);
    }
    console.log('');
  }
  console.log(line() + '\n');
  if (!ok.length) process.exitCode = 1;
}

// BUG FIX: was hardcoded to etherscan.io regardless of chain, producing wrong
// links for L2s/testnets (e.g. a Base Sepolia tx pointed at Ethereum mainnet).
function explorerTxUrl(chainId, txHash) {
  const EXPLORERS = {
    1: 'https://etherscan.io', 11155111: 'https://sepolia.etherscan.io',
    137: 'https://polygonscan.com', 42161: 'https://arbiscan.io', 421614: 'https://sepolia.arbiscan.io',
    10: 'https://optimistic.etherscan.io', 11155420: 'https://sepolia-optimism.etherscan.io',
    8453: 'https://basescan.org', 84532: 'https://sepolia.basescan.org',
    7777777: 'https://explorer.zora.energy', 81457: 'https://blastscan.io',
  };
  const base = EXPLORERS[chainId] || 'https://etherscan.io';
  return `${base}/tx/${txHash}`;
}

main().catch((e) => {
  console.error('\n' + line());
  console.error(`❌ FAST MINT ERROR — ${wib()}`);
  console.error(line());
  console.error(decodeErr(e));
  console.error(line() + '\n');
  process.exit(1);
});
