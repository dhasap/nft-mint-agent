# SKILL.md — Auto Mint Agent v3.0

> Hermes Skill untuk auto-minting NFT dengan multi-wallet, scheduled minting, browser-based minting, dan listing interaktif di OpenSea.

## Deskripsi

Skill ini menyediakan 16 tools yang bisa dipanggil oleh Hermes agent untuk:
- Parse link minting dan detect jenis (direct contract vs OpenSea/Seadrop)
- Detect informasi detail smart contract NFT
- Baca jadwal minting on-chain (Seadrop: public/allowlist start & end time)
- Jadwalkan auto-minting di waktu tertentu (scheduled mint)
- Execute minting dengan banyak wallet secara simultan (direct contract)
- Extract contract address dari website minting (server-side + browser fallback)
- Browser-based minting untuk website yang butuh Connect Wallet / server signature
- Approve & list NFT di OpenSea (dengan diskusi harga terlebih dahulu)

## ⚠️ Competitive / Hot Drop Fast-Mint Runbook

For **auto mint**, **max mint**, **FCFS**, limited supply, or any drop likely to sell out in seconds, use `fast-mint.mjs` instead of `schedule_mint` / browser clicking / agent cron. Agent/tool overhead and live `estimateGas` can add seconds and lose the mint.

### Preflight (no transaction)
```bash
cd /root/nft-minting-skill
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --status
```

### Competitive broadcast
```bash
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" \
  --time auto \
  --qty max \
  --wallets 0,1 \
  --gas-mode aggressive \
  --priority-gwei 2 \
  --max-fee-gwei 100 \
  --early-ms 750
```

### Mandatory rules learned from PLOP failure
1. **On-chain SeaDrop data wins.** Always use live `getPublicDrop()` for `mintPrice`, `startTime`, `endTime`, and `maxTotalMintableByWallet`. OpenSea UI/SSR can be stale or wrong.
2. **Resolve actual SeaDrop minter.** Newer OpenSea mainnet ERC721SeaDrop contracts may use `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`; skip addresses with no bytecode and verify candidate via `getPublicDrop(nft)`.
3. **Recompute value at broadcast.** If price changes from `0` to paid, send `value = mintPrice * qty` or skip if it exceeds `MAX_MINT_PRICE_ETH` / wallet balance.
4. **Fund for upfront gas.** Wallet needs `mintPrice * qty + gasLimit * maxFeePerGas` upfront. Tiny balances lose hot mints even if mint price is zero.
5. **No live estimate delay.** Fast-mint pre-warms RPC/nonces/gas/feeRecipient and signs raw EIP-1559 transactions; it does not block on `estimateGas` at mint time.
6. **Aggressive gas by default.** For hot mints use `--gas-mode aggressive`, explicit `--priority-gwei`, and enough ETH. Conservative gas loses placement.
7. **WIB output.** Schedules/status/results should show `Asia/Jakarta`/WIB times.

Use regular `mint_nft` or `schedule_mint` only for low-competition mints where seconds do not matter.

## Prasyarat

Skill ini membutuhkan environment variables berikut di `.env`:

```
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN=ethereum
WALLET_PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
MAX_GAS_PRICE_GWEI=100
PRIORITY_FEE_GWEI=2
MAX_MINT_PRICE_ETH=0.5
OPENSEA_API_KEY=your_key
DRY_RUN=false
```

## Tools

### 1. `parse_mint_link`
Parse link minting untuk mendeteksi jenis mint.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | ✅ | URL minting atau contract address |

**Returns:** `{ success, data: ParsedMintInfo, message }`
- `data.type`: `"direct_contract"` | `"opensea_seadrop"` | `"unknown"`
- `data.contractAddress`: contract address jika terdeteksi
- `data.openseaSlug`: slug OpenSea jika ada
- `data.confidence`: `"high"` | `"medium"` | `"low"`

---

