/**
 * Auto Mint Agent - Hermes Skill v3.0
 *
 * Skill ini menyediakan tools untuk auto-minting NFT dengan multi-wallet
 * dan listing interaktif di OpenSea. Termasuk browser-based minting
 * untuk website yang membutuhkan Connect Wallet / server signature.
 *
 * Flow:
 * 1. User kirim link → parse_mint_link untuk detect jenis
 * 2. detect_contract untuk cek info detail contract
 * 3a. Jika standard mint → mint_nft (direct contract, PARALLEL)
 * 3b. Jika butuh browser → scrape_contract_from_website + browser_mint (SEQUENTIAL)
 * 4. Agent DISKUSI dulu sama user mau list berapa
 * 5. list_nft / batch_list_nfts untuk listing setelah user setuju harga
 */

import { loadConfig, Config, validateChainId, CHAIN_IDS } from '../config';
import { WalletManager } from '../wallet';
import { DirectMinter, OpenSeaMinter, parseMintLink, ParsedMintInfo, MintResult, ContractInfo } from '../mint';
import { AutoLister, ListResult } from '../listing';
import { MintScheduler, MintScheduleInfo, ScheduledMintJob } from '../scheduler';
import { scrapeContractFromWebsite, ScrapeResult } from '../browser/scrape';
import { generateBrowserMintScripts, BrowserMintResult, generateMintDetectionScript } from '../browser/inject';
import { shortAddress, shortTxHash, truncate, isValidAddress, withRetry } from '../utils';
import { GasOracle, resolveGasMode } from '../gas/oracle';

// ============================================================
// SKILL DEFINITION - Hermes reads this to know available tools
// ============================================================

