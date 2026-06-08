# SeaDrop mint() Overload Fix

## Problem
SeaDrop V1 contracts have multiple `mint()` function selectors in bytecode:
- `mint(uint256)` — 0xa0712d68
- `mint(address,uint256)` — variant
- `mint(uint256,address)` — variant

`COMMON_MINT_ABI` in `dist/config/index.js` includes all three, causing ethers.js to throw:
```
ambiguous function description (i.e. matches "mint(uint256)", "mint(address,uint256)", "mint(uint256,address)")
```

## Fix: Use full signature as accessor

### dist/mint/direct.js (line ~116)
```javascript
// Before:
const funcName = funcSignature.split('(')[0]; // → "mint"

// After:
const funcName = funcSignature.includes('(') ? funcSignature : funcSignature.split('(')[0];
// → "mint(uint256)"
```

This makes `contract["mint(uint256)"](...)` resolve to the exact overload.

### Usage
Always pass `mintFunction` for SeaDrop contracts:
```bash
node runner.mjs mint_nft '{
  "contract_address": "0xbb2480d65788b15b2f24db8df6a57ea2aff5f106",
  "mintFunction": "mint(uint256)",
  "mint_price_eth": "0",
  "quantity_per_wallet": 1,
  "wallet_indices": [0],
  "concurrent": 1
}'
```

## ⚠️ Build Warning
This fix is in compiled JS (`dist/`). Running `npm run build` or `tsc` will overwrite it.
Apply the same fix to the TypeScript source (`src/mint/direct.ts`) to persist across builds.

## SeaDrop Contract Pattern
SeaDrop V1 ERC721 = `SEADROP_V1_ERC721` type on OpenSea.
- Mint function: `mint(uint256 quantity)` on SeaDrop contract (not the NFT contract)
- NFT contract = separate address (e.g., `0xaccaa4...`) — no mint function
- SeaDrop contract = `0xbb2480...` — has `mint(uint256)`
- To find SeaDrop address: check SSR `__next_f` scripts for `contractAddress` near `dropBySlug`
- Eligibility (GTD/WL/FCFS = SIGNED_PRESALE) requires merkle proof from OpenSea backend
- PUBLIC stage = no proof needed, direct `mint(uint256)` works

## Timing
- Script execution: ~4 seconds
- Agent boot + run: ~15 seconds  
- Total cron→TX: ~20 seconds

