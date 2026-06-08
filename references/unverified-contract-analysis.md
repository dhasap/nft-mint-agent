# Unverified Contract Analysis

When `detect_contract` returns all nulls (unverified contract), use this manual workflow.

## Step 1: Get Contract Info from Blockscout

No API key needed. Use when Etherscan is blocked by Cloudflare.

```bash
# Basic info
curl -s "https://eth.blockscout.com/api/v2/addresses/<ADDR>"

# Transactions (see what methods are being called)
curl -s "https://eth.blockscout.com/api/v2/addresses/<ADDR>/transactions"

# Token transfers (find actual token contract if presale)
curl -s "https://eth.blockscout.com/api/v2/addresses/<ADDR>/token-transfers"
```

**Key fields:**
- `is_contract` / `is_verified` — confirm it's a contract
- `token_transfers[].token.address_hash` — actual token address (may differ from presale contract)
- `transactions[].method` — function names being called
- `transactions[].raw_input` — raw calldata (first 10 chars = function selector)

## Step 2: Extract Function Selectors from Bytecode

```bash
# Get bytecode via public RPC
curl -s -X POST "https://ethereum-rpc.publicnode.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getCode","params":["<ADDR>","latest"],"id":1}'
```

**Extract PUSH4 selectors (Python):**
```python
# code = result from eth_getCode (hex string)
selectors = set()
for i in range(0, len(code)-10, 2):
    if code[i:i+2] == '63':  # PUSH4 opcode
        sel = '0x' + code[i+2:i+10]
        try:
            int(sel, 16)
            selectors.add(sel)
        except:
            pass
```

## Step 3: Resolve Selectors via 4byte.directory

```bash
curl -s "https://www.4byte.directory/api/v1/signatures/?hex_signature=0x<SELECTOR>"
```

**⚠️ 4byte.directory has spam** — many selectors return joke/placeholder names. Use domain knowledge to identify real function names.

## Step 4: Read State Variables via eth_call

```bash
curl -s -X POST "https://ethereum-rpc.publicnode.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<ADDR>","data":"<SELECTOR>"},"latest"],"id":1}'
```

**Decoding:**
- `uint256` → `int(result, 16)`
- `address` → `"0x" + result[-40:]`
- `bool` → `int(result, 16) == 1`
- Revert = error in response

## Step 5: Check DEX Liquidity (Uniswap V2)

```bash
# Find pair address via Factory
FACTORY="0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"
# getPair(tokenA, tokenB) = 0xe6a43905
# Encode: 0xe6a43905 + pad(tokenA) + pad(tokenB)

# Get reserves
# getReserves() = 0x0902f1ac
# Returns: reserve0 (uint112), reserve1 (uint112), blockTimestampLast (uint32)

# Check token order
# token0() = 0x0dfe1681
```

**Price calculation:**
```
price = reserve_weth / reserve_token
market_cap = price * total_supply
```

**Liquidity assessment:**
- < 5 ETH = VERY LOW (high slippage, easy manipulation)
- 5-20 ETH = LOW (caution with large buys)
- 20-100 ETH = MEDIUM
- \> 100 ETH = HIGH

## Common Function Selectors

| Selector | Function |
|----------|----------|
| `0x18160ddd` | `totalSupply()` |
| `0x70a08231` | `balanceOf(address)` |
| `0xa9059cbb` | `transfer(address,uint256)` |
| `0x23b872dd` | `transferFrom(address,address,uint256)` |
| `0xd21220a7` | `approve(address,uint256)` |
| `0x8da5cb5b` | `owner()` |
| `0xf2fde38b` | `transferOwnership(address)` |
| `0x715018a6` | `renounceOwnership()` |
| `0x0dfe1681` | `token0()` (Uniswap pair) |
| `0x0902f1ac` | `getReserves()` (Uniswap pair) |
| `0xe6a43905` | `getPair(address,address)` (Uniswap factory) |

## Uniswap Links

**Swap link format:**
```
https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=<TOKEN_ADDR>
```

**DEXScreener pair:**
```
https://dexscreener.com/ethereum/<PAIR_ADDR>
```

## Red Flags Checklist

- ⚠️ Contract not verified
- ⚠️ Very few holders (< 10)
- ⚠️ `freeMint()` function exists (dump risk)
- ⚠️ Low liquidity (< 15 ETH)
- ⚠️ `launchLiquidity()` already called (sale over, rug risk)
- ⚠️ High fees (check fee recipients)
- ⚠️ Recently created (< 24h)