export const SKILL_DEFINITION = {
  name: 'nft-minting-skill',
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
    {
      name: 'scrape_contract_from_website',
      description: 'Extract contract address dari website NFT minting. Tool ini fetch HTML website dan cari contract address secara otomatis. Jika website SPA (React/Next.js) dan address tidak ditemukan via fetch, tool akan generate browser console script yang bisa dijalankan via browser_console() untuk extract dari rendered page.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL website minting (contoh: "https://onchainpepe.fun", "https://example.com/mint")',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_mint',
      description: 'Generate browser scripts untuk minting via website yang membutuhkan Connect Wallet atau server signature. Tool ini menghasilkan: (1) Wallet injection script (custom window.ethereum yang auto-sign TX), (2) Auto-click script untuk Connect/Mint buttons, (3) Multi-wallet rotation script, (4) Step-by-step guide. Agent menjalankan script ini via browser_console(). FALLBACK: Gunakan hanya jika direct contract minting (mint_nft) gagal karena butuh server signature.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL website minting yang mau di-mint via browser',
          },
          wallet_indices: {
            type: 'array',
            items: { type: 'number' },
            description: 'Index wallet yang dipakai. Kosongkan = semua wallet.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'get_skill_health',
      description: 'Cek kondisi skill: konektivitas RPC, balance semua wallet, status scheduler, dan gas mode. Berguna untuk monitoring real-time.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cancel_pending_tx',
      description: 'Cancel transaksi yang stuck di mempool dengan replace-by-fee (RBF). Kirim 0-value TX ke diri sendiri dengan nonce sama tapi gas lebih tinggi.',
      parameters: {
        type: 'object',
        properties: {
          tx_hash: { type: 'string', description: 'Transaction hash yang mau di-cancel' },
          wallet_index: { type: 'number', description: 'Index wallet pemilik TX (0-based)' },
          gas_bump: { type: 'number', description: 'Persentase gas bump (default: 20 = +20%)' },
        },
        required: ['tx_hash', 'wallet_index'],
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

  // BUG-016 FIX: Allow free mints (price 0) — only block if price exceeds max
  const priceNum = parseFloat(mint_price_eth);
  if (priceNum < 0) {
    return { success: false, data: [], message: '❌ Mint price tidak boleh negatif.' };
  }
  if (priceNum > walletManager.getConfig().maxMintPriceEth) {
    return {
      success: false, data: [],
      message: `⚠️ Mint price (${mint_price_eth} ETH) melebihi MAX_MINT_PRICE_ETH (${walletManager.getConfig().maxMintPriceEth} ETH). Ubah config atau konfirmasi manual.`,
    };
  }

  // BUG-008 FIX: Validate concurrent parameter — cap at wallet count
  const walletCount = wallet_indices?.length || walletManager.getWalletCount();
  const effectiveConcurrent = Math.min(concurrent, walletCount);

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
        concurrent: effectiveConcurrent,
        mintFunction: mint_function || contractInfo.functionSignature || undefined,
      });
    } else {
      // No mint function detected via direct contract, try OpenSea/Seadrop
      results = await openSeaMinter.mint({
        contractAddress: contract_address,
        mintPrice: mint_price_eth,
        quantity: quantity_per_wallet,
        walletsToUse: wallet_indices,
        concurrent: effectiveConcurrent,
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
// BUG-006 FIX: Distinguish "pending" vs "not_found" by also checking getTransaction
export async function tool_get_mint_status(params: { tx_hash: string }): Promise<{
  success: boolean;
  data: { status: string; blockNumber: number | null; gasUsed: string | null };
  message: string;
}> {
  initialize();
  try {
    const provider = walletManager.getProvider();
    const receipt = await provider.getTransactionReceipt(params.tx_hash);
    if (receipt) {
      const status = receipt.status === 1 ? 'confirmed' : 'reverted';
      const emoji = receipt.status === 1 ? '✅' : '❌';
      return {
        success: receipt.status === 1,
        data: { status, blockNumber: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() },
        message: `${emoji} TX ${shortTxHash(params.tx_hash)} ${status}\n📦 Block: ${receipt.blockNumber}\n⛽ Gas: ${receipt.gasUsed.toString()}`,
      };
    }

    // Receipt is null — check if TX exists in mempool
    const tx = await provider.getTransaction(params.tx_hash);
    if (tx) {
      return {
        success: true,
        data: { status: 'pending', blockNumber: null, gasUsed: null },
        message: `⏳ TX ${shortTxHash(params.tx_hash)} masih pending di mempool...`,
      };
    }

    // TX not found anywhere
    return {
      success: false,
      data: { status: 'not_found', blockNumber: null, gasUsed: null },
      message: `❓ TX ${shortTxHash(params.tx_hash)} tidak ditemukan. Pastikan hash benar atau TX mungkin sudah dropped dari mempool.`,
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

    // BUG-025 FIX: Add countdown for pending jobs
    if (job.status === 'pending') {
      const now = Date.now();
      const diff = job.scheduledTime - now;
      if (diff > 0) {
        const hours = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        message += `  ⏳ Countdown: ${hours}j ${mins}m ${secs}s\n`;
      } else {
        message += `  ⏳ Siap dieksekusi\n`;
      }
    }

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

// Tool: scrape_contract_from_website
export async function tool_scrape_contract_from_website(params: { url: string }): Promise<{
  success: boolean;
  data: ScrapeResult;
  message: string;
}> {
  initialize();

  if (!params.url || !params.url.startsWith('http')) {
    return { success: false, data: null as any, message: '❌ URL tidak valid. Harus dimulai dengan http:// atau https://' };
  }

  try {
    const result = await scrapeContractFromWebsite(params.url);

    let message = `🌐 *Contract Scrape Results*\n\n`;
    message += `📍 URL: ${result.url}\n`;
    message += `🔧 Method: ${result.method === 'server_fetch' ? 'Server-side fetch' : 'Browser needed (SPA)'}\n`;
    message += `🎯 Confidence: ${result.confidence}\n`;

    if (result.chain) {
      message += `🔗 Chain: ${result.chain}\n`;
    }

    message += `\n`;

    if (result.contractAddresses.length > 0) {
      const nftOnes = result.contractAddresses.filter(a => a.isLikelyNFT);
      const otherOnes = result.contractAddresses.filter(a => !a.isLikelyNFT);

      if (nftOnes.length > 0) {
        message += `🎯 *Kemungkinan NFT Contract:*\n`;
        for (const addr of nftOnes.slice(0, 5)) {
          message += `  ✅ ${addr.address} (${addr.source})\n`;
          if (addr.context) {
            message += `     Context: ${truncate(addr.context, 80)}\n`;
          }
        }
        message += `\n`;
      }

      if (otherOnes.length > 0) {
        message += `📋 *Address lain ditemukan:*\n`;
        for (const addr of otherOnes.slice(0, 5)) {
          message += `  ⚪ ${addr.address} (${addr.source})\n`;
        }
        message += `\n`;
      }

      // Suggest next step
      const topAddress = nftOnes[0]?.address || otherOnes[0]?.address;
      if (topAddress) {
        message += `💡 *Next Step:*\n`;
        message += `   Gunakan \`detect_contract\` untuk cek detail: detect_contract({ contract_address: "${topAddress}" })\n`;
      }
    } else {
      message += `❌ Tidak ada contract address ditemukan via server-side fetch.\n\n`;
    }

    if (result.browserScript) {
      message += `\n🔧 *Browser Script Tersedia:*\n`;
      message += `   Website ini SPA, butuh browser untuk extract.\n`;
      message += `   Script ada di data.browserScript — jalankan via browser_console().\n`;
      message += `\n   Langkah:\n`;
      message += `   1. browser_navigate(url="${result.url}")\n`;
      message += `   2. browser_wait(duration=5)\n`;
      message += `   3. browser_console(expression=data.browserScript)\n`;
    }

    if (result.notes.length > 0) {
      message += `\n📝 Catatan:\n`;
      for (const n of result.notes) {
        message += `  • ${n}\n`;
      }
    }

    return {
      success: result.contractAddresses.length > 0,
      data: result,
      message,
    };
  } catch (err: any) {
    return { success: false, data: null as any, message: `❌ Scrape gagal: ${err.message?.slice(0, 300)}` };
  }
}

// Tool: browser_mint
export async function tool_browser_mint(params: {
  url: string;
  wallet_indices?: number[];
}): Promise<{
  success: boolean;
  data: BrowserMintResult;
  message: string;
}> {
  initialize();

  if (!params.url || !params.url.startsWith('http')) {
    return { success: false, data: null as any, message: '❌ URL tidak valid. Harus dimulai dengan http:// atau https://' };
  }

  try {
    const scripts = generateBrowserMintScripts(config, walletManager, {
      url: params.url,
      walletIndices: params.wallet_indices,
    });

    let message = `🌐 *Browser Minting Scripts Generated*\n\n`;
    message += `📍 URL: ${params.url}\n`;
    message += `💼 Wallets: ${scripts.walletScripts.length}\n\n`;

    message += `📋 *Wallet Injection Scripts:*\n`;
    for (const ws of scripts.walletScripts) {
      message += `  🔑 Wallet ${ws.walletIndex}: ${shortAddress(ws.address)}\n`;
      message += `     Script: data.walletScripts[${ws.walletIndex}].injectScript\n`;
    }
    message += `\n`;

    message += `🔄 *Multi-Wallet Rotation Script:*\n`;
    message += `   data.multiWalletScript — Auto-rotate semua wallet\n`;
    message += `   (Sequential: inject → connect → mint → next)\n\n`;

    message += `👆 *Auto-Click Script:*\n`;
    message += `   data.autoClickScript — Auto-detect Connect/Mint buttons\n\n`;

    message += `📖 *Step-by-Step Guide:*\n`;
    for (const step of scripts.stepByStepGuide) {
      message += `   ${step}\n`;
    }
    message += `\n`;

    // Warnings
    message += `⚠️ *WARNINGS:*\n`;
    for (const w of scripts.warnings) {
      message += `  • ${w}\n`;
    }
    message += `\n`;

    // Decision helper
    message += `💡 *Decision Helper:*\n`;
    message += `   Coba dulu detect_contract() → kalau function signature:\n`;
    message += `   • mint(uint256) → ✅ Pakai mint_nft (lebih cepat, parallel)\n`;
    message += `   • mint(uint256,bytes) → ⚠️ Butuh signature → Pakai browser_mint\n`;
    message += `   • mintSigned(uint256,bytes,bytes32) → ❌ Wajib browser_mint\n`;

    return { success: true, data: scripts, message };
  } catch (err: any) {
    return { success: false, data: null as any, message: `❌ Browser mint script generation gagal: ${err.message?.slice(0, 300)}` };
  }
}

// ============================================================
// NEW TOOLS v3.0
// ============================================================

// Tool 15: get_skill_health
// Check RPC connectivity, wallet balances, and scheduler status
export async function tool_get_skill_health(): Promise<{
  success: boolean;
  data: {
    rpc: { connected: boolean; chainId: number; chainName: string; latencyMs: number };
    wallets: { index: number; address: string; ethBalance: string; pendingTxCount: number }[];
    scheduler: { pendingJobs: number; nextJobIn: string | null; totalJobs: number };
    gasMode: string;
    warnings: string[];
  };
  message: string;
}> {
  initialize();
  const warnings: string[] = [];
  const provider = walletManager.getProvider();

  // RPC connectivity check
  let rpcStatus = { connected: false, chainId: 0, chainName: config.chain, latencyMs: 0 };
  try {
    const start = Date.now();
    const network = await provider.getNetwork();
    rpcStatus = {
      connected: true,
      chainId: Number(network.chainId),
      chainName: config.chain,
      latencyMs: Date.now() - start,
    };
    const expected = CHAIN_IDS[config.chain] || 1;
    if (rpcStatus.chainId !== expected) {
      warnings.push(`Chain mismatch: config says "${config.chain}" (${expected}) but RPC reports ${rpcStatus.chainId}`);
    }
  } catch (err: any) {
    warnings.push(`RPC connection failed: ${err.message?.slice(0, 100)}`);
  }

  // Wallet balances
  const walletData: { index: number; address: string; ethBalance: string; pendingTxCount: number }[] = [];
  try {
    const balances = await walletManager.getBalances();
    for (const b of balances) {
      walletData.push({ index: b.walletIndex, address: b.address, ethBalance: b.ethBalance, pendingTxCount: 0 });
      if (parseFloat(b.ethBalance) < 0.005) {
        warnings.push(`Wallet ${b.walletIndex} (${shortAddress(b.address)}) has low balance: ${b.ethBalance} ETH`);
      }
    }
  } catch (err: any) {
    warnings.push(`Failed to fetch wallet balances: ${err.message?.slice(0, 100)}`);
  }

  // Scheduler status
  const jobs = mintScheduler.getScheduledMints();
  const pendingJobs = jobs.filter(j => j.status === 'pending');
  const nextJob = pendingJobs.sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
  let nextJobIn: string | null = null;
  if (nextJob) {
    const diff = nextJob.scheduledTime - Date.now();
    if (diff > 0) {
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      nextJobIn = `${h}h ${m}m`;
    } else {
      nextJobIn = 'ready';
    }
  }

  const schedulerStatus = {
    pendingJobs: pendingJobs.length,
    nextJobIn,
    totalJobs: jobs.length,
  };

  if (pendingJobs.length === 0) {
    warnings.push('No pending scheduled mints.');
  }

  // Build message
  let message = `🏥 *Skill Health Check*\n\n`;
  message += `🔗 RPC: ${rpcStatus.connected ? '✅ Connected' : '❌ Disconnected'} | Chain ${rpcStatus.chainId} (${rpcStatus.chainName}) | ${rpcStatus.latencyMs}ms\n`;
  message += `💼 Wallets: ${walletData.length}\n`;
  for (const w of walletData) {
    const emoji = parseFloat(w.ethBalance) > 0.01 ? '✅' : '⚠️';
    message += `  ${emoji} ${w.index}: ${shortAddress(w.address)} — ${w.ethBalance} ETH\n`;
  }
  message += `\n⏰ Scheduler: ${schedulerStatus.pendingJobs} pending / ${schedulerStatus.totalJobs} total`;
  if (schedulerStatus.nextJobIn) message += ` | Next: ${schedulerStatus.nextJobIn}`;
  message += `\n⛽ Gas Mode: ${config.gasMode}`;

  if (warnings.length > 0) {
    message += `\n\n⚠️ Warnings:\n`;
    for (const w of warnings) message += `  • ${w}\n`;
  }

  return {
    success: warnings.length === 0 || (rpcStatus.connected && walletData.length > 0),
    data: {
      rpc: rpcStatus,
      wallets: walletData,
      scheduler: schedulerStatus,
      gasMode: config.gasMode,
      warnings,
    },
    message,
  };
}

// Tool 16: cancel_pending_tx
// Cancel a stuck transaction by sending a 0-value TX to self with same nonce but higher gas (RBF)
export async function tool_cancel_pending_tx(params: {
  tx_hash: string;
  wallet_index: number;
  gas_bump?: number;
}): Promise<{
  success: boolean;
  data: { cancelTxHash: string | null; originalNonce: number | null };
  message: string;
}> {
  initialize();
  const { tx_hash, wallet_index, gas_bump = 20 } = params;

  const walletInfo = walletManager.getWallet(wallet_index);
  if (!walletInfo) {
    return { success: false, data: { cancelTxHash: null, originalNonce: null }, message: `❌ Wallet ${wallet_index} tidak ditemukan.` };
  }

  try {
    const provider = walletManager.getProvider();

    // Get the original TX to find its nonce
    const originalTx = await provider.getTransaction(tx_hash);
    if (!originalTx) {
      return { success: false, data: { cancelTxHash: null, originalNonce: null }, message: `❌ TX ${shortTxHash(tx_hash)} tidak ditemukan di mempool atau chain.` };
    }

    const nonce = originalTx.nonce;

    // Get current gas price and bump it
    const feeData = await provider.getFeeData();
    const currentMaxFee = feeData.maxFeePerGas ?? (await provider.getFeeData()).gasPrice ?? BigInt(0);
    const currentPriorityFee = feeData.maxPriorityFeePerGas ?? BigInt(0);

    const bumpMultiplier = BigInt(100 + gas_bump);
    const newMaxFee = (currentMaxFee * bumpMultiplier) / BigInt(100);
    const newPriorityFee = (currentPriorityFee * bumpMultiplier) / BigInt(100);

    if (config.dryRun) {
      return {
        success: true,
        data: { cancelTxHash: '0x_dry_run', originalNonce: Number(nonce) },
        message: `[DRY RUN] Would cancel TX ${shortTxHash(tx_hash)} with nonce ${nonce}, gas bump ${gas_bump}%`,
      };
    }

    // Send cancel TX: 0 value to self, same nonce, higher gas
    const cancelTx = await walletInfo.wallet.sendTransaction({
      to: walletInfo.address,
      value: BigInt(0),
      nonce: nonce,
      maxFeePerGas: newMaxFee,
      maxPriorityFeePerGas: newPriorityFee,
      gasLimit: BigInt(21000),
    });

    return {
      success: true,
      data: { cancelTxHash: cancelTx.hash, originalNonce: Number(nonce) },
      message: `✅ Cancel TX sent!\nOriginal: ${shortTxHash(tx_hash)} (nonce ${nonce})\nCancel: ${shortTxHash(cancelTx.hash)}\nGas bump: +${gas_bump}%`,
    };
  } catch (err: any) {
    return { success: false, data: { cancelTxHash: null, originalNonce: null }, message: `❌ Cancel gagal: ${err.message?.slice(0, 200)}` };
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
  scrape_contract_from_website: tool_scrape_contract_from_website,
  browser_mint: tool_browser_mint,
  get_skill_health: tool_get_skill_health,
  cancel_pending_tx: tool_cancel_pending_tx,
};
