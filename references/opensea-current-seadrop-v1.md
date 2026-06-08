# OpenSea Current SeaDrop V1 (mainnet) notes

Use this when an OpenSea collection resolves to an `ERC721SeaDrop` NFT contract but `detect_contract` says the NFT is not mintable, or `get_mint_schedule` fails to identify SeaDrop.

## Key lesson

Do **not** assume a single hardcoded SeaDrop address or ABI. Some newer OpenSea drops use a SeaDrop minter address that differs from older scripts, and the public-drop tuple layout differs from older ABIs.

Observed mainnet OpenSea SeaDrop minter for newer drops:

```text
0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
```

Older scripts/docs may mention `0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe`; verify with `eth_getCode` and `getPublicDrop(nft)` before using it. If `eth_getCode` is `0x`, it is not a usable minter on that chain/RPC.

Example PLOP (`plop-fun`) NFT contract constructor decoded `allowedSeaDrop` to `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`. The NFT contract itself exposes `mintSeaDrop(address,uint256)` for the SeaDrop minter, so a normal wallet should mint by calling SeaDrop, not the NFT contract.

## Resolve and verify

```bash
SLUG=plop-fun
curl -sL "https://api.opensea.io/api/v2/collections/$SLUG" \
  | jq -r '.contracts[] | "\(.address) \(.chain)"'

NFT=0x06ea2bf75bedc071be4c20361656c665145b38d4
curl -sL "https://eth.blockscout.com/api/v2/smart-contracts/$NFT" \
  | jq '.decoded_constructor_args, .name, .file_path'
```

Look for constructor arg `allowedSeaDrop`, e.g.:

```json
[
  "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5"
]
```

If using ethers v6, normalize hardcoded addresses with lower-case or a valid checksum; mixed-case bad checksums throw `bad address checksum`.

## Current SeaDrop ABI subset

```js
const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getCreatorPayoutAddress(address nftContract) view returns(address)',
  'function getAllowedFeeRecipients(address nftContract) view returns(address[])',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns(bool)',
  'function getPayers(address nftContract) view returns(address[])',
  'function getPayerIsAllowed(address nftContract,address payer) view returns(bool)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
];
```

For a wallet minting for itself, call:

```js
await seadrop.mintPublic(
  NFT,
  feeRecipient,                  // from getAllowedFeeRecipients() if restricted
  ethers.ZeroAddress,             // zero means msg.sender
  quantity,
  { value: mintPrice * quantity }
);
```

If `restrictFeeRecipients` is true, use one of `getAllowedFeeRecipients(nftContract)`. OpenSea fee recipient often appears as:

```text
0x0000a26b00c1F0DF003000390027140000fAa719
```

If `minterIfNotPayer` differs from `msg.sender`, the payer must be in `getPayers()`/`getPayerIsAllowed()` or the call reverts with payer-not-allowed.

## On-chain values beat UI/SSR for execution

OpenSea UI/SSR can disagree with SeaDrop storage. For execution, **always** prefer live `getPublicDrop`:

```text
mintPrice                  uint80 wei
startTime / endTime         uint48 unix seconds
maxTotalMintableByWallet   uint16
feeBps                     uint16
restrictFeeRecipients      bool
```

PLOP failure lesson:
- UI/SSR showed `0 ETH` and max 10 at one point.
- Live SeaDrop later required `0.0002 ETH` per NFT and changed max per wallet.
- Sending `value: 0` for qty 7 reverted with `IncorrectPayment(got=0,want=0.0014 ETH)`.

Therefore fast-mint scripts must re-read and use live SeaDrop price/max immediately before broadcast.

## Competitive mint rules

For hot mints / FCFS / max mint / supply likely to sell out in seconds:

1. Do not use `schedule_mint`, browser click automation, or agent cron as the critical path.
2. Use `/root/nft-minting-skill/fast-mint.mjs` with raw pre-signed EIP-1559 tx broadcast.
3. Preflight first:
   ```bash
   node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --status
   ```
4. Broadcast with aggressive gas and early submit:
   ```bash
   node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --gas-mode aggressive --priority-gwei 2 --max-fee-gwei 100 --early-ms 750
   ```
5. No live `estimateGas` at mint time. Estimate/simulations often revert before start and add fatal delay. Use conservative gas limit; unused gas is refunded.
6. Wallet must afford upfront `mintPrice * qty + gasLimit * maxFeePerGas`. If not, skip and tell user to fund wallet.
7. Disable ethers JSON-RPC batching for mint-critical scripts:
   ```js
   const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
   ```
8. Retry transient RPC errors containing `missing response`, `timeout`, `429`, `rate`, `network`, or `server` during pre-warm only — not during the exact broadcast second.

## Output style for this user

For NFT minting checks, schedules, and results for this user, use compact but visually neat output and convert all times to WIB (`Asia/Jakarta`). Example:

```text
════════════════════════════════════════════════════════════════════
🚀 PLOP AUTO-MINT — SeaDrop Public Mint
════════════════════════════════════════════════════════════════════
🕘 Sekarang       : 07/06/2026 22:53:41 WIB
🎯 Submit target  : 07/06/2026 23:00:52 WIB
👛 Wallet Plan
────────────────────────────────────────────────────────────────────
• Wallet 0 0xEa15...6e22
  Balance ETH    : 0.00066993 ETH
  Akan mint      : 7 NFT
```

