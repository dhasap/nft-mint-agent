# 🤖 Auto Mint Agent - Hermes Skill v2.1

Skill untuk Hermes agent yang menyediakan tools auto-minting NFT dengan multi-wallet support, browser-based minting, scheduled minting, dan listing interaktif di OpenSea.

## ✨ Kenapa Skill, Bukan Bot?

Skill ini dirancang untuk dipakai oleh **Hermes agent** melalui gateway. Hermes yang handle Telegram, skill cuma provide tools yang bisa dipanggil. Artinya:

- Hermes agent yang ngobrol sama user via Telegram
- User kirim link → agent panggil `parse_mint_link` atau `scrape_contract_from_website`
- Agent diskusi sama user (konfirmasi mint, bahas harga listing)
- Baru agent eksekusi minting & listing via tools

## 🔧 Tools yang Tersedia (14 Tools)

### Informasi & Deteksi
| Tool | Deskripsi |
|------|-----------|
| `parse_mint_link` | Parse link minting, detect jenis (direct contract vs OpenSea/Seadrop) |
| `detect_contract` | Cek detail contract (nama, harga, supply, mint function signature) |
| `check_wallets` | Cek balance ETH semua wallet |
| `get_mint_schedule` | Baca jadwal minting on-chain (Seadrop: public/allowlist start & end time) |
| `get_mint_status` | Cek status TX minting (confirmed/pending/reverted) |
| `scrape_contract_from_website` 🆕 | Extract contract address dari website NFT minting (server-side + browser fallback) |

### Eksekusi
| Tool | Deskripsi |
|------|-----------|
| `mint_nft` | Execute minting dengan multi-wallet secara **PARALLEL** (direct contract) |
| `browser_mint` 🆕 | Mint via browser untuk website yang butuh Connect Wallet / server signature (**SEQUENTIAL** fallback) |
| `schedule_mint` | Jadwalkan auto-minting di waktu tertentu |
| `list_scheduled_mints` | Lihat semua minting yang dijadwalkan |
| `cancel_scheduled_mint` | Batalkan minting yang dijadwalkan |

### Listing
| Tool | Deskripsi |
|------|-----------|
| `approve_seaport` | Approve Seaport (OpenSea) untuk listing |
| `list_nft` | List 1 NFT di OpenSea dengan harga yang disepakati |
| `batch_list_nfts` | List banyak NFT sekaligus |

## 🎯 Hybrid Approach: Direct Contract vs Browser

Skill ini menggunakan **2-layer approach** untuk maximise coverage:

```
Layer 1: Direct Contract (mint_nft)
   ⚡ PARALLEL, cepat, multi-wallet simultan
   → Standard mint: mint(uint256), claim(uint256), mintPublic(uint256)
   ↓ Kalau gagal / butuh server signature

Layer 2: Browser-Based (browser_mint)
   🐌 SEQUENTIAL, satu wallet per waktu, tapi covers semua kasus
   → Butuh Connect Wallet / server signature / frontend validation
```

| Mint Function | Approach |
|---------------|----------|
| `mint(uint256)` | ✅ Direct contract (`mint_nft`) |
| `claim(uint256)` | ✅ Direct contract (`mint_nft`) |
| `mintPublic(uint256)` | ✅ Direct contract (`mint_nft`) |
| `mint(uint256,bytes)` | ⚠️ Coba direct dulu, fallback ke browser |
| `mintSigned(address,uint256,bytes)` | ❌ Wajib browser (`browser_mint`) |
| Connect Wallet required | ❌ Wajib browser (`browser_mint`) |

## 🔄 Flow Interaktif

Skill ini dirancang dengan flow **diskusi dulu, eksekusi belakangan**:

### Flow: Direct Contract Mint
```
User kirim link / contract address
    ↓
Agent → parse_mint_link / scrape_contract_from_website
    ↓
Agent → detect_contract (cek detail & function signature)
    ↓
Agent diskusi: "Mau mint berapa? Pakai berapa wallet? Harga mintnya oke?"
    ↓
User konfirmasi
    ↓
Agent → check_wallets → mint_nft (execute PARALLEL)
    ↓
Agent tanya: "Mau di-list? Harga berapa per NFT?"
    ↓
Agent → approve_seaport → list_nft / batch_list_nfts
    ↓
Done! 🎉
```

