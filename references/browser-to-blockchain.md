# Browser-to-Blockchain Extraction

Pattern untuk extract data dari NFT mint website dan feed ke direct minting.

## Extract Contract Address via Browser Console

```javascript
// Cari semua text yang match 0x pattern (40 hex chars)
document.body.innerText.match(/0x[a-fA-F0-9]{40}/g)

// Cari di semua link/href
[...document.querySelectorAll('a[href*="0x"]')].map(a => a.href)

// Cari di semua script tag (contract address sering embedded)
[...document.querySelectorAll('script')].map(s => s.textContent.match(/0x[a-fA-F0-9]{40}/g)).flat().filter(Boolean)

// Cari di Etherscan link
[...document.querySelectorAll('a[href*="etherscan.io/address/"]')].map(a => a.href)
```

## Extract ABI / Mint Function Signature

```javascript
// Cari function selector di page source
document.documentElement.innerHTML.match(/0x[a-fA-F0-9]{8}/g)

// Cari common mint function names
document.documentElement.innerHTML.match(/(mint|claim|safeMint|publicMint)\s*\(/gi)
```

## Extract Pricing Info

```javascript
// Cari ETH amount
document.body.innerText.match(/\d+\.?\d*\s*ETH/gi)

// Cari USD price
document.body.innerText.match(/\$\d+\.?\d*/g)
```

## Workflow: Website → Mint

1. `browser_navigate(url)` → buka website
2. `browser_console(expression=...)` → extract contract address
3. `node runner.mjs parse_mint_link` → validate
4. `node runner.mjs detect_contract` → get details
5. `node runner.mjs check_wallets` → verify balance
6. `node runner.mjs mint_nft` → execute

## Website Patterns

| Site | Contract Location |
|------|-------------------|
| opensea.io/collection/X | URL path (use parse_mint_link) |
| etherscan.io/address/0x... | URL path |
| Custom mint sites | JavaScript bundle or data attributes |
| Seadrop contracts | API endpoint + contract param |

## Not Working For

- Sites yang require Cloudflare challenge (pakai cloudflare-web-mining skill)
- Sites yang require wallet signature sebelum show contract (user harus manual inspect)

