/**
 * Auto Mint Agent - Hermes Skill
 *
 * Skill ini menyediakan tools untuk auto-minting NFT dengan multi-wallet
 * dan listing interaktif di OpenSea.
 *
 * Flow:
 * 1. User kirim link → parse_mint_link untuk detect jenis
 * 2. detect_contract untuk cek info detail contract
 * 3. mint_nft untuk execute minting dengan multi-wallet
 * 4. Agent DISKUSI dulu sama user mau list berapa
 * 5. list_nft / batch_list_nfts untuk listing setelah user setuju harga
 */

import { loadConfig, Config } from '../config';
import { WalletManager } from '../wallet';
import { DirectMinter, OpenSeaMinter, parseMintLink, ParsedMintInfo, MintResult, ContractInfo } from '../mint';
import { AutoLister, ListResult } from '../listing';
import { MintScheduler, MintScheduleInfo, ScheduledMintJob } from '../scheduler';
import { shortAddress, shortTxHash, truncate, isValidAddress } from '../utils';

// ============================================================
// SKILL DEFINITION - Hermes reads this to know available tools
// ============================================================

export const SKILL_DEFINITION = {
  name: 'auto-mint-agent',
  description: 'Skill untuk auto-minting NFT dengan multi-wallet dan listing interaktif di OpenSea. User kirim link minting, agent detect jenis mint, execute dengan banyak wallet, lalu diskusi harga listing sebelum di-list.',
  tools: [
    {
      name: 'parse_mint_link',
      description: 'Parse link minting untuk mendeteksi jenis mint (direct contract vs OpenSea/Seadrop). Input berupa URL atau contract address. Output berisi type, contract address, confidence level, dan notes.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL minting atau contract address. Bisa berupa: OpenSea collection URL, OpenSea asset URL, Etherscan URL, Thirdweb URL, atau raw contract address (0x...)',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'detect_contract',
      description: 'Detect informasi detail dari smart contract NFT: nama, symbol, mint price, supply, max per wallet, dan mint function signature. Gunakan sebelum minting untuk memastikan contract valid dan mendapatkan harga mint.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT (0x...)',
          },
        },
        required: ['contract_address'],
      },
    },
    {
      name: 'check_wallets',
      description: 'Cek balance ETH semua wallet yang terdaftar. Gunakan sebelum minting untuk memastikan wallet punya cukup ETH untuk mint + gas.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mint_nft',
      description: 'Execute minting NFT dengan multi-wallet secara simultan. Support direct contract minting dan OpenSea/Seadrop minting. Agent harus DISKUSI dulu sama user sebelum menjalankan ini: konfirmasi contract, harga mint, quantity, dan wallet yang dipakai.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT yang mau di-mint',
          },
          mint_price_eth: {
            type: 'string',
            description: 'Harga mint per NFT dalam ETH (contoh: "0.05"). Set "0" untuk free mint.',
          },
          quantity_per_wallet: {
            type: 'number',
            description: 'Jumlah NFT yang di-mint per wallet (default: 1)',
          },
          wallet_indices: {
            type: 'array',
            items: { type: 'number' },
            description: 'Index wallet yang dipakai (0-based). Kosongkan untuk pakai semua wallet.',
          },
          concurrent: {
            type: 'number',
            description: 'Jumlah wallet yang mint bersamaan (default: 3). Set lebih rendah jika RPC throttle.',
          },
          mint_function: {
            type: 'string',
            description: 'Mint function signature (contoh: "mint(uint256)"). Kosongkan untuk auto-detect.',
          },
        },
        required: ['contract_address', 'mint_price_eth'],
      },
    },
    {
      name: 'approve_seaport',
      description: 'Approve Seaport (OpenSea) untuk transfer NFT dari wallet. WAJIB dilakukan sebelum listing di OpenSea. Bisa approve per wallet atau batch semua wallet.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT yang mau di-approve',
          },
          wallet_index: {
            type: 'number',
            description: 'Index wallet yang mau di-approve. Kosongkan untuk batch approve semua wallet.',
          },
        },
        required: ['contract_address'],
      },
    },
    {
      name: 'list_nft',
      description: 'List NFT di OpenSea dengan harga tertentu. PENTING: Agent HARUS diskusi dulu sama user tentang harga listing sebelum memanggil tool ini. Tanya user: "Mau list berapa ETH?" setelah minting berhasil.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT',
          },
          token_id: {
            type: 'string',
            description: 'Token ID NFT yang mau di-list',
          },
          price_eth: {
            type: 'string',
            description: 'Harga listing dalam ETH (contoh: "0.1")',
          },
          wallet_index: {
            type: 'number',
            description: 'Index wallet pemilik NFT (0-based)',
          },
          expiration_hours: {
            type: 'number',
            description: 'Durasi listing dalam jam (default: 168 / 1 minggu)',
          },
        },
        required: ['contract_address', 'token_id', 'price_eth', 'wallet_index'],
      },
    },
    {
      name: 'batch_list_nfts',
      description: 'List banyak NFT sekaligus di OpenSea. PENTING: Agent HARUS diskusi dulu sama user tentang harga listing untuk setiap NFT atau harga uniform. Tanya user: "Mau list semua berapa ETH per NFT?" atau "Mau list dengan harga beda-beda?"',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                contract_address: { type: 'string', description: 'Contract address NFT' },
                token_id: { type: 'string', description: 'Token ID' },
                price_eth: { type: 'string', description: 'Harga listing dalam ETH' },
                wallet_index: { type: 'number', description: 'Index wallet pemilik' },
              },
              required: ['contract_address', 'token_id', 'price_eth', 'wallet_index'],
            },
            description: 'Array of NFT items to list',
          },
        },
        required: ['items'],
      },
    },
    {
      name: 'get_mint_status',
      description: 'Cek status transaksi minting yang sudah dikirim. Berguna untuk mengecek apakah TX sudah confirmed atau masih pending.',
      parameters: {
        type: 'object',
        properties: {
          tx_hash: {
            type: 'string',
            description: 'Transaction hash yang mau dicek',
          },
        },
        required: ['tx_hash'],
      },
    },
    {
      name: 'get_mint_schedule',
      description: 'Baca jadwal minting on-chain dari smart contract (Seadrop: public/allowlist start & end time, harga, max per wallet). Berguna untuk mengetahui kapan minting dimulai dan berakhir. Untuk contract Seadrop/OpenSea, jadwal bisa dibaca otomatis.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT (0x...)',
          },
        },
        required: ['contract_address'],
      },
    },
    {
      name: 'schedule_mint',
      description: 'Jadwalkan auto-minting di waktu tertentu. Agent akan otomatis mint saat waktunya tiba. PENTING: Ini hanya berfungsi untuk PUBLIC mint. Untuk WL/allowlist mint, proof dibutuhkan dan harus mint manual di OpenSea. Setelah schedule, gunakan list_scheduled_mints untuk monitoring.',
      parameters: {
        type: 'object',
        properties: {
          contract_address: {
            type: 'string',
            description: 'Contract address NFT yang mau di-mint',
          },
          mint_price_eth: {
            type: 'string',
            description: 'Harga mint per NFT dalam ETH',
          },
          quantity_per_wallet: {
            type: 'number',
            description: 'Jumlah NFT per wallet (default: 1)',
          },
          wallet_indices: {
            type: 'array',
            items: { type: 'number' },
            description: 'Index wallet yang dipakai. Kosongkan = semua wallet.',
          },
          scheduled_time: {
            type: 'string',
            description: 'Waktu eksekusi dalam ISO 8601 format (contoh: "2025-06-01T18:00:00Z") atau Unix timestamp dalam milidetik. Agent juga bisa baca dari jadwal on-chain via get_mint_schedule.',
          },
          concurrent: {
            type: 'number',
            description: 'Jumlah wallet yang mint bersamaan (default: 3)',
          },
          mint_function: {
            type: 'string',
            description: 'Override mint function signature. Kosongkan = auto-detect.',
          },
        },
        required: ['contract_address', 'mint_price_eth', 'scheduled_time'],
      },
    },
    {
      name: 'list_scheduled_mints',
      description: 'Lihat semua minting yang sudah dijadwalkan. Berguna untuk monitoring dan memastikan schedule benar sebelum waktunya tiba.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cancel_scheduled_mint',
      description: 'Batalkan minting yang sudah dijadwalkan. Hanya bisa membatalkan job yang statusnya "pending".',
      parameters: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'ID job yang mau dibatalkan (dari list_scheduled_mints)',
          },
        },
        required: ['job_id'],
      },
    },
  ],
};


// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================

let config: Config;
let walletManager: WalletManager;
let directMinter: DirectMinter;
let openSeaMinter: OpenSeaMinter;
let autoLister: AutoLister;
let mintScheduler: MintScheduler;

function initialize(): void {
  if (config) return;
  config = loadConfig();
  walletManager = new WalletManager(config);
  directMinter = new DirectMinter(config, walletManager);
  openSeaMinter = new OpenSeaMinter(config, walletManager);
  autoLister = new AutoLister(config, walletManager);
  mintScheduler = new MintScheduler(config, walletManager);
}

// Tool: parse_mint_link
export async function tool_parse_mint_link(params: { url: string }): Promise<{
  success: boolean;
  data: ParsedMintInfo;
  message: string;
}> {
  initialize();
  const parsed = parseMintLink(params.url);

  const typeLabel = parsed.type === 'direct_contract' ? 'Direct Contract' :
                    parsed.type === 'opensea_seadrop' ? 'OpenSea/Seadrop' : 'Unknown';

  let message = `🔍 *Hasil Parse Link*\n\n`;
  message += `📋 Tipe: ${typeLabel}\n`;
  if (parsed.contractAddress) message += `📍 Contract: ${parsed.contractAddress}\n`;
  if (parsed.openseaSlug) message += `🔗 OS Slug: ${parsed.openseaSlug}\n`;
  message += `🎯 Confidence: ${parsed.confidence}\n`;
  if (parsed.notes.length > 0) {
    message += `\n📝 Catatan:\n`;
    for (const n of parsed.notes) message += `  • ${n}\n`;
  }

  if (parsed.type === 'unknown' && !parsed.contractAddress) {
    message += `\n⚠️ Tidak bisa mendeteksi info minting. Coba kirim contract address langsung (0x...).`;
  } else {
    message += `\n💡 Gunakan \`detect_contract\` untuk cek detail info contract sebelum minting.`;
  }

  return { success: true, data: parsed, message };
}