### Flow: Browser Mint
```
User kirim website URL minting
    ↓
Agent → scrape_contract_from_website (cari contract address)
    ↓
Jika butuh browser / server signature
    ↓
Agent → browser_mint (generate scripts)
    ↓
Agent → browser_navigate → browser_console (inject wallet)
    ↓
Agent → auto-click Connect Wallet → auto-click Mint
    ↓
Rotate wallet berikutnya (SEQUENTIAL)
    ↓
Agent → Destroy browser instance
    ↓
Done! 🎉
```

### Flow: Scheduled Mint
```
User kirim link + jadwal minting
    ↓
Agent → get_mint_schedule (baca jadwal on-chain)
    ↓
Agent → schedule_mint (jadwalkan auto-mint)
    ↓
... tunggu sampai waktunya ...
    ↓
Auto-execute minting saat waktunya tiba
    ↓
Done! 🎉
```

**❌ JANGAN** auto-list tanpa diskusi harga dulu!
**✅ SELALU** tanya user mau list berapa sebelum listing.

## 🚀 Setup

### 1. Install
```bash
cd auto-mint-agent
npm install
npm run build
```

### 2. Configure
```bash
cp .env.example .env
# Edit .env dengan RPC URL, wallet private keys, dll
```

### 3. Setup Wallets

**Pakai wallet yang sudah ada:**
```
WALLET_PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
```

**Generate wallet baru:**
```bash
npm run generate-wallets 10
# Copy private keys ke .env
# Fund setiap wallet dengan ETH
```

### 4. Pakai dari Hermes Agent
```typescript
import { TOOLS, SKILL_DEFINITION } from 'auto-mint-agent';

// === Informasi & Deteksi ===

// Parse link minting
const parsed = await TOOLS.parse_mint_link({ url: 'https://opensea.io/collection/my-nft' });

// Scrape contract dari website (NEW v2.1)
const scrape = await TOOLS.scrape_contract_from_website({ url: 'https://onchainpepe.fun' });
// → Returns contract addresses + browser script jika SPA

// Detect contract detail
const info = await TOOLS.detect_contract({ contract_address: '0x...' });

// Check wallet balances
const balances = await TOOLS.check_wallets();

// Get mint schedule on-chain
const schedule = await TOOLS.get_mint_schedule({ contract_address: '0x...' });

// === Eksekusi ===

// Direct contract minting (PARALLEL, cepat)
const results = await TOOLS.mint_nft({
  contract_address: '0x...',
  mint_price_eth: '0.05',
  quantity_per_wallet: 1,
  wallet_indices: [0, 1, 2],
});

// Browser-based minting (SEQUENTIAL, fallback) (NEW v2.1)
const scripts = await TOOLS.browser_mint({ url: 'https://onchainpepe.fun' });
// → Returns wallet injection scripts, auto-click script, step-by-step guide
// Agent executes via: browser_navigate → browser_console(expression=script)

// Schedule auto-minting
const job = await TOOLS.schedule_mint({
  contract_address: '0x...',
  mint_price_eth: '0.05',
  scheduled_time: '2025-06-01T18:00:00Z',
  quantity_per_wallet: 1,
});

// Monitor & cancel scheduled mints
const jobs = await TOOLS.list_scheduled_mints();
await TOOLS.cancel_scheduled_mint({ job_id: 'mint_xxx' });

// === Listing ===

// Approve Seaport first
await TOOLS.approve_seaport({ contract_address: '0x...' });

// List single NFT (AFTER discussing price with user!)
const listResult = await TOOLS.list_nft({
  contract_address: '0x...',
  token_id: '123',
  price_eth: '0.1',
  wallet_index: 0,
});

// Batch list multiple NFTs
const batchResult = await TOOLS.batch_list_nfts({
  items: [
    { contract_address: '0x...', token_id: '1', price_eth: '0.1', wallet_index: 0 },
    { contract_address: '0x...', token_id: '2', price_eth: '0.1', wallet_index: 1 },
  ],
});
```