### 2. `detect_contract`
Detect informasi detail dari smart contract NFT.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT (0x...) |

**Returns:** `{ success, data: ContractInfo, message }`
- `data.name`: nama collection
- `data.mintPrice`: harga mint dalam ETH
- `data.maxSupply` / `data.totalSupply`: supply info
- `data.maxPerWallet`: max mint per wallet
- `data.functionSignature`: fungsi mint yang terdeteksi
- `data.isMintable`: apakah contract bisa di-mint

---

### 3. `check_wallets`
Cek balance ETH semua wallet yang terdaftar.

**Parameters:** (tidak ada)

**Returns:** `{ success, data: WalletBalance[], message }`
- `data[].address`: wallet address
- `data[].ethBalance`: balance dalam ETH
- `data[].walletIndex`: index wallet

---

### 4. `mint_nft`
Execute minting NFT dengan multi-wallet secara simultan.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT |
| `mint_price_eth` | string | ✅ | Harga mint per NFT dalam ETH (set "0" untuk free mint) |
| `quantity_per_wallet` | number | ❌ | Jumlah NFT per wallet (default: 1) |
| `wallet_indices` | number[] | ❌ | Index wallet yang dipakai. Kosongkan = semua wallet |
| `concurrent` | number | ❌ | Jumlah wallet yang mint bersamaan (default: 3) |
| `mint_function` | string | ❌ | Override mint function signature. Kosongkan = auto-detect |

**Returns:** `{ success, data: MintResult[], message }`
- `data[].success`: apakah minting berhasil
- `data[].txHash`: transaction hash
- `data[].tokenIds[]`: semua token ID yang berhasil di-mint
- `data[].gasUsed`: gas yang terpakai

---

### 5. `approve_seaport`
Approve Seaport (OpenSea) untuk transfer NFT dari wallet.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT |
| `wallet_index` | number | ❌ | Index wallet yang di-approve. Kosongkan = batch semua wallet |

**Returns:** `{ success, data: ApprovalResult[], message }`

---

### 6. `list_nft`
List 1 NFT di OpenSea dengan harga tertentu.

**⚠️ PENTING:** WAJIB diskusi harga dengan user terlebih dahulu sebelum memanggil tool ini!

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT |
| `token_id` | string | ✅ | Token ID NFT |
| `price_eth` | string | ✅ | Harga listing dalam ETH |
| `wallet_index` | number | ✅ | Index wallet pemilik NFT |
| `expiration_hours` | number | ❌ | Durasi listing dalam jam (default: 168 / 1 minggu) |

**Returns:** `{ success, data: ListResult, message }`

**Catatan:** Listing via OpenSea API membutuhkan API key dan EIP-712 signing. Jika API listing gagal, tool akan memberikan URL manual untuk listing di OpenSea.

---

### 7. `batch_list_nfts`
List banyak NFT sekaligus di OpenSea.

**⚠️ PENTING:** WAJIB diskusi harga dengan user terlebih dahulu!

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `items` | array | ✅ | Array of `{ contract_address, token_id, price_eth, wallet_index }` |

**Returns:** `{ success, data: ListResult[], message }`

---