// Tool: detect_contract
export async function tool_detect_contract(params: { contract_address: string }): Promise<{
  success: boolean;
  data: ContractInfo;
  message: string;
}> {
  initialize();
  if (!isValidAddress(params.contract_address)) {
    return { success: false, data: null as any, message: '❌ Contract address tidak valid.' };
  }

  const info = await directMinter.detectContract(params.contract_address);

  let message = `🔍 *Info Contract*\n\n`;
  if (info.name) message += `📝 Nama: ${info.name}\n`;
  if (info.symbol) message += `🏷️ Symbol: ${info.symbol}\n`;
  if (info.mintPrice) message += `💰 Mint Price: ${info.mintPrice} ETH\n`;
  if (info.totalSupply || info.maxSupply) {
    message += `📊 Supply: ${info.totalSupply || '?'}`;
    if (info.maxSupply) message += ` / ${info.maxSupply}`;
    message += '\n';
  }
  if (info.maxPerWallet) message += `🎒 Max/Wallet: ${info.maxPerWallet}\n`;
  if (info.functionSignature) {
    message += `🔧 Mint Function: ${info.functionSignature}\n`;
  }
  message += `\n${info.isMintable ? '✅ Contract appears mintable' : '⚠️ Could not auto-detect mint function - may need manual function signature'}`;

  if (info.isMintable) {
    message += `\n\n💡 Siap mint! Konfirmasi sama user: mau pakai berapa wallet, quantity berapa per wallet?`;
  }

  return { success: true, data: info, message };
}

