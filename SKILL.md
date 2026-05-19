# SKILL.md — Auto Mint Agent

> Hermes Skill untuk auto-minting NFT dengan multi-wallet dan listing interaktif di OpenSea.

## Deskripsi

Skill ini menyediakan 8 tools yang bisa dipanggil oleh Hermes agent untuk:
- Parse link minting dan detect jenis (direct contract vs OpenSea/Seadrop)
- Detect informasi detail smart contract NFT
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

## Flow Interaktif

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

## Aturan Penting untuk Agent

1. **JANGAN auto-list** — Selalu diskusi harga listing dengan user terlebih dahulu
2. **Selalu cek wallet balance** sebelum minting untuk memastikan cukup ETH
3. **Konfirmasi mint price** dengan user sebelum execute, terutama jika harga > 0
4. **Jika mint function adalah presale/allowlist**, beritahu user bahwa auto-minting butuh proof
5. **Jika listing via API gagal**, berikan URL manual OpenSea ke user

## Supported Chains

| Chain | Chain ID | Direct Mint | Seadrop | Listing |
|-------|----------|-------------|---------|---------|
| Ethereum | 1 | ✅ | ✅ | ✅ |
| Polygon | 137 | ✅ | ✅ | ✅ |
| Arbitrum | 42161 | ✅ | ✅ | ✅ |
| Optimism | 10 | ✅ | ✅ | ✅ |
| Base | 8453 | ✅ | ✅ | ✅ |
| Zora | 7777777 | ✅ | ❌ | ❌ |
| Blast | 81457 | ✅ | ❌ | ❌ |

## Import & Usage

```typescript
import { TOOLS, SKILL_DEFINITION } from 'auto-mint-agent';

// Parse link
const parsed = await TOOLS.parse_mint_link({ url: 'https://opensea.io/collection/my-nft' });

// Detect contract
const info = await TOOLS.detect_contract({ contract_address: '0x...' });

// Check wallets
const balances = await TOOLS.check_wallets();

// Mint
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