### 8. `get_mint_status`
Cek status transaksi minting.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tx_hash` | string | ✅ | Transaction hash |

**Returns:** `{ success, data: { status, blockNumber, gasUsed }, message }`
- `data.status`: `"confirmed"` | `"reverted"` | `"pending"` | `"error"`

---

### 9. `get_mint_schedule`
Baca jadwal minting on-chain dari smart contract. Untuk Seadrop/OpenSea contracts, bisa membaca public & allowlist drop schedule termasuk start time, end time, harga, dan max per wallet.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT (0x...) |

**Returns:** `{ success, data: MintScheduleInfo, message }`
- `data.isSeadrop`: apakah contract menggunakan Seadrop
- `data.stages[]`: array of mint stages
  - `stageName`: "public" | "allowlist" | "stage_N"
  - `mintPrice`: harga mint dalam ETH
  - `startTime` / `endTime`: Unix timestamp
  - `startTimeISO` / `endTimeISO`: ISO 8601 format
  - `maxPerWallet`: max mint per wallet
  - `status`: "active" | "upcoming" | "ended" | "unknown"

**Cara kerja:**
1. Coba baca dari Seadrop contract (`getPublicDrop`, `getAllowListDrop`, `getDropStageInfo`)
2. Jika bukan Seadrop, coba baca dari contract langsung (`saleStartTime`, `mintStart`)
3. Setiap stage dilabeli status: active/upcoming/ended

---

### 10. `schedule_mint`
Jadwalkan auto-minting di waktu tertentu. Agent akan otomatis execute mint saat waktunya tiba.

**⚠️ PENTING:**
- Hanya berfungsi untuk **PUBLIC mint**
- Untuk WL/allowlist mint, Merkle proof dibutuhkan dan harus mint manual di OpenSea
- Agent harus tetap berjalan sampai waktu eksekusi tiba

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contract_address` | string | ✅ | Contract address NFT |
| `mint_price_eth` | string | ✅ | Harga mint per NFT dalam ETH |
| `scheduled_time` | string | ✅ | Waktu eksekusi (ISO 8601 atau Unix ms). Contoh: `"2025-06-01T18:00:00Z"` |
| `quantity_per_wallet` | number | ❌ | Jumlah NFT per wallet (default: 1) |
| `wallet_indices` | number[] | ❌ | Index wallet yang dipakai. Kosongkan = semua wallet |
| `concurrent` | number | ❌ | Jumlah wallet yang mint bersamaan (default: 3) |
| `mint_function` | string | ❌ | Override mint function. Kosongkan = auto-detect |

**Returns:** `{ success, data: ScheduledMintJob, message }`
- `data.id`: job ID (untuk cancel)
- `data.scheduledTimeISO`: waktu terjadwal
- `data.status`: "pending" | "executing" | "completed" | "failed" | "cancelled"

**Flow penggunaan:**
1. User kasih link minting → `parse_mint_link`
2. `get_mint_schedule` → baca kapan public mint mulai
3. `schedule_mint` → jadwalkan auto-mint di waktu tersebut
4. `list_scheduled_mints` → monitoring
5. Saat waktunya tiba → auto-execute

---

### 11. `list_scheduled_mints`
Lihat semua minting yang sudah dijadwalkan. Berguna untuk monitoring.

**Parameters:** (tidak ada)

**Returns:** `{ success, data: ScheduledMintJob[], message }`
- Setiap job punya status: pending/executing/completed/failed/cancelled
- Completed jobs menampilkan hasil minting (berhasil/gagal per wallet)
- Failed jobs menampilkan error message

---

### 12. `cancel_scheduled_mint`
Batalkan minting yang sudah dijadwalkan.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `job_id` | string | ✅ | Job ID yang mau dibatalkan (dari `list_scheduled_mints`) |

**Returns:** `{ success, data: { jobId, cancelled }, message }`
- Hanya bisa cancel job yang statusnya "pending"

---

### 13. `scrape_contract_from_website` 🆕 v2.1
Extract contract address dari website NFT minting. Tool ini melakukan 2 strategi:

**Strategi 1 — Server-side fetch (cepat):**
- Fetch HTML dari URL
- Regex scan untuk semua Ethereum address (0x...)
- Analisis context sekitar address untuk menentukan kemungkinan NFT
- Deteksi chain dari HTML content
- Filter out known non-NFT addresses (WETH, USDC, Seaport, dll)

**Strategi 2 — Browser script (untuk SPA):**
- Jika website SPA (React/Next.js/Vue) dan address tidak ditemukan via fetch
- Tool generate browser console script yang bisa dijalankan via `browser_console()`
- Script scan rendered HTML, window variables, `__NEXT_DATA__`, data attributes, network requests

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | ✅ | URL website minting (contoh: "https://onchainpepe.fun") |

