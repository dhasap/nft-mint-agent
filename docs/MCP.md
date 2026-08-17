# Using nft-mint-agent as an MCP server

This project ships a [Model Context Protocol](https://modelcontextprotocol.io) server so any
MCP-compatible host (Claude Desktop, Claude Code, Cursor, or your own agent) can call the
NFT tools with **validated, typed arguments** — which is the most reliable way to stop an
agent from sending malformed calls.

## Architecture: what runs where

The toolkit is intentionally split across three surfaces. Pick the right one per job:

| Surface | Use it for | Why |
|---|---|---|
| **MCP server** (`npm run mcp`) | read / detect / decide / list: `parse_mint_link`, `detect_contract`, `check_wallets`, `get_mint_schedule`, `get_mint_status`, `scrape_contract_from_website`, `get_skill_health`, `mint_nft`, `schedule_mint`, `list_scheduled_mints`, `cancel_scheduled_mint`, `browser_mint`, `cancel_pending_tx`, `approve_seaport`, `list_nft`, `batch_list_nfts` | Typed schemas → the agent can't send wrong args; structured results for reasoning |
| **CLI `fast-mint.mjs`** | competitive / FCFS / max / hot drops | Zero per-mint LLM/transport latency. Pre-signed, multi-RPC fan-out, RBF |
| **`SKILL.md` / `AGENTS.md`** | the agent's decision rules | Tells the agent *which* surface to pick |

> ⚠️ `fast-mint` is deliberately **not** an MCP tool. Each MCP round-trip costs latency you cannot afford on a hot drop. Launch it as a one-shot CLI command instead.

## Setup

```bash
git clone https://github.com/dhasap/nft-mint-agent.git
cd nft-mint-agent
npm install
npm run build          # compiles src/ -> dist/ (required before running the server)
cp .env.example .env   # add RPC_URL + burner WALLET_PRIVATE_KEYS
npm run mcp            # starts the stdio MCP server
```

## Connect to a host

Copy `mcp.json` and set the **absolute** path + env. Example for Claude Desktop
(`claude_desktop_config.json`) or any host that uses the same shape:

```json
{
  "mcpServers": {
    "nft-mint-agent": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/nft-mint-agent/mcp-server.mjs"],
      "env": {
        "RPC_URL": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN": "ethereum",
        "WALLET_PRIVATE_KEYS": "0xBURNER_KEY_1,0xBURNER_KEY_2",
        "OPENSEA_API_KEY": "",
        "MAX_MINT_PRICE_ETH": "0.5",
        "DRY_RUN": "false"
      }
    }
  }
}
```

Run `npm run build` first — the server imports the compiled tools from `dist/`.

## Verify it works

```bash
printf '%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node mcp-server.mjs
```

You should see 19 tools listed. Logs go to **stderr**; stdout is the protocol channel.

## Safety

Every signing / broadcasting / listing action still requires explicit user confirmation,
and OpenSea/NFT metadata is treated as untrusted data. See [`SECURITY.md`](../SECURITY.md).
