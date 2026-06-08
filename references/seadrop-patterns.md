# SeaDrop V1 Patterns & Pitfalls

## Contract Architecture
SeaDrop V1 uses a **split architecture**:
- **NFT Contract** (e.g. `0xaccaa...`): ERC721 token, holds `name`, `symbol`, `maxSupply`, `totalSupply`
- **SeaDrop Contract** (e.g. `0xbb248...`): Handles minting logic, has `mint(uint256)`, `mint(address,uint256)`, `mint(uint256,address)` overloads

Detection: `detect_contract` returns `isMintable: true` + `mint(uint256)` for SeaDrop contract, but `isMintable: false` for NFT contract (no mint function).

## Stage Types (from OpenSea SSR data)
Extract from `window[Symbol.for("urql_transport")]` → `dropBySlug` → `stages`:

```json
{
  "stageType": "SIGNED_PRESALE",  // or "PUBLIC_SALE"
  "stageIndex": 1,
  "startTime": "2026-05-22T10:40:00.000Z",
  "endTime": "2026-05-22T15:00:00.000Z",
  "price": { "token": { "unit": 0, "symbol": "ETH" } },
  "maxTotalMintableByWallet": 1
}
```

**Stage mapping (from page labels):**
| stageIndex | Label | Type |
|------------|-------|------|
| 1 | Team | SIGNED_PRESALE |
| 2 | GTD | SIGNED_PRESALE |
| 3 | WL | SIGNED_PRESALE |
| 4 | FCFS | SIGNED_PRESALE |
| 0 | Public | PUBLIC_SALE |

## Eligibility Flow
- **PUBLIC_SALE**: `mint(uint256)` works directly, no proof needed
- **SIGNED_PRESALE** (Team/GTD/WL/FCFS): Needs merkle proof from OpenSea backend
  - OpenSea determines eligibility via GraphQL + wallet signature
  - `mint(uint256)` on-chain call MAY work without proof (depends on SeaDrop config)
  - If it reverts with "not eligible" or similar, the stage requires signed data
  - **Cannot get proof without wallet connect + personal_sign** (ethers.js CDN blocked in Browserbase)

## Contract Address Extraction from OpenSea
```bash
# Method 1: SSR data (most reliable)
# Look for "collectionBySlug" in page scripts → "drop" → contract addresses

# Method 2: API (may return null for new collections)
curl -sL "https://api.opensea.io/api/v2/collections/<SLUG>" | grep -o '"address":"0x[^"]*"'

# Method 3: Browser console
# Extract from self.__next_f scripts or urql_transport rehydration
```

**Typical addresses found:**
- `0xaccaa...` — NFT contract (UniPix)
- `0xbb248...` — SeaDrop V1 contract (mint target)
- `0xc02a...` — WETH (ignore)
- `0x0000...` — Zero address (ignore)

## Timing (GMT+8 → WIB)
OpenSea shows times in GMT+8. User is in WIB (GMT+7).
Always convert: WIB = GMT+8 - 1 hour.

## Gas Estimates for Free Mint
- Simple `mint(uint256)` call: ~100k-200k gas
- At 0.59 Gwei average: ~0.0001-0.0002 ETH ($0.20-0.40)
- At 2.2 Gwei fast: ~0.0004 ETH ($0.85)
- Minimum safe balance: 0.001 ETH

## Test TX Observations
- Calling `mint(uint256)` when stage is not active: succeeds but uses only 21510 gas (no-op)
- No Transfer events emitted = no NFT minted
- Gas cost for no-op: ~$0.008 (negligible)