**Returns:** `{ success, data: ScrapeResult, message }`
- `data.contractAddresses[]`: array of address yang ditemukan
  - `address`: contract address
  - `context`: teks sekitar address (untuk verifikasi)
  - `source`: sumber (html, nft_context, meta_tag, script_config)
  - `isLikelyNFT`: kemungkinan besar NFT contract
- `data.chain`: chain yang terdeteksi (ethereum, polygon, base, dll)
- `data.method`: `"server_fetch"` | `"browser_needed"`
- `data.browserScript`: script untuk `browser_console()` jika SPA
- `data.confidence`: `"high"` | `"medium"` | `"low"`
- `data.notes[]`: catatan dan saran

**Contoh penggunaan:**
```typescript
// Step 1: Scrape contract dari website
const scrape = await TOOLS.scrape_contract_from_website({ url: 'https://onchainpepe.fun' });

// Step 2: Jika address ditemukan, cek detail
if (scrape.success) {
  const topAddr = scrape.data.contractAddresses.find(a => a.isLikelyNFT);
  if (topAddr) {
    const info = await TOOLS.detect_contract({ contract_address: topAddr.address });
    // Jika standard mint → mint_nft
    // Jika butuh signature → browser_mint
  }
}

// Step 3: Jika SPA dan perlu browser
if (scrape.data.browserScript) {
  // Agent menjalankan via browser_console()
  // 1. browser_navigate(url)
  // 2. browser_wait(duration=5)
  // 3. browser_console(expression=scrape.data.browserScript)
}
```

---

### 14. `browser_mint` 🆕 v2.1
Generate browser scripts untuk minting via website yang membutuhkan Connect Wallet atau server signature. Ini adalah **FALLBACK** — gunakan hanya jika `mint_nft` (direct contract) gagal.

**Mengapa perlu browser_mint?**
Beberapa NFT project menggunakan mint function yang membutuhkan:
- Server signature (e.g., `mint(address,uint256,bytes)`)
- Connect Wallet flow sebelum mint
- Frontend validation sebelum transaksi dikirim
- Burn-to-mint atau flow kompleks lainnya

Untuk kasus ini, kita inject custom `window.ethereum` ke browser yang:
- Mimics MetaMask interface (`request()`, `enable()`, `on()`, dll)
- Signs transactions menggunakan private key via ethers.js (loaded from CDN)
- Auto-handles `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`
- Supports multi-wallet rotation (sequential)

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | ✅ | URL website minting yang mau di-mint via browser |
| `wallet_indices` | number[] | ❌ | Index wallet yang dipakai. Kosongkan = semua wallet |

**Returns:** `{ success, data: BrowserMintResult, message }`
- `data.walletScripts[]`: per-wallet injection script
  - `walletIndex`: index wallet
  - `address`: wallet address
  - `injectScript`: JavaScript code untuk `browser_console()`
- `data.multiWalletScript`: script auto-rotate semua wallet (sequential)
- `data.autoClickScript`: script auto-detect Connect/Mint buttons
- `data.stepByStepGuide[]`: panduan langkah demi langkah
- `data.warnings[]`: peringatan keamanan

**⚠️ KEAMANAN:**
- Private keys akan berada di browser memory selama sesi berlangsung
- Gunakan browser instance yang terisolasi (Browserbase)
- Hancurkan browser instance setelah selesai minting
- Browser minting SEQUENTIAL (lebih lambat dari direct contract yang PARALLEL)

