# SKILL.md — Auto Mint Agent

> Hermes Skill untuk auto-minting NFT dengan multi-wallet, scheduled minting, dan listing interaktif di OpenSea.

## Deskripsi

Skill ini menyediakan 12 tools yang bisa dipanggil oleh Hermes agent untuk:
- Parse link minting dan detect jenis (direct contract vs OpenSea/Seadrop)
- Detect informasi detail smart contract NFT
- Baca jadwal minting on-chain (Seadrop: public/allowlist start & end time)
- Jadwalkan auto-minting di waktu tertentu (scheduled mint)
- Execute minting dengan banyak wallet secara simultan
- Approve & list NFT di OpenSea (dengan diskusi harga terlebih dahulu)

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

### 9. `get_mint_schedule` 🆕
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

### 10. `schedule_mint` 🆕
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

### 11. `list_scheduled_mints` 🆕
Lihat semua minting yang sudah dijadwalkan. Berguna untuk monitoring.

**Parameters:** (tidak ada)

**Returns:** `{ success, data: ScheduledMintJob[], message }`
- Setiap job punya status: pending/executing/completed/failed/cancelled
- Completed jobs menampilkan hasil minting (berhasil/gagal per wallet)
- Failed jobs menampilkan error message

---

### 12. `cancel_scheduled_mint` 🆕
Batalkan minting yang sudah dijadwalkan.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `job_id` | string | ✅ | Job ID yang mau dibatalkan (dari `list_scheduled_mints`) |

**Returns:** `{ success, data: { jobId, cancelled }, message }`
- Hanya bisa cancel job yang statusnya "pending"

---

## Flow Interaktif

### Flow: Mint Sekarang (Immediate)
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

### Flow: Scheduled Mint (Auto-Mint di Waktu Tertentu) 🆕
```
User kirim link minting + info jadwal
    ↓
Agent → parse_mint_link (detect jenis mint)
    ↓
Agent → get_mint_schedule (baca jadwal on-chain)
    ↓
Agent tampilkan jadwal ke user:
  "Public mint mulai: 1 Jun 2025 18:00 UTC"
  "Harga: 0.05 ETH | Max 2 per wallet"
    ↓
Agent tanya: "Mau saya auto-mint saat public mint mulai?"
    ↓
User: "Ya, mint 1 per wallet pake semua wallet"
    ↓
Agent → schedule_mint (jadwalkan di waktu public mint)
    ↓
Agent: "Sudah dijadwalkan! Job ID: mint_xxx"
  "Akan auto-mint pada 1 Jun 2025 18:00 UTC"
    ↓
... tunggu sampai waktunya ...
    ↓
Auto-execute minting saat waktunya tiba
    ↓
Agent → tampilkan hasil ke user
    ↓
Agent tanya: "Mau di-list? Harga berapa?"
    ↓
... lanjut flow listing ...
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

## Catatan tentang WL/Allowlist Mint

Untuk whitelist (WL) atau allowlist mint di OpenSea:
- OpenSea mengelola Merkle tree server-side
- Saat user klik "Mint" di OpenSea, backend mereka generate proof per-wallet
- Agent kita **tidak bisa** mengakses proof ini tanpa integrasi dengan OpenSea API
- `mintAllowed()` dengan empty proof `[]` akan gagal
- **Solusi:** Untuk WL mint, user harus mint manual di OpenSea. Scheduled auto-mint hanya untuk public mint.

## Supported Chains

| Chain | Chain ID | Direct Mint | Seadrop | Schedule | Listing |
|-------|----------|-------------|---------|----------|---------|
| Ethereum | 1 | ✅ | ✅ | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ | ✅ | ✅ |
| Arbitrum | 42161 | ✅ | ✅ | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ | ✅ | ✅ |
| Zora | 7777777 | ✅ | ❌ | ❌ | ❌ |
| Blast | 81457 | ✅ | ❌ | ❌ | ❌ |

## Import & Usage

```typescript
import { TOOLS, SKILL_DEFINITION } from 'auto-mint-agent';

// Parse link
const parsed = await TOOLS.parse_mint_link({ url: 'https://opensea.io/collection/my-nft' });

// Detect contract
const info = await TOOLS.detect_contract({ contract_address: '0x...' });

// Check wallets
const balances = await TOOLS.check_wallets();

// Get mint schedule (NEW)
const schedule = await TOOLS.get_mint_schedule({ contract_address: '0x...' });

// Schedule mint (NEW)
const job = await TOOLS.schedule_mint({
  contract_address: '0x...',
  mint_price_eth: '0.05',
  scheduled_time: '2025-06-01T18:00:00Z',
  quantity_per_wallet: 1,
});

// List scheduled mints (NEW)
const jobs = await TOOLS.list_scheduled_mints();

// Cancel scheduled mint (NEW)
await TOOLS.cancel_scheduled_mint({ job_id: 'mint_1234567890_1' });

// Mint now
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
