# OpenSea post-mint verification patterns

Use this when a user asks whether an OpenSea/SeaDrop mint succeeded, or when a mint session died before reporting TX hashes.

## 1. Resolve the correct collection slug first

OpenSea slugs can be ambiguous. A short slug like `/collection/unipix` may point to an older collection on another chain, while the intended collection is visible from an item page or SSR data.

Reliable checks:
- Open the NFT contract item URL: `https://opensea.io/item/<chain>/<contract>/<tokenId>`.
- Extract `collection.slug`, breadcrumb JSON-LD, and `collection.address` from SSR/`urql_transport` scripts.
- Confirm chain + contract match the expected NFT contract before using collection floor/status data.

Example browser console probe:
```js
(() => {
  const txt = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\n');
  return {
    title: document.title,
    url: location.href,
    slugs: [...new Set([...txt.matchAll(/"slug":"([^"]+)"/g)].map(m => m[1]))],
    addresses: [...new Set([...txt.matchAll(/"(?:contractAddress|address)":"(0x[a-fA-F0-9]{40})"/g)].map(m => m[1].toLowerCase()))],
  };
})()
```

## 2. Do not trust profile/owner addresses as SeaDrop contracts

OpenSea SSR often includes `owner.address` for the collection profile. That can be an EOA, not the mint contract. Before treating any address as a mint/proxy contract:

```js
const code = await provider.getCode(address);
if (code === '0x') throw new Error('Address is an EOA, not a contract');
```

`detect_contract` may false-positive on an EOA if ABI heuristics are used without a bytecode check. Always verify `eth_getCode` for every candidate address before minting or schedule reads.

## 3. Verify whether configured wallets received the NFT

For ERC-721:
```js
import { ethers } from 'ethers';
const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
const nft = '0x...';
const wallets = [['alpha','0x...'], ['bravo','0x...']];
const abi = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];
const c = new ethers.Contract(nft, abi, provider);
for (const [name, addr] of wallets) {
  const bal = await c.balanceOf(addr);
  const tokens = [];
  for (let i = 0; i < Number(bal); i++) {
    try { tokens.push((await c.tokenOfOwnerByIndex(addr, i)).toString()); }
    catch { tokens.push('tokenOfOwnerByIndex unsupported'); break; }
  }
  console.log({ name, addr, balance: bal.toString(), tokens });
}
```

Also query `Transfer` logs to catch receive-then-transfer-out cases:
```js
const transferTopic = ethers.id('Transfer(address,address,uint256)');
const topicAddr = a => ethers.zeroPadValue(a, 32);
const logs = await provider.getLogs({
  address: nft,
  fromBlock,
  toBlock: 'latest',
  topics: [transferTopic, null, topicAddr(wallet)],
});
```

Some public RPCs cap `eth_getLogs` ranges (e.g. 50k blocks). Page ranges in chunks (e.g. 45k blocks) instead of concluding no logs from a failed large-range query.

## 4. Public RPC fallback

If the configured RPC is rate-limited, use a public read-only RPC for verification only:
- `https://ethereum-rpc.publicnode.com`
- `https://1rpc.io/eth`

Do not silently use fallback RPCs for signing/minting unless the user has configured/approved that provider for write operations.