**Decision Helper:**
| Mint Function Signature | Rekomendasi |
|------------------------|-------------|
| `mint(uint256)` | ✅ Pakai `mint_nft` (cepat, parallel) |
| `claim(uint256)` | ✅ Pakai `mint_nft` |
| `mintPublic(uint256)` | ✅ Pakai `mint_nft` |
| `mint(uint256,bytes)` | ⚠️ Butuh signature → Coba `mint_nft` dulu, kalau gagal pakai `browser_mint` |
| `mintSigned(address,uint256,bytes)` | ❌ Wajib `browser_mint` |
| `mintAllowed(address,uint256,bytes32[],bytes)` | ❌ WL mint, tidak bisa di-automasi |

**Contoh penggunaan:**
```typescript
// Generate browser minting scripts
const scripts = await TOOLS.browser_mint({
  url: 'https://onchainpepe.fun',
  wallet_indices: [0, 1],  // optional
});

// Agent kemudian menjalankan langkah-langkah:
// 1. browser_navigate(url="https://onchainpepe.fun")
// 2. browser_wait(duration=5)
// 3. browser_console(expression=scripts.data.walletScripts[0].injectScript)
// 4. browser_wait(duration=3)
// 5. Auto-click Connect Wallet via autoClickScript
// 6. Auto-click Mint via autoClickScript
// 7. browser_wait(duration=10) // tunggu TX confirm
// 8. Ulangi untuk wallet berikutnya
```

---

### 15. `get_skill_health` 🆕 v3.0
Cek kondisi skill: konektivitas RPC, balance semua wallet, status scheduler, dan gas mode.
```bash
node runner.mjs get_skill_health '{}'
```
Returns: RPC status (connected, chainId, latency), wallet balances, pending jobs, gas mode, warnings.

### 16. `cancel_pending_tx` 🆕 v3.0
Cancel transaksi yang stuck di mempool dengan replace-by-fee (RBF).
```bash
node runner.mjs cancel_pending_tx '{"tx_hash":"0x...","wallet_index":0,"gas_bump":20}'
```
Sends 0-value TX to self with same nonce but higher gas to replace the stuck TX.

---

## Gas Modes (v3.0) 🆕

| Mode | Multiplier | Use Case |
|------|-----------|----------|
| `eco` | 0.8x | Lebih murah, lebih lambat |
| `normal` | 1.0x | Default |
| `aggressive` | 1.5x | Hot mints, kompetitif |
| `custom` | CUSTOM_GAS_MULTIPLIER | User-defined |

Set di `.env`: `GAS_MODE=normal`

---

## Flow Interaktif

### Flow: Mint Sekarang (Immediate) — Direct Contract
```
User kirim link minting
    ↓
Agent → parse_mint_link (detect jenis mint)
    ↓
Agent tampilkan info ke user
    ↓
Agent → detect_contract (cek detail: harga, supply, dll)
    ↓
Agent diskusi: "Mau mint berapa? Pakai berapa wallet? Harga mintnya oke?"
    ↓
User konfirmasi
    ↓
Agent → check_wallets (pastikan balance cukup)
    ↓
Agent → mint_nft (execute minting)
    ↓
Agent tampilkan hasil minting
    ↓
Agent tanya: "Mau di-list di OpenSea? Harga berapa per NFT?"
    ↓
User kasih harga
    ↓
Agent → approve_seaport
    ↓
Agent → list_nft / batch_list_nfts
    ↓
Done!
```

### Flow: Scheduled Mint (Auto-Mint di Waktu Tertentu)
```
User kirim link minting + info jadwal
    ↓
Agent → parse_mint_link (detect jenis mint)
    ↓
Agent → get_mint_schedule (baca jadwal on-chain)
    ↓
Agent tampilkan jadwal ke user
    ↓
Agent tanya: "Mau saya auto-mint saat public mint mulai?"
    ↓
User: "Ya, mint 1 per wallet pake semua wallet"
    ↓
Agent → schedule_mint (jadwalkan di waktu public mint)
    ↓
... tunggu sampai waktunya ...
    ↓
Auto-execute minting saat waktunya tiba
    ↓
Agent tanya: "Mau di-list? Harga berapa?"
```

