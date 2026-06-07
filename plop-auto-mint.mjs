#!/usr/bin/env node
/**
 * PLOP auto-mint runner (SeaDrop v1 public mint)
 * - Wallets: alpha(0), bravo(1)
 * - Quantity: max on-chain public drop per wallet
 * - Output timezone: WIB (Asia/Jakarta)
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const MODE = process.argv.includes('--status') ? 'status' : 'live';

// ===== PLOP / SeaDrop config =====
const NFT_CONTRACT = '0x06ea2bf75bedc071be4c20361656c665145b38d4';
const SEADROP_CONTRACT = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';
const TARGET_START_UTC = '2026-06-07T16:00:51.000Z';
const SUBMIT_DELAY_MS = 1500; // submit slightly after on-chain start to avoid timestamp revert
const WALLET_INDICES = [0, 1];
const REQUESTED_MAX_QTY = 99; // script will cap using on-chain maxTotalMintableByWallet
const FALLBACK_GAS_LIMIT = 650_000n;
const GAS_BUFFER_BPS = 12500n; // 1.25x estimate
const MIN_PRIORITY_GWEI = '0.01';
const WALLET_BALANCE_SAFETY_BPS = 9500n; // keep 5% headroom for upfront EIP-1559 max gas

const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns (bool)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
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

function wib(dateLike = new Date()) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} WIB`;
}

function shortAddr(a) { return `${a.slice(0, 6)}...${a.slice(-4)}`; }
function shortTx(h) { return h ? `${h.slice(0, 10)}...${h.slice(-8)}` : '-'; }
function eth(v, decimals = 8) { return Number(ethers.formatEther(v)).toFixed(decimals).replace(/0+$/, '').replace(/\.$/, ''); }
function gwei(v, decimals = 4) { return Number(ethers.formatUnits(v, 'gwei')).toFixed(decimals).replace(/0+$/, '').replace(/\.$/, ''); }
function line(char = '─', n = 68) { return char.repeat(n); }
function log(section, msg = '') {
  if (msg) console.log(`${section} ${msg}`);
  else console.log(section);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeError(e) {
  const raw = e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);
  return raw.replace(/\s+/g, ' ').slice(0, 260);
}

async function retryRpc(fn, label, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = decodeError(e);
      if (i < attempts && /missing response|timeout|temporarily|429|rate|network|server/i.test(msg)) {
        console.log(`⚠️ RPC ${label} gagal (${msg}) — retry ${i + 1}/${attempts}...`);
        await sleep(700 * i);
        continue;
      }
      break;
    }
  }
  throw last;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const keys = (process.env.WALLET_PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!rpcUrl) throw new Error('RPC_URL belum terisi di .env');
  if (keys.length === 0) throw new Error('WALLET_PRIVATE_KEYS belum terisi di .env');

  // Disable JSON-RPC batching: some RPC endpoints occasionally return
  // "missing response for request" when ethers batches concurrent calls.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  const network = await retryRpc(() => provider.getNetwork(), 'getNetwork');
  if (Number(network.chainId) !== 1) throw new Error(`RPC bukan Ethereum mainnet. chainId=${network.chainId}`);

  const selected = WALLET_INDICES.map(i => {
    if (!keys[i]) throw new Error(`Wallet index ${i} tidak ditemukan di WALLET_PRIVATE_KEYS`);
    return { index: i, wallet: new ethers.Wallet(keys[i], provider) };
  });

  const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, provider);
  const sea = new ethers.Contract(SEADROP_CONTRACT, SEADROP_ABI, provider);

  const [name, symbol, drop, allowed, feeAllowed, totalSupply, maxSupply, feeData, latestBlock] = await Promise.all([
    retryRpc(() => nft.name(), 'nft.name').catch(() => 'PLOP'),
    retryRpc(() => nft.symbol(), 'nft.symbol').catch(() => 'PLOP'),
    retryRpc(() => sea.getPublicDrop(NFT_CONTRACT), 'getPublicDrop'),
    retryRpc(() => sea.getAllowedFeeRecipients(NFT_CONTRACT), 'getAllowedFeeRecipients').catch(() => []),
    retryRpc(() => sea.getFeeRecipientIsAllowed(NFT_CONTRACT, FEE_RECIPIENT), 'getFeeRecipientIsAllowed').catch(() => false),
    retryRpc(() => nft.totalSupply(), 'totalSupply').catch(() => 0n),
    retryRpc(() => nft.maxSupply(), 'maxSupply').catch(() => 10000n),
    retryRpc(() => provider.getFeeData(), 'getFeeData'),
    retryRpc(() => provider.getBlock('latest'), 'getBlock'),
  ]);

  const mintPrice = BigInt(drop.mintPrice);
  const onchainMaxPerWallet = Number(drop.maxTotalMintableByWallet);
  const targetMs = Number(drop.startTime) > 0 ? Number(drop.startTime) * 1000 : Date.parse(TARGET_START_UTC);
  const endMs = Number(drop.endTime) > 0 ? Number(drop.endTime) * 1000 : 0;
  const targetSubmitMs = targetMs + SUBMIT_DELAY_MS;

  console.log('\n' + line('═'));
  console.log('🚀 PLOP AUTO-MINT — SeaDrop Public Mint');
  console.log(line('═'));
  console.log(`🕘 Sekarang       : ${wib()}`);
  console.log(`🎯 Submit target  : ${wib(targetSubmitMs)}  (${new Date(targetSubmitMs).toISOString()})`);
  if (endMs) console.log(`🏁 Mint berakhir  : ${wib(endMs)}`);
  console.log(`🔗 Network        : Ethereum Mainnet`);
  console.log(`📦 Collection     : ${name} (${symbol})`);
  console.log(`🎨 NFT Contract   : ${NFT_CONTRACT}`);
  console.log(`🌊 SeaDrop        : ${SEADROP_CONTRACT}`);
  console.log(`💸 Harga mint     : ${ethers.formatEther(mintPrice)} ETH`);
  console.log(`🎒 Max on-chain   : ${onchainMaxPerWallet} / wallet`);
  console.log(`📊 Supply         : ${totalSupply.toString()} / ${maxSupply.toString()}`);
  console.log(`✅ Fee recipient  : ${feeAllowed ? 'allowed' : 'NOT allowed'} (${shortAddr(FEE_RECIPIENT)})`);
  if (allowed.length) console.log(`📍 Allowed fee    : ${allowed.map(shortAddr).join(', ')}`);
  console.log(`⛽ Gas sekarang   : base ${latestBlock?.baseFeePerGas ? gwei(latestBlock.baseFeePerGas) : '?'} gwei | max ${feeData.maxFeePerGas ? gwei(feeData.maxFeePerGas) : '?'} gwei | prio ${feeData.maxPriorityFeePerGas ? gwei(feeData.maxPriorityFeePerGas) : '?'} gwei`);

  if (!feeAllowed) throw new Error('Fee recipient OpenSea tidak allowed di SeaDrop; stop agar tidak revert.');
  if (onchainMaxPerWallet <= 0) throw new Error('Max per wallet on-chain = 0; public drop belum valid.');

  console.log('\n👛 Wallet Plan');
  console.log(line());
  const plans = [];
  for (const { index, wallet } of selected) {
    const [balance, nftBal, stats] = await Promise.all([
      retryRpc(() => provider.getBalance(wallet.address), `balance wallet ${index}`),
      retryRpc(() => nft.balanceOf(wallet.address), `nft balance wallet ${index}`).catch(() => 0n),
      retryRpc(() => nft.getMintStats(wallet.address), `mint stats wallet ${index}`).catch(() => [0n, totalSupply, maxSupply]),
    ]);
    const alreadyMinted = Number(stats[0] ?? 0n);
    const remainingAllowance = Math.max(0, onchainMaxPerWallet - alreadyMinted);
    const qty = Math.min(REQUESTED_MAX_QTY, remainingAllowance);
    const value = mintPrice * BigInt(qty);
    plans.push({ index, wallet, balance, nftBal, alreadyMinted, qty, value });
    console.log(`• Wallet ${index} ${shortAddr(wallet.address)}`);
    console.log(`  Balance ETH    : ${eth(balance)} ETH`);
    console.log(`  NFT balance    : ${nftBal.toString()}`);
    console.log(`  Sudah mint     : ${alreadyMinted}`);
    console.log(`  Akan mint      : ${qty} NFT`);
  }

  if (plans.every(p => p.qty <= 0)) throw new Error('Semua wallet sudah mencapai limit mint.');

  if (MODE === 'status') {
    console.log('\n✅ Status check selesai. Tidak ada transaksi dikirim (--status).');
    console.log(line('═') + '\n');
    return;
  }

  const now = Date.now();
  if (now < targetSubmitMs) {
    const waitMs = targetSubmitMs - now;
    const mins = Math.floor(waitMs / 60000);
    const secs = Math.floor((waitMs % 60000) / 1000);
    console.log(`\n⏳ Menunggu mint live: ${mins}m ${secs}s lagi...`);
    await sleep(waitMs);
  } else {
    console.log('\n🟢 Waktu mint sudah lewat/aktif — submit sekarang.');
  }

  console.log('\n' + line('═'));
  console.log(`🚀 SUBMIT TRANSAKSI — ${wib()}`);
  console.log(line('═'));

  async function mintOne(plan) {
    const { index, wallet, qty, value } = plan;
    const startedAt = Date.now();
    const signerSea = sea.connect(wallet);
    const label = `Wallet ${index} ${shortAddr(wallet.address)}`;

    if (qty <= 0) {
      return { index, wallet: wallet.address, success: false, skipped: true, error: 'Quantity 0 (limit sudah tercapai)' };
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const [balanceNow, feeNow, blockNow] = await Promise.all([
          retryRpc(() => provider.getBalance(wallet.address), `live balance wallet ${index}`),
          retryRpc(() => provider.getFeeData(), `live feeData wallet ${index}`),
          retryRpc(() => provider.getBlock('latest'), `live block wallet ${index}`),
        ]);

        // Try exact gas estimate after mint start. If RPC simulation still thinks inactive, fallback.
        let gasLimit = FALLBACK_GAS_LIMIT;
        try {
          const est = await retryRpc(() => signerSea.mintPublic.estimateGas(NFT_CONTRACT, FEE_RECIPIENT, ethers.ZeroAddress, qty, { value }), `estimate wallet ${index}`);
          gasLimit = (est * GAS_BUFFER_BPS) / 10000n;
        } catch (e) {
          if (attempt < 3 && /not active|drop|revert|execution/i.test(decodeError(e))) {
            console.log(`⏳ ${label}: estimate belum siap (${decodeError(e)}), retry 1.2s...`);
            await sleep(1200);
            continue;
          }
          console.log(`⚠️ ${label}: estimate gagal, pakai fallback gasLimit ${gasLimit.toString()}`);
        }

        const baseFee = blockNow?.baseFeePerGas || feeNow.gasPrice || ethers.parseUnits('0.12', 'gwei');
        let priority = feeNow.maxPriorityFeePerGas || ethers.parseUnits(MIN_PRIORITY_GWEI, 'gwei');
        const minPriority = ethers.parseUnits(MIN_PRIORITY_GWEI, 'gwei');
        if (priority < minPriority) priority = minPriority;

        let desiredMaxFee = baseFee * 2n + priority;
        let balanceForGas = balanceNow > value ? balanceNow - value : 0n;
        let hardMaxFee = balanceForGas > 0n ? ((balanceForGas * WALLET_BALANCE_SAFETY_BPS) / 10000n) / gasLimit : 0n;
        let maxFeePerGas = desiredMaxFee;
        if (hardMaxFee > 0n && maxFeePerGas > hardMaxFee) maxFeePerGas = hardMaxFee;
        if (maxFeePerGas <= baseFee) {
          throw new Error(`Saldo gas tidak cukup. balance=${eth(balanceNow)} ETH, gasLimit=${gasLimit}, baseFee=${gwei(baseFee)} gwei, maxAffordable=${gwei(hardMaxFee)} gwei`);
        }
        if (priority >= maxFeePerGas - baseFee) priority = maxFeePerGas - baseFee;
        if (priority <= 0n) priority = 1n;

        console.log(`🚀 ${label}: submit qty ${qty} | gasLimit ${gasLimit} | maxFee ${gwei(maxFeePerGas)} gwei | prio ${gwei(priority)} gwei`);
        const tx = await retryRpc(() => signerSea.mintPublic(NFT_CONTRACT, FEE_RECIPIENT, ethers.ZeroAddress, qty, {
          value,
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas: priority,
        }), `send tx wallet ${index}`);
        console.log(`📨 ${label}: TX sent ${tx.hash}`);

        const receipt = await retryRpc(() => tx.wait(1), `wait tx wallet ${index}`, 6);
        const tokenIds = [];
        if (receipt?.logs) {
          const iface = new ethers.Interface(NFT_ABI);
          for (const logEntry of receipt.logs) {
            if (logEntry.address.toLowerCase() !== NFT_CONTRACT.toLowerCase()) continue;
            try {
              const parsed = iface.parseLog({ topics: logEntry.topics, data: logEntry.data });
              if (parsed?.name === 'Transfer' && parsed.args?.tokenId !== undefined) {
                tokenIds.push(parsed.args.tokenId.toString());
              }
            } catch {}
          }
        }

        const finalBal = await retryRpc(() => nft.balanceOf(wallet.address), `final nft balance wallet ${index}`).catch(() => null);
        return {
          index, wallet: wallet.address, success: receipt?.status === 1,
          txHash: tx.hash, blockNumber: receipt?.blockNumber ?? null,
          gasUsed: receipt?.gasUsed?.toString() ?? null,
          qty, tokenIds, nftBalance: finalBal?.toString?.() ?? null,
          durationMs: Date.now() - startedAt,
        };
      } catch (e) {
        const err = decodeError(e);
        if (attempt < 3 && /nonce|replacement|timeout|temporarily|429|rate|underpriced/i.test(err)) {
          console.log(`⚠️ ${label}: ${err} — retry ${attempt + 1}/3...`);
          await sleep(1200 * attempt);
          continue;
        }
        return { index, wallet: wallet.address, success: false, qty, error: err, durationMs: Date.now() - startedAt };
      }
    }
  }

  const results = await Promise.all(plans.map(mintOne));

  console.log('\n' + line('═'));
  console.log(`📋 HASIL AUTO-MINT PLOP — ${wib()}`);
  console.log(line('═'));
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);
  console.log(`✅ Berhasil : ${ok.length} wallet`);
  console.log(`❌ Gagal    : ${fail.length} wallet`);
  console.log('');
  for (const r of results) {
    const title = `Wallet ${r.index} ${shortAddr(r.wallet)}`;
    if (r.success) {
      console.log(`✅ ${title}`);
      console.log(`   Qty        : ${r.qty}`);
      console.log(`   TX         : ${r.txHash}`);
      console.log(`   Etherscan  : https://etherscan.io/tx/${r.txHash}`);
      console.log(`   Block      : ${r.blockNumber}`);
      console.log(`   Gas used   : ${r.gasUsed}`);
      if (r.tokenIds?.length) console.log(`   Token IDs  : ${r.tokenIds.join(', ')}`);
      if (r.nftBalance !== null) console.log(`   NFT balance: ${r.nftBalance}`);
      console.log(`   Durasi     : ${(r.durationMs / 1000).toFixed(1)}s`);
    } else {
      console.log(`❌ ${title}`);
      console.log(`   Qty        : ${r.qty ?? '-'}`);
      console.log(`   Error      : ${r.error || 'Unknown error'}`);
    }
    console.log('');
  }
  console.log(line('═') + '\n');

  if (fail.length && !ok.length) process.exitCode = 1;
}

main().catch(err => {
  console.error('\n' + line('═'));
  console.error(`❌ AUTO-MINT ERROR — ${wib()}`);
  console.error(line('═'));
  console.error(decodeError(err));
  console.error(line('═') + '\n');
  process.exit(1);
});