// Tool: check_wallets
export async function tool_check_wallets(): Promise<{
  success: boolean;
  data: { address: string; ethBalance: string; walletIndex: number }[];
  message: string;
}> {
  initialize();
  const balances = await walletManager.getBalances();
  const totalEth = balances.reduce((s, b) => s + parseFloat(b.ethBalance), 0);

  let message = `💼 *Wallet Balances* (${balances.length} wallets)\n\n`;
  for (const b of balances) {
    const emoji = parseFloat(b.ethBalance) > 0.01 ? '✅' : '⚠️';
    message += `${emoji} Wallet ${b.walletIndex}: ${shortAddress(b.address)} — ${b.ethBalance} ETH\n`;
  }
  message += `\n💰 Total: ${totalEth.toFixed(4)} ETH`;

  return { success: true, data: balances, message };
}

// Tool: mint_nft
export async function tool_mint_nft(params: {
  contract_address: string;
  mint_price_eth: string;
  quantity_per_wallet?: number;
  wallet_indices?: number[];
  concurrent?: number;
  mint_function?: string;
}): Promise<{
  success: boolean;
  data: MintResult[];
  message: string;
}> {
  initialize();
  const {
    contract_address, mint_price_eth, quantity_per_wallet = 1,
    wallet_indices, concurrent = 3, mint_function,
  } = params;

  if (!isValidAddress(contract_address)) {
    return { success: false, data: [], message: '❌ Contract address tidak valid.' };
  }

  // Check mint price against max
  const priceNum = parseFloat(mint_price_eth);
  if (priceNum > walletManager.getConfig().maxMintPriceEth) {
    return {
      success: false, data: [],
      message: `⚠️ Mint price (${mint_price_eth} ETH) melebihi MAX_MINT_PRICE_ETH (${walletManager.getConfig().maxMintPriceEth} ETH). Ubah config atau konfirmasi manual.`,
    };
  }

  // BUG-003 FIX: Check if mint function requires proof (presale/allowlist)
  const effectiveMintFunction = mint_function;
  if (effectiveMintFunction && (effectiveMintFunction.includes('presale') || effectiveMintFunction.includes('allowlist'))) {
    return {
      success: false, data: [],
      message: `⚠️ Fungsi mint "${effectiveMintFunction}" membutuhkan Merkle proof/whitelist. Auto-minting dengan proof kosong akan gagal. Gunakan fungsi public mint (mint/claim/publicMint) atau sediakan proof yang valid.`,
    };
  }

  // BUG-011 FIX: Detect contract first to determine mint type, then use the right minter
  // This avoids calling directMinter then openSeaMinter (which would also fallback to directMinter)
  let results: MintResult[];
  try {
    const contractInfo = await directMinter.detectContract(contract_address);
    // If auto-detected function is presale/allowlist, warn user
    if (contractInfo.functionSignature && 
        (contractInfo.functionSignature.includes('presale') || contractInfo.functionSignature.includes('allowlist'))) {
      return {
        success: false, data: [],
        message: `⚠️ Contract hanya mendeteksi fungsi "${contractInfo.functionSignature}" yang membutuhkan Merkle proof. Mungkin public mint belum aktif, atau coba sebutkan fungsi mint manual: /mint <address> <price> 1 --function mint(uint256)`,
      };
    }
    
    // If detection found a function, use direct minter with it
    if (contractInfo.isMintable || mint_function) {
      results = await directMinter.mint({
        contractAddress: contract_address,
        mintPrice: mint_price_eth,
        quantity: quantity_per_wallet,
        walletsToUse: wallet_indices,
        concurrent,
        mintFunction: mint_function || contractInfo.functionSignature || undefined,
      });
    } else {
      // No mint function detected via direct contract, try OpenSea/Seadrop
      results = await openSeaMinter.mint({
        contractAddress: contract_address,
        mintPrice: mint_price_eth,
        quantity: quantity_per_wallet,
        walletsToUse: wallet_indices,
        concurrent,
      });
    }
  } catch (err: any) {
    return { success: false, data: [], message: `❌ Mint gagal: ${err.message?.slice(0, 300)}` };
  }

  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  let message = `📊 *Hasil Minting*\n\n`;
  message += `✅ Berhasil: ${successful.length}\n`;
  message += `❌ Gagal: ${failed.length}\n\n`;

  for (const r of results) {
    if (r.success) {
      message += `✅ Wallet ${r.walletIndex}: ${shortAddress(r.walletAddress)} | TX: ${shortTxHash(r.txHash || '')}`;
      if (r.tokenId) message += ` | Token #${r.tokenId}`;
      message += '\n';
    } else {
      message += `❌ Wallet ${r.walletIndex}: ${truncate(r.error || 'Failed', 60)}\n`;
    }
  }

  // IMPORTANT: Don't auto-list, suggest discussion instead
  if (successful.length > 0) {
    message += `\n\n🎯 *Langkah Selanjutnya:*\n`;
    message += `Minting berhasil! Mau di-list di OpenSea? Kalau mau, kasih tahu:\n`;
    message += `  • Harga listing per NFT (berapa ETH?)\n`;
    message += `  • Atau mau list semua dengan harga yang sama?\n`;
    message += `\nGunakan \`approve_seaport\` dulu sebelum listing.`;
  }

  return { success: successful.length > 0, data: results, message };
}