## ⚙️ Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RPC_URL` | Ethereum RPC endpoint | Required |
| `RPC_WS_URL` | WebSocket RPC endpoint | Optional |
| `CHAIN` | Blockchain (ethereum/polygon/arbitrum/optimism/base/zora/blast) | ethereum |
| `WALLET_PRIVATE_KEYS` | Comma-separated private keys | Required |
| `MAX_GAS_PRICE_GWEI` | Maximum gas price | 100 |
| `PRIORITY_FEE_GWEI` | Priority fee for EIP-1559 | 2 |
| `GAS_LIMIT_MULTIPLIER` | Gas limit buffer multiplier | 1.2 |
| `DEFAULT_MINT_QUANTITY` | NFTs per wallet | 1 |
| `MAX_MINT_PRICE_ETH` | Maximum mint price safety limit | 0.5 |
| `OPENSEA_API_KEY` | OpenSea API key for listing | Optional |
| `DRY_RUN` | Simulate without real transactions | false |

## 📁 Project Structure

```
auto-mint-agent/
├── src/
│   ├── tools/index.ts      # 🔑 14 Tool definitions & implementations
│   ├── mint/
│   │   ├── parser.ts       # Link parser & mint type detector
│   │   ├── direct.ts       # Direct contract minter (PARALLEL)
│   │   ├── opensea.ts      # OpenSea/Seadrop minter
│   │   └── index.ts
│   ├── browser/
│   │   ├── scrape.ts       # 🆕 Contract scraping from websites
│   │   └── inject.ts       # 🆕 Wallet injection & browser minting scripts
│   ├── wallet/
│   │   ├── index.ts        # Multi-wallet manager
│   │   └── generate.ts     # Wallet generator CLI
│   ├── scheduler/
│   │   └── index.ts        # Scheduled auto-minting
│   ├── listing/index.ts    # OpenSea listing logic
│   ├── config/index.ts     # Config loader, ABIs & constants
│   ├── utils/index.ts      # Helper functions
│   └── index.ts            # Entry point
├── SKILL.md                # Technical documentation (for developers)
├── AGENT.md                # Agent instructions (for Hermes agent)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## 🌐 Supported Chains

| Chain | Chain ID | Direct Mint | Seadrop | Schedule | Listing | Browser Mint |
|-------|----------|-------------|---------|----------|---------|-------------|
| Ethereum | 1 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Arbitrum | 42161 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zora | 7777777 | ✅ | ❌ | ❌ | ❌ | ✅ |
| Blast | 81457 | ✅ | ❌ | ❌ | ❌ | ✅ |

## ⚠️ Safety Notes

- Set `DRY_RUN=true` untuk testing tanpa real transactions
- `MAX_MINT_PRICE_ETH` mencegah minting yang terlalu mahal
- `MAX_GAS_PRICE_GWEI` mencegah gas war
- Selalu verify contract address sebelum minting
- Private keys jangan pernah di-share!
- **Browser minting:** Private keys ada di browser memory selama sesi — selalu gunakan isolated browser (Browserbase) dan destroy setelah selesai

## 📝 Important Limitations

- **WL/Allowlist mint** — Tidak bisa di-automasi karena OpenSea mengelola Merkle proof server-side. Untuk WL mint, user harus mint manual di OpenSea.
- **Scheduled mint** — Hanya berfungsi untuk PUBLIC mint. Agent harus tetap berjalan sampai waktu eksekusi tiba.
- **Browser minting** — SEQUENTIAL (lebih lambat dari direct contract yang PARALLEL). Setiap website punya DOM structure berbeda, auto-click mungkin perlu disesuaikan.
- **Listing via API** — Membutuhkan EIP-712 signing. Jika gagal, berikan URL manual OpenSea ke user.

## 📜 Disclaimer

This tool is for educational purposes only. Use at your own risk. NFT minting involves financial risk. Always do your own research before minting any NFT.
