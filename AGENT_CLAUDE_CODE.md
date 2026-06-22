# Auto Mint Agent — Claude Code Instructions

> 🧭 New here? Start with **[SKILL.md](SKILL.md)** (decision tree) and **[docs/QUICKSTART.md](docs/QUICKSTART.md)** (copy-paste recipes). MCP setup: **[docs/MCP.md](docs/MCP.md)**.

## Overview
This skill provides 16 tools for automated NFT minting with multi-wallet support.
All tools are accessible via `node runner.mjs <tool_name> '<json_params>'` from the project directory.


## ⚠️ MINT KOMPETITIF / HOT DROP — WAJIB FAST-MINT

Jika user minta **auto mint**, **max mint**, **FCFS**, mint yang supply cepat habis, atau mint mulai <30 menit lagi, **JANGAN** mengandalkan `schedule_mint`, agent cron, browser click, atau `estimateGas` tepat saat live. Gunakan fast path:

```bash
cd /root/nft-mint-agent
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --gas-mode aggressive --priority-gwei 8 --max-fee-gwei 100 --early-ms 750
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

## Setup
```bash
cd /root/nft-mint-agent
npm install
cp .env.example .env  # Edit with your values
npm run build
```

## Browser Automation
Claude Code can use Playwright MCP for browser-based minting:

1. **Install Playwright MCP**: Add to your MCP config
2. **Navigate**: Use Playwright to navigate to mint websites
3. **Extract contracts**: Run `scrape_contract_from_website` tool
4. **SSR extraction**: For SPA sites, use Playwright to evaluate JavaScript in the page context

### SSR Extraction Script (for OpenSea collections)
```javascript
// Evaluate in browser via Playwright MCP
const allS = [...document.querySelectorAll('script')];
let addrs = [];
for (const s of allS) {
  const txt = s.textContent || '';
  if (txt.includes('collectionBySlug') || txt.includes('dropBySlug')) {
    const matches = txt.match(/"contractAddress":"(0x[a-fA-F0-9]{40})"/g);
    if (matches) addrs.push(...matches.map(m => m.match(/0x[a-fA-F0-9]{40}/)[0]));
  }
}
JSON.stringify([...new Set(addrs)]);
```

## Flow
1. User kirim link → `parse_mint_link`
2. `detect_contract` untuk cek info
3. `check_wallets` untuk verify balance
4. `mint_nft` untuk execute (setelah diskusi)
5. `approve_seaport` + `list_nft` untuk listing (setelah diskusi harga)

## Important Notes
- Always discuss with user before minting or listing
- Use `get_skill_health` to check system status
- Use `cancel_pending_tx` for stuck transactions
- Gas modes: eco/normal/aggressive/custom (set in .env)
- Scheduled mints are persisted to disk (survive restarts)

## Tool Quick Reference
```bash
# Health check
node runner.mjs get_skill_health '{}'

# Parse link
node runner.mjs parse_mint_link '{"url":"https://opensea.io/collection/xxx"}'

# Detect contract
node runner.mjs detect_contract '{"contract_address":"0x..."}'

# Check wallets
node runner.mjs check_wallets '{}'

# Mint (after discussion!)
node runner.mjs mint_nft '{"contract_address":"0x...","mint_price_eth":"0.05","quantity_per_wallet":1}'

# Cancel stuck TX
node runner.mjs cancel_pending_tx '{"tx_hash":"0x...","wallet_index":0}'
```

See AGENT_GENERIC.md for full tool documentation.
