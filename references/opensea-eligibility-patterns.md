# OpenSea Eligibility & Mint Status Patterns

## Mint Stage Types

OpenSea Seadrop uses two stage types:

### `SIGNED_PRESALE` (GTD, WL, FCFS)
- Eligibility ditentukan oleh **OpenSea backend**
- Tidak ada data on-chain untuk allowlist
- Butuh wallet connect ke OpenSea + `personal_sign` untuk verifikasi
- GraphQL query `DropEligibilityQuery` returns `isEligible` per stage

### `PUBLIC_SALE` (Public stage)
- Siapa saja bisa mint
- Tidak perlu eligibility check
- `schedule_mint` tool bisa digunakan untuk auto-mint

## SSR Data Extraction (Tanpa Wallet)

Data mint schedule embedded di page SSR (`self.__next_f` scripts). Bisa di-extract tanpa wallet:

```javascript
// browser_console
const scripts = [...document.querySelectorAll('script')];
for (const s of scripts) {
  if (s.textContent.includes('dropBySlug')) {
    const idx = s.textContent.indexOf('dropBySlug');
    return s.textContent.substring(idx, idx + 3000);
  }
}
```

Returns JSON:
```json
{
  "dropBySlug": {
    "__typename": "Erc721SeaDropV1",
    "maxSupply": 1111,
    "totalSupply": 0,
    "stages": [
      {
        "label": "GTD",
        "stageType": "SIGNED_PRESALE",
        "stageIndex": 1,
        "startTime": "2026-05-22T15:00:00.000Z",
        "endTime": "2026-05-22T16:00:00.000Z",
        "maxTotalMintableByWallet": 1,
        "price": { "usd": 0, "token": { "unit": 0, "symbol": "ETH" } },
        "uuid": "04cd8aafb..."
      },
      { "label": "WL", "stageType": "SIGNED_PRESALE", ... },
      { "label": "FCFS", "stageType": "SIGNED_PRESALE", ... },
      { "label": "Public stage", "stageType": "PUBLIC_SALE", ... }
    ]
  }
}
```

**Key fields:**
- `stageType`: `SIGNED_PRESALE` atau `PUBLIC_SALE`
- `startTime` / `endTime`: UTC timestamps (convert ke WIB = -7 jam dari UTC, atau -1 jam dari GMT+8 yang ditampilkan OpenSea)
- `price.usd` / `price.token.unit`: 0 = free mint
- `maxTotalMintableByWallet`: limit per wallet

## GraphQL Eligibility Query

Query yang digunakan OpenSea frontend (found in chunk `0~emmnp55acga.js`):

```graphql
query DropEligibilityQuery($collectionSlug: String!, $address: Address!) {
  dropBySlug(slug: $collectionSlug) {
    __typename
    ... on Erc721SeaDropV1 {
      minterQuantityMinted(minter: $address)
    }
    stages {
      stageType
      stageIndex
      isEligible
      maxTotalMintableByWallet
      eligibleMaxTotalMintableByWallet
      eligiblePrice {
        ... on TokenPrice {
          token { unit symbol contractAddress chain { identifier } }
        }
        ... on UsdPrice { usd }
      }
    }
  }
}
```

Endpoint: `https://opensea.io/graphql/`
- Returns HTML (not JSON) when called without proper session/cookies
- Tidak bisa dipanggil dari curl/terminal
- Hanya works dari browser context dengan OpenSea session

## Wallet Connection Flow (Browserbase)

### Step 1: Inject Minimal Provider
```javascript
// browser_console — inject tanpa ethers.js
const addr = '0xYOUR_ADDRESS';
window.ethereum = {
  isMetaMask: true,
  selectedAddress: addr,
  chainId: '0x1',
  request: async ({ method }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
    if (method === 'eth_chainId') return '0x1';
    return null;
  },
  on: () => {}, removeListener: () => {}, isConnected: () => true,
};
// EIP-6963 announcement
window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
  detail: { info: { uuid: crypto.randomUUID(), name: 'MetaMask', rdns: 'io.metamask' }, provider: window.ethereum }
}));
```

### Step 2: Click MetaMask
OpenSea detects provider → shows "MetaMask Installed" in connect dialog.

### Step 3: Connection Requires Signing
OpenSea calls `personal_sign` to verify wallet ownership.
- **With ethers.js:** Signs message → connection succeeds → "View eligibility" works
- **Without ethers.js:** Sign fails → connection fails → stays on connect dialog

### Blocked CDNs (2026-05-22 confirmed)
All ethers.js CDNs blocked in Browserbase:
`cdn.ethers.io` `cdnjs.cloudflare.com` `unpkg.com` `cdn.jsdelivr.net`
`cdn.skypack.dev` `esm.sh` `ga.jspm.io` `raw.githubusercontent.com` `cdn.statically.io`

## OpenSea Collection Info API

```bash
curl -s "https://api.opensea.io/api/v2/collections/<SLUG>" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Contract: {d[\"contracts\"][0][\"address\"]}')
print(f'Owner: {d[\"owner\"]}')
print(f'Supply: {d.get(\"total_supply\",0)} / {d.get(\"unique_item_count\",0)}')
"
```

Returns: contract address, owner, fees, socials, etc. Does NOT include eligibility data.