### Flow: Browser Minting (Website yang Butuh Connect Wallet) 🆕 v2.1
```
User kirim website URL minting (bukan contract address)
    ↓
Agent → scrape_contract_from_website (cari contract address)
    ↓
┌─────────────────────────────────────────────────┐
│ Address ditemukan?                               │
├──────────┬──────────────────────────────────────┤
│ YA       │ TIDAK (SPA / butuh browser)           │
│    ↓     │    ↓                                   │
│ detect_  │ Gunakan browserConsole script          │
│ contract │ dari scrape result                     │
│    ↓     │    ↓                                   │
│ Standard │ Cari address dari rendered page        │
│ mint?    │    ↓                                   │
│    ↓     │ detect_contract                        │
│ ┌───┐    │    ↓                                   │
│ │YA │    │ Standard mint?                         │
│ └─┬─┘    │    ↓                                   │
│   ↓      │ ┌───┐  ┌────┐                         │
│ mint_nft │ │YA │  │TIDAK│                         │
│          │ └─┬─┘  └──┬─┘                         │
│          │   ↓       ↓                             │
│          │ mint_nft  browser_mint                  │
└──────────┴──────────────────────────────────────┘
    ↓
Browser Mint Flow:
    ↓
Agent → browser_mint (generate scripts)
    ↓
Agent → browser_navigate(url)
    ↓
Agent → browser_console(expression=walletInjectScript)
    ↓
Agent → browser_wait (3 detik)
    ↓
Agent → browser_console(expression=autoClickScript)
    ↓  (klik Connect Wallet)
Agent → browser_wait (3 detik)
    ↓
Agent → browser_console(expression=autoClickScript)
    ↓  (klik Mint)
Agent → browser_wait (10 detik, tunggu TX)
    ↓
Agent → Repeat untuk wallet berikutnya (sequential)
    ↓
Agent → Destroy browser instance
    ↓
Done!
```

## Aturan Penting untuk Agent

1. **JANGAN auto-list** — Selalu diskusi harga listing dengan user terlebih dahulu
2. **Selalu cek wallet balance** sebelum minting untuk memastikan cukup ETH
3. **Konfirmasi mint price** dengan user sebelum execute, terutama jika harga > 0
4. **Jika mint function adalah presale/allowlist**, beritahu user bahwa auto-minting butuh proof
5. **Jika listing via API gagal**, berikan URL manual OpenSea ke user
6. **Scheduled mint hanya untuk PUBLIC mint** — WL/allowlist mint butuh Merkle proof yang hanya bisa didapat dari OpenSea UI
7. **Selalu baca jadwal on-chain** via `get_mint_schedule` sebelum scheduling — jangan tebak waktu
8. **Agent harus tetap berjalan** sampai scheduled mint tiba — jika agent mati, job hilang
9. **Prioritaskan direct contract minting** (`mint_nft`) — lebih cepat dan parallel. Gunakan `browser_mint` hanya sebagai fallback
10. **Hancurkan browser instance** setelah browser minting selesai — private keys ada di browser memory
11. **Scrape dulu, mint nanti** — selalu cari contract address via `scrape_contract_from_website` sebelum memutuskan approach

## Catatan tentang WL/Allowlist Mint

Untuk whitelist (WL) atau allowlist mint di OpenSea:
- OpenSea mengelola Merkle tree server-side
- Saat user klik "Mint" di OpenSea, backend mereka generate proof per-wallet
- Agent kita **tidak bisa** mengakses proof ini tanpa integrasi dengan OpenSea API
- `mintAllowed()` dengan empty proof `[]` akan gagal
- **Solusi:** Untuk WL mint, user harus mint manual di OpenSea. Scheduled auto-mint hanya untuk public mint.

## Catatan tentang Browser Minting v2.1

Browser minting adalah **fallback** untuk website yang tidak bisa di-mint langsung via smart contract:

