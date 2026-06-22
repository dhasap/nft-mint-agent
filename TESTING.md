# Testing & Bug-Fix Report

End-to-end testing of `nft-mint-agent` covering unit tests, dry-run of every tool,
and **real on-chain mints on Base Sepolia (chainId 84532)**. Testing surfaced
**6 bugs**, all fixed and re-verified.

## Test summary

| Area | Method | Result |
|------|--------|--------|
| Unit suite (`vitest`) | `npm test` | 43/43 pass |
| Build (`tsc`) | `npm run build` | clean |
| All 16 tools | dry-run via `runner.mjs` | pass |
| Direct mint (`mint_nft`) | real mint, Base Sepolia | pass |
| Multi-wallet mint | real, 2 wallets concurrent | pass |
| `fast-mint.mjs` | real mint vs mock SeaDrop | pass |
| `fast-mint.mjs` multi-wallet | real, 2 wallets, same block | pass |

## Bugs found & fixed

### 1. `approve_seaport` ignored `DRY_RUN` (`src/listing/index.ts`)
`approveSeaport()` broadcast a real `setApprovalForAll` tx even when `DRY_RUN=true`.
The dry-run guard only existed in `list()`. Fixed: guard inside `approveSeaport()`
returns a `0x_dry_run` hash without broadcasting.

### 2. `schedule_mint` far-future jobs fired immediately (`src/scheduler/index.ts`)
Node's `setTimeout` uses a 32-bit signed delay; any delay > ~24.8 days overflowed
and fired almost instantly, so a job scheduled for 2030 executed right away. Fixed
with `armTimer()` which chunks long delays and re-arms.

### 3. Scheduler timers blocked CLI exit (`src/scheduler/index.ts`)
After fix #2 the (correctly) pending timer kept the Node event loop alive, so the
one-shot CLI hung. Fixed with `timer.unref()` so background timers never block a
short-lived process (long-running MCP host stays alive via its transport).

### 4. `mint_nft` reported false failure on "already known" (`src/mint/direct.ts`) — HIGH
On load-balanced public RPCs, `eth_sendRawTransaction` can be retried internally;
the duplicate returns `already known` / `nonce too low`. The old code surfaced this
as a hard failure **even though the mint succeeded on-chain** — risking a confused
user double-minting. Fixed: build + sign + broadcast ourselves (always know the
hash), treat "already submitted" errors as success, and wait on the known hash.
Verified deterministically by double-broadcasting the same signed tx to the real node.

### 5. `fast-mint.mjs` crashed on empty fee-recipient list — HIGH
`feeRecipients?.[0]` threw `RangeError: out of result range`: ethers v6 `Result`
throws on out-of-bounds index access (so `?.` doesn't help). Drops with
`restrictFeeRecipients = false` return an empty list, so this crashed the entire
competitive mint before broadcast. Fixed with an explicit length check.

### 6. `fast-mint.mjs` hardcoded `etherscan.io` explorer link (cosmetic)
Output linked Base Sepolia txs to Ethereum mainnet. Fixed with a chain-aware
`explorerTxUrl(chainId, hash)` map.

### Bonus: testnet chain support (`src/config/index.ts`)
Added `base-sepolia` (84532), `optimism-sepolia` (11155420), `arbitrum-sepolia`
(421614) to `CHAIN_IDS` so the agent runs on EVM testnets.

## On-chain evidence (Base Sepolia)

Test contracts deployed for verification (sources in `tests/testnet/`):

- `TestMintNFT` (plain ERC-721, `mint(uint256)`): `0x08D7C4CC4c08917c9FDd3270C9c23cb042B72e21`
- `MockSeaDrop`: `0x5F312B896D480615621770F2FcC67bDd0EE1f855`
- `MockSeaDropNFT`: `0x4a9e7DC5114b45419f14A16564cb527FBBACb257`

Representative successful mint transactions:

| Path | Tx | Tokens |
|------|----|--------|
| Direct mint (post-fix) | `0x60bc44bb986073717c8e2942a99711df3e58cd97d90842ad5ab0807adf355a2d` | 2 |
| "already known" recovery proof | `0x64439ccb927d0b078a5bdd98242d5714427e7f787361ad23b4372c1893220ab4` | 3 |
| Multi-wallet (wallet 0 / wallet 1) | `0x56c0a97e…` / `0xaba01d80…` | 4,5 / 6,7 |
| fast-mint single | `0x2a91f970f5e9e8702d761d531e88b5bafc04fcc4bbe1dfb800657550a9aa56f9` | 0,1 |
| fast-mint multi-wallet (same block) | `0x869567fd…` / `0xd056062583…` | 4,5 / 6,7 |

## Reproducing the testnet tests

The mock contracts in `tests/testnet/` implement the exact SeaDrop interface
`fast-mint.mjs` calls. To redeploy and exercise the full path:

1. `npm i -D solc` (compiler, not a runtime dependency)
2. Set `.env` with `RPC_URL=https://sepolia.base.org`, `CHAIN=base-sepolia`,
   `WALLET_PRIVATE_KEYS=<burner key(s)>`, `DRY_RUN=false`.
3. Deploy the mocks, configure an active public drop, then run:
   `node fast-mint.mjs --contract <nft> --seadrop <mockSeaDrop> --time auto --qty 2 --wallets 0,1 --gas-mode normal`

> Not yet covered: RBF under contended mempools, and real Seaport listing
> (Seaport is not deployed on Base Sepolia).