// Tool: approve_seaport
export async function tool_approve_seaport(params: {
  contract_address: string;
  wallet_index?: number;
}): Promise<{
  success: boolean;
  data: { walletIndex: number; success: boolean; error: string | null }[];
  message: string;
}> {
  initialize();
  const { contract_address, wallet_index } = params;

  let results: { walletIndex: number; success: boolean; error: string | null }[];

  if (wallet_index !== undefined) {
    const res = await autoLister.approveSeaport(contract_address, wallet_index);
    results = [{ walletIndex: wallet_index, success: res.success, error: res.error }];
  } else {
    results = await autoLister.batchApprove(contract_address);
  }

  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);

  let message = `🔐 *Approve Seaport*\n\n`;
  message += `📍 Contract: ${shortAddress(contract_address)}\n`;
  message += `✅ Berhasil: ${ok.length}\n`;
  message += `❌ Gagal: ${fail.length}\n`;

  for (const r of fail) {
    message += `  ❌ Wallet ${r.walletIndex}: ${truncate(r.error || 'Unknown', 60)}\n`;
  }

  if (ok.length > 0) {
    message += `\n✅ Seaport approved! Siap untuk listing di OpenSea.`;
    message += `\n\n💡 Sekarang tentukan harga listing dan gunakan \`list_nft\` atau \`batch_list_nfts\`.`;
  }

  return { success: fail.length === 0, data: results, message };
}

// Tool: list_nft
export async function tool_list_nft(params: {
  contract_address: string;
  token_id: string;
  price_eth: string;
  wallet_index: number;
  expiration_hours?: number;
}): Promise<{
  success: boolean;
  data: ListResult;
  message: string;
}> {
  initialize();
  const result = await autoLister.listNFT({
    contractAddress: params.contract_address,
    tokenId: params.token_id,
    priceEth: params.price_eth,
    walletIndex: params.wallet_index,
    expirationHours: params.expiration_hours,
  });

  let message = '';
  if (result.success) {
    message = `🏪 *NFT Listed!*\n\n`;
    message += `📍 Contract: ${shortAddress(params.contract_address)}\n`;
    message += `🆔 Token ID: ${params.token_id}\n`;
    message += `💰 Harga: ${params.price_eth} ETH\n`;
    message += `💼 Wallet: ${shortAddress(result.walletAddress)}\n`;
    if (result.listingUrl) message += `🔗 ${result.listingUrl}\n`;
  } else {
    message = `❌ *Listing Gagal*\n\n${result.error}`;
    message += `\n\n💡 Coba approve dulu dengan \`approve_seaport\`, lalu listing lagi.`;
  }

  return { success: result.success, data: result, message };
}

