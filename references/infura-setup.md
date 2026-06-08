# Infura Setup Notes

## Endpoints
- Mainnet HTTPS: `https://mainnet.infura.io/v3/<PROJECT_ID>`
- Mainnet WSS: `wss://mainnet.infura.io/v3/<PROJECT_ID>`
- Sepolia testnet: `https://sepolia.infura.io/v3/<PROJECT_ID>`

## Test connection
```bash
curl -s https://mainnet.infura.io/v3/<PROJECT_ID> \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```
Should return `{"jsonrpc":"2.0","id":1,"result":"0x..."}`

## Rate limits (free tier)
- 100,000 requests/day
- 10 requests/second
- 3 concurrent WebSocket connections

## Common errors
- `401 Unauthorized`: Invalid or expired project ID
- `429 Too Many Requests`: Rate limit hit — add delays between wallet mints
- `project ID does not have access to archive data`: Need paid plan for `eth_call` on old blocks

## For NFT minting
- `eth_estimateGas` works on mainnet for current block
- `eth_call` for contract detection works fine
- No archive data needed for standard minting flow

