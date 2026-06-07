# Auto Mint Agent — Generic Instructions (Platform-Agnostic)

## Cara Membaca Dokumen Ini
- File ini adalah instruksi platform-agnostic
- Untuk platform spesifik: lihat AGENT_HERMES.md / AGENT_CLAUDE_CODE.md
- Semua referensi ke "browser" = "gunakan browser tool yang tersedia di platformmu"

## ⚠️ MINT KOMPETITIF / HOT DROP — WAJIB FAST-MINT

Jika user minta **auto mint**, **max mint**, **FCFS**, mint yang supply cepat habis, atau mint mulai <30 menit lagi, **JANGAN** mengandalkan `schedule_mint`, agent cron, browser click, atau `estimateGas` tepat saat live. Gunakan fast path:

```bash
cd /root/nft-minting-skill
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --gas-mode aggressive --priority-gwei 2 --max-fee-gwei 100 --early-ms 750
```

Status/preflight tanpa kirim TX:

```bash
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --status
```

Aturan wajib sebelum broadcast:
1. **On-chain wins over UI/SSR.** Selalu baca `getPublicDrop()` dari SeaDrop tepat sebelum plan/broadcast untuk `mintPrice`, `startTime`, `endTime`, dan `maxTotalMintableByWallet`. Jangan percaya OpenSea UI kalau berbeda.
2. **Resolve SeaDrop minter yang benar.** Mainnet OpenSea SeaDrop baru sering memakai `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`. Jangan pakai address lama `0x00005EA67...` kalau `eth_getCode` kosong / `getPublicDrop` gagal.
3. **Jangan kirim value stale.** Jika live price berubah dari 0 ke berbayar, hitung ulang `value = mintPrice * quantity` dan cek `MAX_MINT_PRICE_ETH`.
4. **Cek saldo upfront.** Wallet harus punya minimal `mintPrice * qty + gasLimit * maxFeePerGas`, bukan cuma estimasi gas akhir. Kalau kurang, skip dan bilang user fund dulu.
5. **No live delay.** Jangan melakukan `estimateGas`, browser clicking, tool rebuild, atau patch saat detik mint live. Fast script harus pre-warm: RPC, nonce, fee recipient, gas, balance, dan sign/broadcast raw tx paralel.
6. **Gas agresif untuk hot mint.** Default `--gas-mode aggressive`; user harus set `--priority-gwei`/`--max-fee-gwei` cukup tinggi dan wallet harus funded.
7. **Output waktu pakai WIB** (`Asia/Jakarta`) untuk schedule/status/result.

Gunakan `mint_nft`/`schedule_mint` hanya untuk mint santai atau tidak kompetitif. Untuk OpenSea drop panas, fast-mint adalah default.

## Flow Decision-Making

### Immediate Mint
```
User kirim link → parse_mint_link → detect_contract → diskusi → check_wallets → mint_nft → diskusi listing → approve_seaport → list_nft
```

### Scheduled Mint
```
User kirim link → parse_mint_link → detect_contract → tampilkan jadwal → diskusi → schedule_mint / platform-specific cron → report result
```

### Browser Mint (Website yang butuh Connect Wallet)
```
User kirim URL → scrape_contract_from_website → detect_contract → browser_mint → inject wallet → auto-click → mint
```

### OpenSea Collection Check
```
User kirim OpenSea URL → browser navigate → SSR extraction → detect_contract SEMUA address → identify mintable → tampilkan jadwal
```

## Tool Reference (16 Tools)

### 1. parse_mint_link
Parse URL/contract, detect mint type.
```bash
node runner.mjs parse_mint_link '{"url":"https://opensea.io/collection/xxx"}'
```

### 2. detect_contract
Get contract details: name, price, supply, mint function.
```bash
node runner.mjs detect_contract '{"contract_address":"0x..."}'
```

### 3. check_wallets
Check ETH balance all wallets.
```bash
node runner.mjs check_wallets '{}'
```

### 4. mint_nft
Execute multi-wallet minting. **WAJIB diskusi dulu!**
```bash
node runner.mjs mint_nft '{"contract_address":"0x...","mint_price_eth":"0","quantity_per_wallet":1,"wallet_indices":[0,1],"concurrent":3}'
```

### 5. approve_seaport
Approve Seaport before listing.
```bash
node runner.mjs approve_seaport '{"contract_address":"0x..."}'
```