// Tool: batch_list_nfts
export async function tool_batch_list_nfts(params: {
  items: { contract_address: string; token_id: string; price_eth: string; wallet_index: number }[];
}): Promise<{
  success: boolean;
  data: ListResult[];
  message: string;
}> {
  initialize();
  const results = await autoLister.batchListNFTs(
    params.items.map(i => ({
      contractAddress: i.contract_address,
      tokenId: i.token_id,
      priceEth: i.price_eth,
      walletIndex: i.wallet_index,
    }))
  );

  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);

  let message = `🏪 *Batch Listing Results*\n\n`;
  message += `✅ Listed: ${ok.length}\n`;
  message += `❌ Gagal: ${fail.length}\n\n`;

  for (const r of results) {
    if (r.success) {
      message += `✅ Token #${r.tokenId} → ${r.priceEth} ETH | ${r.listingUrl || 'Link unavailable'}\n`;
    } else {
      message += `❌ Token #${r.tokenId}: ${truncate(r.error || 'Failed', 50)}\n`;
    }
  }

  return { success: fail.length === 0, data: results, message };
}

// Tool: get_mint_status
export async function tool_get_mint_status(params: { tx_hash: string }): Promise<{
  success: boolean;
  data: { status: string; blockNumber: number | null; gasUsed: string | null };
  message: string;
}> {
  initialize();
  try {
    const receipt = await walletManager.getProvider().getTransactionReceipt(params.tx_hash);
    if (!receipt) {
      return { success: true, data: { status: 'pending', blockNumber: null, gasUsed: null }, message: `⏳ TX ${shortTxHash(params.tx_hash)} masih pending...` };
    }
    const status = receipt.status === 1 ? 'confirmed' : 'reverted';
    const emoji = receipt.status === 1 ? '✅' : '❌';
    return {
      success: receipt.status === 1,
      data: { status, blockNumber: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() },
      message: `${emoji} TX ${shortTxHash(params.tx_hash)} ${status}\n📦 Block: ${receipt.blockNumber}\n⛽ Gas: ${receipt.gasUsed.toString()}`,
    };
  } catch (err: any) {
    return { success: false, data: { status: 'error', blockNumber: null, gasUsed: null }, message: `❌ Error: ${err.message?.slice(0, 200)}` };
  }
}

// Tool: get_mint_schedule
export async function tool_get_mint_schedule(params: { contract_address: string }): Promise<{
  success: boolean;
  data: MintScheduleInfo;
  message: string;
}> {
  initialize();
  if (!isValidAddress(params.contract_address)) {
    return { success: false, data: null as any, message: '❌ Contract address tidak valid.' };
  }

  try {
    const schedule = await mintScheduler.getMintSchedule(params.contract_address);

    let message = `📅 *Jadwal Minting*\n\n`;
    message += `📍 Contract: ${shortAddress(params.contract_address)}\n`;
    message += `🔗 Seadrop: ${schedule.isSeadrop ? 'Ya' : 'Bukan'}\n\n`;

    if (schedule.stages.length === 0) {
      message += `⚠️ Tidak ada jadwal minting yang terdeteksi on-chain.\n`;
      message += `Kemungkinan:\n`;
      message += `  • Contract bukan Seadrop\n`;
      message += `  • Jadwal belum di-set oleh creator\n`;
      message += `  • Contract menggunakan mekanisme schedule berbeda\n\n`;
      message += `💡 Coba cek langsung di halaman OpenSea collection untuk info jadwal.`;
    } else {
      for (const stage of schedule.stages) {
        const statusEmoji = stage.status === 'active' ? '🟢' : stage.status === 'upcoming' ? '🟡' : stage.status === 'ended' ? '🔴' : '⚪';
        message += `${statusEmoji} *Stage: ${stage.stageName}*\n`;
        if (stage.mintPrice) message += `  💰 Harga: ${stage.mintPrice} ETH\n`;
        if (stage.startTimeISO) message += `  🕐 Mulai: ${stage.startTimeISO}\n`;
        if (stage.endTimeISO) message += `  🕐 Selesai: ${stage.endTimeISO}\n`;
        if (stage.maxPerWallet) message += `  🎒 Max/Wallet: ${stage.maxPerWallet}\n`;
        if (stage.maxSupply) message += `  📦 Supply: ${stage.maxSupply}\n`;
        message += `  📊 Status: ${stage.status.toUpperCase()}\n\n`;
      }

      const upcoming = schedule.stages.find(s => s.status === 'upcoming');
      const active = schedule.stages.find(s => s.status === 'active');

      if (upcoming) {
        message += `💡 Ada stage UPCOMING! Gunakan \`schedule_mint\` untuk auto-mint saat waktunya tiba.\n`;
        if (upcoming.startTimeISO) {
          message += `   Jadwal: ${upcoming.startTimeISO}\n`;
        }
      } else if (active) {
        message += `💡 Minting SEDANG AKTIF! Gunakan \`mint_nft\` untuk mint sekarang.\n`;
      }
    }

    return { success: true, data: schedule, message };
  } catch (err: any) {
    return { success: false, data: null as any, message: `❌ Gagal baca schedule: ${err.message?.slice(0, 200)}` };
  }
}

