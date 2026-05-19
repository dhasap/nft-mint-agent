# 🤖 Auto Mint Agent - Hermes Skill

Skill untuk Hermes agent yang menyediakan tools auto-minting NFT dengan multi-wallet support dan listing interaktif di OpenSea.

## ✨ Kenapa Skill, Bukan Bot?

Skill ini dirancang untuk dipakai oleh **Hermes agent** melalui gateway. Hermes yang handle Telegram, skill cuma provide tools yang bisa dipanggil. Artinya:

- Hermes agent yang ngobrol sama user via Telegram
- User kirim link → agent panggil `parse_mint_link`
- Agent diskusi sama user (konfirmasi mint, bahas harga listing)
- Baru agent eksekusi minting & listing via tools

## 🔧 Tools yang Tersedia

| Tool | Deskripsi |
|------|-----------|
| `parse_mint_link` | Parse link minting, detect jenis (direct contract vs OpenSea) |
| `detect_contract` | Cek detail contract (nama, harga, supply, mint function) |
| `check_wallets` | Cek balance ETH semua wallet |
| `mint_nft` | Execute minting dengan multi-wallet |
| `approve_seaport` | Approve Seaport (OpenSea) untuk listing |
| `list_nft` | List 1 NFT di OpenSea dengan harga yang disepakati |
| `batch_list_nfts` | List banyak NFT sekaligus |
| `get_mint_status` | Cek status TX minting |

## 🎯 Flow Interaktif (PENTING!)

Skill ini dirancang dengan flow **diskusi dulu, eksekusi belakangan**:

```
User kirim link
    ↓
Agent → parse_mint_link
    ↓
Agent tampilin info ke user
    ↓
Agent → detect_contract (cek detail)
    ↓
Agent diskusi: "Mau mint berapa? Pakai berapa wallet? Harga mintnya oke?"
    ↓
User konfirmasi
    ↓
Agent → mint_nft (execute)
    ↓
Agent tampilin hasil minting
    ↓
Agent tanya: "Mau di-list di OpenSea? Harga berapa per NFT?"
    ↓
User kasih harga
    ↓
Agent → approve_seaport
    ↓
Agent → list_nft / batch_list_nfts
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
  wallet_indices: [0, 1, 2],
});

// Approve
const approveResult = await TOOLS.approve_seaport({ contract_address: '0x...' });

// List (AFTER discussing price with user!)
const listResult = await TOOLS.list_nft({
  contract_address: '0x...',
  token_id: '123',
  price_eth: '0.1',
  wallet_index: 0,
});
```

## ⚙️ Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RPC_URL` | Ethereum RPC endpoint | Required |
| `CHAIN` | Blockchain (ethereum/polygon/arbitrum/base) | ethereum |
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
│   ├── tools/index.ts    # 🔑 Tool definitions & implementations
│   ├── mint/
│   │   ├── parser.ts     # Link parser & mint type detector
│   │   ├── direct.ts     # Direct contract minter
│   │   ├── opensea.ts    # OpenSea/Seadrop minter
│   │   └── index.ts
│   ├── wallet/
│   │   ├── index.ts      # Multi-wallet manager
│   │   └── generate.ts   # Wallet generator
│   ├── listing/index.ts  # OpenSea listing logic
│   ├── config/index.ts   # Config loader & constants
│   ├── utils/index.ts    # Helper functions
│   └── index.ts          # Entry point
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## ⚠️ Safety Notes

- Set `DRY_RUN=true` untuk testing tanpa real transactions
- `MAX_MINT_PRICE_ETH` mencegah minting yang terlalu mahal
- `MAX_GAS_PRICE_GWEI` mencegah gas war
- Selalu verify contract address sebelum minting
- Private keys jangan pernah di-share!

## 📜 Disclaimer

This tool is for educational purposes only. Use at your own risk. NFT minting involves financial risk. Always do your own research before minting any NFT.
