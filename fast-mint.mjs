#!/usr/bin/env node
/**
 * Competitive SeaDrop fast-mint runner.
 *
 * Goals:
 * - No agent/scheduler/estimateGas delay at mint time.
 * - Use live on-chain SeaDrop price/max, not stale OpenSea UI/SSR.
 * - Pre-warm RPC, nonces, balances, fee recipient, and keep latest drop/gas cached.
 * - Sign raw EIP-1559 transactions and broadcast in parallel at target time.
 * - Never silently lower gas to fit low wallet balance; skip/warn instead.
 * - Output all times in WIB (Asia/Jakarta).
 *
 * Examples:
 *   node fast-mint.mjs --contract 0xNFT --time 2026-06-07T16:00:51Z --qty max --wallets 0,1
 *   node fast-mint.mjs --url https://opensea.io/collection/plop-fun/overview --time auto --qty max --gas-mode aggressive
 *   node fast-mint.mjs --contract 0xNFT --status
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
function min(a, b) { return a < b ? a : b; }
function max(a, b) { return a > b ? a : b; }

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

function gasParamsFrom(baseFee, feeData, opts) {
  const capGwei = opts.maxFeeGwei || process.env.MAX_GAS_PRICE_GWEI || '100';
  const priorityGwei = opts.priorityGwei || process.env.PRIORITY_FEE_GWEI || '2';
  const cap = ethers.parseUnits(String(capGwei), 'gwei');
  const priorityBase = ethers.parseUnits(String(priorityGwei), 'gwei');
  const mode = String(opts.gasMode || process.env.GAS_MODE || 'aggressive').toLowerCase();
  const mult = mode === 'eco' ? 1.25 : mode === 'normal' ? 2 : mode === 'custom'
    ? Number(process.env.CUSTOM_GAS_MULTIPLIER || '3') : 4;
  const rawBase = baseFee || feeData.gasPrice || ethers.parseUnits('20', 'gwei');
  let priority = feeData.maxPriorityFeePerGas || priorityBase;
  if (priority < priorityBase) priority = priorityBase;
  let maxFee = BigInt(Math.ceil(Number(rawBase) * mult)) + priority;
  maxFee = min(maxFee, cap);
  priority = min(priority, maxFee > rawBase ? maxFee - rawBase : maxFee);
  if (priority <= 0n) priority = 1n;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, mode, cap };
}

function defaultGasLimit(qty) {
  // Intentionally conservative. Unused gas is refunded, but the wallet must afford upfront maxFee * gasLimit.
  const base = BigInt(args['gas-limit'] || process.env.FAST_MINT_GAS_LIMIT || '650000');
  const scaled = 280000n + BigInt(qty) * 60000n;
  return max(base, scaled);
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

  const walletIndices = parseList(args.wallets, keys.map((_, i) => i));
  const wallets = walletIndices.map(i => {
    if (!keys[i]) throw new Error(`Wallet index ${i} tidak ada di WALLET_PRIVATE_KEYS`);
    const wallet = new ethers.Wallet(keys[i], provider);
    return { index: i, wallet, address: wallet.address };
  });

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

  let feeRecipient = args['fee-recipient'] ? ethers.getAddress(args['fee-recipient']) : (feeRecipients?.[0] || '0x0000a26b00c1F0DF003000390027140000fAa719');
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
  console.log(`🚀 FAST AUTO-MINT — ${name} (${symbol})`);
  console.log(line());
  console.log(`🕘 Sekarang       : ${wib()}`);
  console.log(`🎯 Target start   : ${wib(targetMs)} (${new Date(targetMs).toISOString()})`);
  console.log(`📤 Broadcast      : ${wib(targetMs - earlyMs)} (early ${earlyMs}ms)`);
  if (onchainEndMs) console.log(`🏁 End            : ${wib(onchainEndMs)}`);
  console.log(`🔗 Chain          : ${chainId}`);
  console.log(`🎨 NFT            : ${nftContract}`);
  console.log(`🌊 SeaDrop        : ${seadropAddress}`);
  console.log(`💸 Live price     : ${ethers.formatEther(drop.mintPrice)} ETH`);
  console.log(`🎒 Max/wallet     : ${Number(drop.maxTotalMintableByWallet)}`);
  console.log(`📊 Supply         : ${totalSupply.toString()} / ${maxSupply.toString() || '?'}`);
  console.log(`⛽ Gas mode       : ${gas.mode} | maxFee ${gwei(gas.maxFeePerGas)} gwei | prio ${gwei(gas.maxPriorityFeePerGas)} gwei | cap ${gwei(gas.cap)} gwei`);
  console.log(`💰 Fee recipient  : ${shortAddr(feeRecipient)}${drop.restrictFeeRecipients ? ' (restricted)' : ''}`);

  const plans = [];
  console.log('\n👛 Wallet Plan');
  console.log(line('─'));
  for (const w of wallets) {
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
    plans.push({ ...w, balance, nftBal, minted, qty, nonce, gasLimit, value, upfront, enough });
    console.log(`• Wallet ${w.index} ${shortAddr(w.address)}`);
    console.log(`  Balance ETH    : ${eth(balance)} ETH`);
    console.log(`  NFT balance    : ${nftBal.toString()} | sudah mint: ${minted}`);
    console.log(`  Akan mint      : ${qty} NFT`);
    if (qty > 0) console.log(`  Need upfront   : ${eth(upfront)} ETH (${enough ? 'OK' : 'KURANG'})`);
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
  if (nowMs() < broadcastMs) {
    const wait = broadcastMs - nowMs();
    console.log(`\n⏳ Pre-warmed. Menunggu broadcast: ${Math.floor(wait / 60000)}m ${Math.floor((wait % 60000) / 1000)}s...`);
    await sleep(wait);
  } else {
    console.log('\n🟢 Broadcast time sudah lewat/aktif — broadcast sekarang.');
  }

  // Use latest cached drop/gas. If creator changed price/max shortly before mint, this picks it up.
  const liveMaxPerWallet = Number(latestDrop.maxTotalMintableByWallet) || Number(drop.maxTotalMintableByWallet) || 1;
  const livePrice = BigInt(latestDrop.mintPrice);
  const liveGas = gasParamsFrom(latestBlock?.baseFeePerGas, latestFeeData, {
    gasMode: args['gas-mode'], maxFeeGwei: args['max-fee-gwei'], priorityGwei: args['priority-gwei'],
  });

  console.log('\n' + line());
  console.log(`📨 BROADCAST RAW TX — ${wib()}`);
  console.log(line());
  console.log(`💸 Final price    : ${ethers.formatEther(livePrice)} ETH`);
  console.log(`🎒 Final max/wal. : ${liveMaxPerWallet}`);
  console.log(`📊 Latest supply  : ${latestTotalSupply.toString()} / ${maxSupply.toString() || '?'}`);
  console.log(`⛽ Final gas      : maxFee ${gwei(liveGas.maxFeePerGas)} gwei | prio ${gwei(liveGas.maxPriorityFeePerGas)} gwei`);

  const txs = [];
  for (const p of executable) {
    const qty = Math.min(p.qty, liveMaxPerWallet - p.minted);
    if (qty <= 0) {
      txs.push({ ...p, success: false, skipped: true, error: 'qty=0 after live max update' });
      continue;
    }
    const value = livePrice * BigInt(qty);
    const upfront = value + p.gasLimit * liveGas.maxFeePerGas;
    if (p.balance < upfront) {
      txs.push({ ...p, qty, success: false, skipped: true, error: `ETH kurang after live update; need ${eth(upfront)} ETH, punya ${eth(p.balance)} ETH` });
      continue;
    }
    const data = iface.encodeFunctionData('mintPublic', [nftContract, feeRecipient, ethers.ZeroAddress, qty]);
    const rawTxReq = {
      type: 2,
      chainId,
      to: seadropAddress,
      nonce: p.nonce,
      data,
      value,
      gasLimit: p.gasLimit,
      maxFeePerGas: liveGas.maxFeePerGas,
      maxPriorityFeePerGas: liveGas.maxPriorityFeePerGas,
    };
    const raw = await p.wallet.signTransaction(rawTxReq);
    txs.push({ ...p, qty, value, rawTxReq, raw });
    console.log(`🚀 Wallet ${p.index} ${shortAddr(p.address)}: qty ${qty} | nonce ${p.nonce} | gasLimit ${p.gasLimit} | value ${eth(value)} ETH`);
  }

  const sent = await Promise.all(txs.map(async (t) => {
    if (t.skipped || !t.raw) return t;
    try {
      const resp = await provider.broadcastTransaction(t.raw);
      console.log(`📨 Wallet ${t.index}: ${resp.hash}`);
      return { ...t, txHash: resp.hash, response: resp };
    } catch (e) {
      const err = decodeErr(e);
      console.log(`❌ Wallet ${t.index}: broadcast gagal — ${err}`);
      return { ...t, success: false, error: err };
    }
  }));

  const results = await Promise.all(sent.map(async (s) => {
    if (!s.txHash) return s;
    try {
      const receipt = await provider.waitForTransaction(s.txHash, 1, Number(args['receipt-timeout-ms'] || 120000));
      const tokenIds = [];
      if (receipt?.logs) {
        for (const l of receipt.logs) {
          if (l.address.toLowerCase() !== nftContract.toLowerCase()) continue;
          try {
            const parsed = nftIface.parseLog({ topics: l.topics, data: l.data });
            if (parsed?.name === 'Transfer') tokenIds.push(parsed.args.tokenId.toString());
          } catch {}
        }
      }
      return { ...s, success: receipt?.status === 1, receipt, tokenIds, error: receipt?.status === 1 ? null : 'transaction reverted' };
    } catch (e) {
      return { ...s, success: false, error: decodeErr(e) };
    }
  }));
  polling = false;
  await Promise.race([poller, sleep(pollMs + 100)]).catch(() => {});

  console.log('\n' + line());
  console.log(`📋 HASIL FAST AUTO-MINT — ${wib()}`);
  console.log(line());
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);
  console.log(`✅ Berhasil : ${ok.length} wallet`);
  console.log(`❌ Gagal    : ${fail.length} wallet\n`);
  for (const r of results) {
    if (r.success) {
      console.log(`✅ Wallet ${r.index} ${shortAddr(r.address)}`);
      console.log(`   Qty       : ${r.qty}`);
      console.log(`   TX        : ${r.txHash}`);
      console.log(`   Etherscan : https://etherscan.io/tx/${r.txHash}`);
      console.log(`   Block     : ${r.receipt.blockNumber}`);
      console.log(`   Gas used  : ${r.receipt.gasUsed.toString()}`);
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

main().catch((e) => {
  console.error('\n' + line());
  console.error(`❌ FAST MINT ERROR — ${wib()}`);
  console.error(line());
  console.error(decodeErr(e));
  console.error(line() + '\n');
  process.exit(1);
});
