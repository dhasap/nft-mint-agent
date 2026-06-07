# OpenSea Current SeaDrop V1 (mainnet) notes

Canonical copy is also saved in the Hermes skill registry under `references/opensea-current-seadrop-v1.md`.

## Mandatory lessons

- Newer mainnet OpenSea SeaDrop minter observed: `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`.
- Do not use any hardcoded SeaDrop candidate unless `eth_getCode` is non-empty and `getPublicDrop(nft)` succeeds.
- Current ABI subset:

```js
const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns(address[])',
  'function getFeeRecipientIsAllowed(address nftContract,address feeRecipient) view returns(bool)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
];
```

- For self-mint: `mintPublic(NFT, feeRecipient, ethers.ZeroAddress, qty, { value: mintPrice * qty })`.
- Live `getPublicDrop()` beats OpenSea UI/SSR for price/max/start/end.
- Hot mints must use `fast-mint.mjs` raw pre-signed tx path, not agent cron/browser/schedule_mint.
- Wallet must afford `mintPrice * qty + gasLimit * maxFeePerGas` upfront.
- Output times in WIB for this user.