// Tool: schedule_mint
export async function tool_schedule_mint(params: {
  contract_address: string;
  mint_price_eth: string;
  scheduled_time: string;
  quantity_per_wallet?: number;
  wallet_indices?: number[];
  concurrent?: number;
  mint_function?: string;
}): Promise<{
  success: boolean;
  data: ScheduledMintJob;
  message: string;
}> {
  initialize();

  if (!isValidAddress(params.contract_address)) {
    return { success: false, data: null as any, message: '❌ Contract address tidak valid.' };
  }

  // Parse scheduled_time - can be ISO string or Unix ms
  let scheduledMs: number;
  const parsed = Date.parse(params.scheduled_time);
  if (!isNaN(parsed)) {
    scheduledMs = parsed;
  } else {
    const asNumber = Number(params.scheduled_time);
    if (isNaN(asNumber) || asNumber <= 0) {
      return { success: false, data: null as any, message: '❌ Format waktu tidak valid. Gunakan ISO 8601 (contoh: "2025-06-01T18:00:00Z") atau Unix timestamp ms.' };
    }
    scheduledMs = asNumber;
  }

  const now = Date.now();
  if (scheduledMs <= now) {
    return { success: false, data: null as any, message: `❌ Waktu yang ditentukan sudah lewat (${new Date(scheduledMs).toISOString()}). Gunakan waktu yang akan datang.` };
  }

  // Check mint price
  const priceNum = parseFloat(params.mint_price_eth);
  if (priceNum > walletManager.getConfig().maxMintPriceEth) {
    return { success: false, data: null as any, message: `⚠️ Mint price (${params.mint_price_eth} ETH) melebihi batas (${walletManager.getConfig().maxMintPriceEth} ETH).` };
  }

  // Check for WL function
  if (params.mint_function && (params.mint_function.includes('presale') || params.mint_function.includes('allowlist'))) {
    return { success: false, data: null as any, message: `⚠️ Fungsi "${params.mint_function}" butuh Merkle proof. Scheduled auto-mint hanya support PUBLIC mint.` };
  }

  try {
    const job = mintScheduler.scheduleMint({
      contractAddress: params.contract_address,
      mintPriceEth: params.mint_price_eth,
      quantityPerWallet: params.quantity_per_wallet || 1,
      walletIndices: params.wallet_indices,
      concurrent: params.concurrent || 3,
      mintFunction: params.mint_function,
      scheduledTimeMs: scheduledMs,
    });

    const timeUntil = scheduledMs - now;
    const hoursUntil = Math.floor(timeUntil / 3600000);
    const minsUntil = Math.floor((timeUntil % 3600000) / 60000);

    let message = `⏰ *Minting Dijadwalkan!*\n\n`;
    message += `🆔 Job ID: ${job.id}\n`;
    message += `📍 Contract: ${shortAddress(params.contract_address)}\n`;
    message += `💰 Harga: ${params.mint_price_eth} ETH\n`;
    message += `📦 Quantity: ${params.quantity_per_wallet || 1} per wallet\n`;
    message += `🕐 Waktu: ${job.scheduledTimeISO}\n`;
    message += `⏳ Dalam: ${hoursUntil}j ${minsUntil}m\n`;
    message += `📊 Status: pending\n\n`;
    message += `💡 Gunakan \`list_scheduled_mints\` untuk monitoring.\n`;
    message += `💡 Gunakan \`cancel_scheduled_mint\` dengan job ID untuk membatalkan.\n\n`;
    message += `⚠️ Catatan: Scheduled mint hanya berfungsi untuk PUBLIC mint.\n`;
    message += `Untuk WL/allowlist mint, mint manual di OpenSea karena butuh proof.`;

    return { success: true, data: job, message };
  } catch (err: any) {
    return { success: false, data: null as any, message: `❌ Gagal schedule: ${err.message?.slice(0, 200)}` };
  }
}

