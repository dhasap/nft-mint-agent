# OpenSea Collection Extraction Patterns

## Get Contract Address from Collection Slug

```bash
curl -sL "https://api.opensea.io/api/v2/collections/<SLUG>" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('contracts',[]):
    print(f\"{c['address']} ({c['chain']})\")"
```

Example:
```bash
curl -sL "https://api.opensea.io/api/v2/collections/the11beast" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('contracts',[]):
    print(f\"{c['address']} ({c['chain']})\")"
# Output: 0xe13fe8c16f0bd00b60a784127b93351688a3d77c (ethereum)
```

## Get Collection Info

```bash
curl -sL "https://api.opensea.io/api/v2/collections/<SLUG>" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"Name: {d['name']}\")
print(f\"Supply: {d.get('total_supply')}\")
print(f\"Chain: {d.get('contracts',[{}])[0].get('chain')}\")
print(f\"Contract: {d.get('contracts',[{}])[0].get('address')}\")"
```

## Check Wallet Balance on Contract

```bash
# balanceOf(address) = 0x70a08231 + padded address
CONTRACT="0xe13fe8c16f0bd00b60a784127b93351688a3d77c"
WALLET="0ea79b1f6ea30a2dccb7c066da6204fbf4131bd2c"  # without 0x prefix
curl -sL "https://ethereum-rpc.publicnode.com" -X POST -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$CONTRACT\",\"data\":\"0x70a08231000000000000000000000000$WALLET\"},\"latest\"],\"id\":1}"
```

## Common Pitfalls

1. **DON'T scrape OpenSea HTML** — returns dozens of currency addresses (WETH, WAPE, etc.), not the NFT contract
2. **API sering null untuk collection baru** — `/api/v2/collections/<SLUG>` bisa return semua null. **SSR extraction lebih reliable** (lihat di bawah)
3. **SeaDrop V1 = DUA contract addresses** — NFT token contract (punya name/symbol/supply) + SeaDrop proxy contract (punya mint function). Jalankan `detect_contract` pada KEDUA, gunakan yang `isMintable: true`
4. **Proxy contracts** — many OpenSea contracts are EIP-1967 proxies. `eth_getCode` returns ~50 bytes. Check implementation from bytecode.
5. **Eligibility is backend-only** — OpenSea GTD/WL/FCFS stages (`SIGNED_PRESALE`) are managed server-side, not on-chain. Can't check without wallet connect. Public stages (`PUBLIC_SALE`) are open to everyone.
6. **Timezone** — OpenSea displays times in **GMT+8**. User is in **WIB (GMT+7)** — always convert -1 jam saat menampilkan ke user.
7. **Scheduled mints are in-memory** — `schedule_mint` tool jobs hilang saat process exit. Gunakan **Hermes cron jobs** untuk persistent scheduling.

## SSR Data Extraction (Primary Method — lebih reliable dari API)

OpenSea Next.js pages embed GraphQL results via `window[Symbol.for("urql_transport")].push(...)` in `<script>` tags. **Lebih reliable dari API** untuk collection baru.

### Extract contract addresses + collection/drop data:
```javascript
const allS = [...document.querySelectorAll('script')];
let addrs = [], stageData = null, collectionData = null;
for (const s of allS) {
  const txt = s.textContent || '';
  // Contract addresses
  if (txt.includes('collectionBySlug') || txt.includes('dropBySlug')) {
    const matches = txt.match(/"contractAddress":"(0x[a-fA-F0-9]{40})"/g);
    if (matches) addrs.push(...matches.map(m => m.match(/0x[a-fA-F0-9]{40}/)[0]));
  }
  // Stage data (bracket matching for nested JSON)
  if (txt.includes('dropBySlug') && txt.includes('stageType')) {
    const idx = txt.indexOf('"stages":[');
    if (idx > -1) {
      let depth = 0;
      for (let i = idx + 9; i < txt.length; i++) {
        if (txt[i] === '[') depth++;
        if (txt[i] === ']') { depth--; if (depth === 0) { stageData = JSON.parse(txt.substring(idx + 9, i+1)); break; } }
      }
    }
  }
  // Collection/drop info
  if (txt.includes('collectionBySlug') && txt.includes('maxSupply')) {
    const idx2 = txt.indexOf('"drop":{');
    if (idx2 > -1) {
      let depth2 = 0;
      for (let i = idx2 + 6; i < txt.length; i++) {
        if (txt[i] === '{') depth2++;
        if (txt[i] === '}') { depth2--; if (depth2 === 0) { collectionData = JSON.parse(txt.substring(idx2 + 6, i+1)); break; } }
      }
    }
  }
}
// Filter: remove zero address + known tokens
const contracts = [...new Set(addrs)].filter(a =>
  a !== '0x0000000000000000000000000000000000000000' &&
  a !== '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
);
// stageData = [{startTime, endTime, stageIndex, price: {token: {unit, symbol}}, ...}, ...]
// collectionData = {type, maxSupply, totalSupply, stages, activeDropStage}
```

**Data tersedia tanpa wallet:**
- `stageType` (SIGNED_PRESALE / PUBLIC_SALE)
- `label` (GTD / WL / FCFS / Public stage)
- `startTime`, `endTime` (UTC ISO format)
- `maxTotalMintableByWallet`
- `price` (ETH + USD)
- `maxSupply`, `totalSupply`

**Data TIDAK tersedia tanpa wallet (requires GraphQL auth):**
- `isEligible`, `eligibleMaxTotalMintableByWallet`, `eligiblePrice`, `minterQuantityMinted`