| Approach | Speed | Multi-Wallet | Kapan Dipakai |
|----------|-------|--------------|---------------|
| `mint_nft` (direct contract) | ⚡ PARALLEL | ✅ Simultaneous | Standard public mint |
| `browser_mint` (browser-based) | 🐌 SEQUENTIAL | ⚠️ One at a time | Butuh server signature / Connect Wallet |

**Cara kerja browser_mint:**
1. Tool generate JavaScript injection scripts
2. Script meng-override `window.ethereum` dengan custom provider
3. Custom provider menggunakan ethers.js + private key untuk sign TX
4. Agent menjalankan script via `browser_console()`
5. Website "melihat" wallet terhubung seperti MetaMask
6. Agent auto-klik Connect Wallet dan Mint button
7. Untuk multi-wallet: rotate satu per satu (inject → connect → mint → next)

**Keamanan browser_mint:**
- Private keys berada di browser memory selama sesi
- WAJIB gunakan Browserbase (isolated cloud browser)
- WAJIB destroy browser setelah selesai
- Jangan pernah log private keys di console

## Supported Chains

| Chain | Chain ID | Direct Mint | Seadrop | Schedule | Listing | Browser Mint |
|-------|----------|-------------|---------|----------|---------|-------------|
| Ethereum | 1 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Arbitrum | 42161 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zora | 7777777 | ✅ | ❌ | ❌ | ❌ | ✅ |
| Blast | 81457 | ✅ | ❌ | ❌ | ❌ | ✅ |

## Import & Usage

```typescript
import { TOOLS, SKILL_DEFINITION } from 'auto-mint-agent';

// Parse link
const parsed = await TOOLS.parse_mint_link({ url: 'https://opensea.io/collection/my-nft' });

// Detect contract
const info = await TOOLS.detect_contract({ contract_address: '0x...' });

// Check wallets
const balances = await TOOLS.check_wallets();

// Get mint schedule
const schedule = await TOOLS.get_mint_schedule({ contract_address: '0x...' });

// Schedule mint
const job = await TOOLS.schedule_mint({
  contract_address: '0x...',
  mint_price_eth: '0.05',
  scheduled_time: '2025-06-01T18:00:00Z',
  quantity_per_wallet: 1,
});

// List scheduled mints
const jobs = await TOOLS.list_scheduled_mints();

// Cancel scheduled mint
await TOOLS.cancel_scheduled_mint({ job_id: 'mint_1234567890_1' });

// Scrape contract from website (NEW v2.1)
const scrape = await TOOLS.scrape_contract_from_website({ url: 'https://onchainpepe.fun' });
// → Returns contract addresses found in website
// → If SPA, returns browserScript for browser_console()

// Browser mint (NEW v2.1) — FALLBACK for server-signature mints
const scripts = await TOOLS.browser_mint({ url: 'https://onchainpepe.fun' });
// → Returns wallet injection scripts, auto-click script, step-by-step guide
// → Agent executes via browser_navigate + browser_console

// Mint now (direct contract)
const results = await TOOLS.mint_nft({
  contract_address: '0x...',
  mint_price_eth: '0.05',
  quantity_per_wallet: 1,
});

// Approve
await TOOLS.approve_seaport({ contract_address: '0x...' });

// List (AFTER discussing price!)
const listResult = await TOOLS.list_nft({
  contract_address: '0x...',
  token_id: '123',
  price_eth: '0.1',
  wallet_index: 0,
});
```

## Safety Features

- `DRY_RUN=true`: Simulasi tanpa real transactions
- `MAX_MINT_PRICE_ETH`: Batas harga mint maksimum (mencegah minting yang terlalu mahal)
- `MAX_GAS_PRICE_GWEI`: Batas gas price (mencegah gas war)
- Validasi contract address sebelum minting
- Deteksi fungsi presale/allowlist dan berikan warning
- Scheduled mint hanya untuk public mint (WL mint diblokir)
- Browser minting: isolated browser instance, auto-destroy after use