// Tool: list_scheduled_mints
export async function tool_list_scheduled_mints(): Promise<{
  success: boolean;
  data: ScheduledMintJob[];
  message: string;
}> {
  initialize();
  const jobs = mintScheduler.getScheduledMints();

  if (jobs.length === 0) {
    return { success: true, data: [], message: '📋 Tidak ada minting yang dijadwalkan.\n\n💡 Gunakan `schedule_mint` untuk menjadwalkan auto-minting.' };
  }

  let message = `📋 *Scheduled Mints* (${jobs.length} jobs)\n\n`;

  for (const job of jobs) {
    const statusEmoji = job.status === 'pending' ? '⏳' :
                        job.status === 'executing' ? '🔄' :
                        job.status === 'completed' ? '✅' :
                        job.status === 'failed' ? '❌' :
                        job.status === 'cancelled' ? '🚫' : '❓';

    message += `${statusEmoji} *${job.id}*\n`;
    message += `  📍 ${shortAddress(job.contractAddress)} | 💰 ${job.mintPriceEth} ETH\n`;
    message += `  🕐 ${job.scheduledTimeISO}\n`;
    message += `  📊 Status: ${job.status}\n`;

    if (job.status === 'completed' && job.results) {
      const ok = job.results.filter(r => r.success).length;
      const fail = job.results.filter(r => !r.success).length;
      message += `  ✅ Berhasil: ${ok} | ❌ Gagal: ${fail}\n`;
    }
    if (job.status === 'failed' && job.error) {
      message += `  ❌ Error: ${truncate(job.error, 80)}\n`;
    }
    message += '\n';
  }

  const pending = jobs.filter(j => j.status === 'pending');
  if (pending.length > 0) {
    message += `💡 Gunakan \`cancel_scheduled_mint\` untuk membatalkan job yang masih pending.`;
  }

  return { success: true, data: jobs, message };
}

// Tool: cancel_scheduled_mint
export async function tool_cancel_scheduled_mint(params: { job_id: string }): Promise<{
  success: boolean;
  data: { jobId: string; cancelled: boolean };
  message: string;
}> {
  initialize();
  const cancelled = mintScheduler.cancelScheduledMint(params.job_id);

  if (cancelled) {
    return {
      success: true,
      data: { jobId: params.job_id, cancelled: true },
      message: `🚫 Job "${params.job_id}" berhasil dibatalkan.`,
    };
  } else {
    return {
      success: false,
      data: { jobId: params.job_id, cancelled: false },
      message: `❌ Gagal membatalkan job "${params.job_id}". Mungkin job sudah dieksekusi, selesai, atau tidak ditemukan.\n\n💡 Gunakan \`list_scheduled_mints\` untuk cek status jobs.`,
    };
  }
}

// Export all tools as a map for easy registration
export const TOOLS = {
  parse_mint_link: tool_parse_mint_link,
  detect_contract: tool_detect_contract,
  check_wallets: tool_check_wallets,
  mint_nft: tool_mint_nft,
  approve_seaport: tool_approve_seaport,
  list_nft: tool_list_nft,
  batch_list_nfts: tool_batch_list_nfts,
  get_mint_status: tool_get_mint_status,
  get_mint_schedule: tool_get_mint_schedule,
  schedule_mint: tool_schedule_mint,
  list_scheduled_mints: tool_list_scheduled_mints,
  cancel_scheduled_mint: tool_cancel_scheduled_mint,
};