### 6. list_nft
List 1 NFT on OpenSea. **WAJIB diskusi harga dulu!**
```bash
node runner.mjs list_nft '{"contract_address":"0x...","token_id":"123","price_eth":"0.1","wallet_index":0}'
```

### 7. batch_list_nfts
List multiple NFTs. **WAJIB diskusi harga dulu!**
```bash
node runner.mjs batch_list_nfts '{"items":[{"contract_address":"0x...","token_id":"1","price_eth":"0.1","wallet_index":0}]}'
```

### 8. get_mint_status
Check TX status (pending/confirmed/reverted/not_found).
```bash
node runner.mjs get_mint_status '{"tx_hash":"0x..."}'
```

### 9. get_mint_schedule
Read on-chain mint schedule (Seadrop: public/allowlist start/end time, price, max per wallet).
```bash
node runner.mjs get_mint_schedule '{"contract_address":"0x..."}'
```

### 10. schedule_mint
Schedule auto-mint at specific time. **PUBLIC mint only!**
```bash
node runner.mjs schedule_mint '{"contract_address":"0x...","mint_price_eth":"0.05","scheduled_time":"2025-06-01T18:00:00Z","quantity_per_wallet":1}'
```

### 11. list_scheduled_mints
View all scheduled mint jobs with countdown.
```bash
node runner.mjs list_scheduled_mints '{}'
```

### 12. cancel_scheduled_mint
Cancel pending scheduled mint.
```bash
node runner.mjs cancel_scheduled_mint '{"job_id":"mint_1234567890_1"}'
```

### 13. scrape_contract_from_website
Extract contract address dari website NFT minting.
```bash
node runner.mjs scrape_contract_from_website '{"url":"https://onchainpepe.fun"}'
```

### 14. browser_mint
Generate browser scripts untuk minting via website yang butuh Connect Wallet.
```bash
node runner.mjs browser_mint '{"url":"https://onchainpepe.fun","wallet_indices":[0,1]}'
```

### 15. get_skill_health 🆕 v3.0
Cek kondisi skill: RPC connectivity, wallet balances, scheduler status, gas mode.
```bash
node runner.mjs get_skill_health '{}'
```

### 16. cancel_pending_tx 🆕 v3.0
Cancel stuck TX dengan replace-by-fee (RBF).
```bash
node runner.mjs cancel_pending_tx '{"tx_hash":"0x...","wallet_index":0,"gas_bump":20}'
```

## Browser Minting — Platform-Agnostic

Jika platform kamu tidak punya browser tool built-in, opsi:
1. Install Playwright MCP server (https://github.com/microsoft/playwright-mcp)
2. Gunakan Browserbase MCP
3. Manual: user mint sendiri, skill hanya prepare wallet injection code

## Decision Helper

| Mint Function | Rekomendasi |
|---------------|-------------|
| `mint(uint256)` | ✅ `mint_nft` (cepat, parallel) |
| `claim(uint256)` | ✅ `mint_nft` |
| `mint(uint256,bytes)` | ⚠️ Coba `mint_nft` dulu, gagal → `browser_mint` |
| `mintSigned(address,uint256,bytes)` | ❌ Wajib `browser_mint` |

## Config (.env)
RPC_URL, CHAIN, WALLET_PRIVATE_KEYS, MAX_GAS_PRICE_GWEI, PRIORITY_FEE_GWEI, GAS_MODE, MAX_MINT_PRICE_ETH, OPENSEA_API_KEY, DRY_RUN

## Gas Modes (v3.0)
- `eco`: 0.8x multiplier (lebih murah, lebih lambat)
- `normal`: 1x multiplier (default)
- `aggressive`: 1.5x multiplier (untuk hot mints)
- `custom`: pakai CUSTOM_GAS_MULTIPLIER dari .env

## Rules
1. JANGAN auto-list — selalu diskusi harga dulu
2. Cek wallet balance sebelum minting
3. Konfirmasi mint price sebelum execute
4. Presale/allowlist butuh Merkle proof — warning user
5. Prioritaskan direct contract (`mint_nft`) — lebih cepat dari `browser_mint`
6. Scrape dulu — selalu cari contract address via `scrape_contract_from_website`
7. JANGAN update tools saat mint live — prioritas CEK STATUS dulu

## Supported Chains
Ethereum (1), Polygon (137), Arbitrum (42161), Optimism (10), Base (8453), Zora (7777777), Blast (81457)
