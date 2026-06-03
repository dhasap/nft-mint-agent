# Auto Mint Agent — Claude Code Instructions

## Overview
This skill provides 16 tools for automated NFT minting with multi-wallet support.
All tools are accessible via `node runner.mjs <tool_name> '<json_params>'` from the project directory.

## Setup
```bash
cd /root/nft-minting-skill
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
