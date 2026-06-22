<div align="center">

# 🤖 nft-mint-agent

**Competitive multi-wallet NFT auto-minting agent** for OpenSea/SeaDrop & direct contracts.
Low-latency fast-mint, scheduled drops, browser fallback, and listing — usable as an
**MCP server**, an **AI-agent skill** (Hermes / Claude), or a **standalone CLI**.

[![Version](https://img.shields.io/badge/version-3.4.0-blue.svg)](https://github.com/dhasap/nft-mint-agent/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CI](https://github.com/dhasap/nft-mint-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/dhasap/nft-mint-agent/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-43%20passing-brightgreen.svg)](tests)
[![Vulnerabilities](https://img.shields.io/badge/vulnerabilities-0-brightgreen.svg)](SECURITY.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![Ethers](https://img.shields.io/badge/ethers.js-v6-purple.svg)](https://docs.ethers.org/v6/)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](docs/MCP.md)
[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

</div>

> **Hot/FCFS/max mints use `fast-mint.mjs`** (raw EIP-1559, multi-RPC fan-out, RBF). OpenSea UI/API data is discovery-only — on-chain SeaDrop data wins for execution.

## Table of contents
- [Why this exists](#why-this-exists)
- [Features](#features)
- [Quick start](#quick-start)
- [Three ways to run it](#three-ways-to-run-it)
- [Competitive fast-mint](#competitive-fast-mint)
- [Tools (16)](#tools-16)
- [Configuration](#configuration)
- [Supported chains](#supported-chains)
- [Architecture](#architecture)
- [Security](#security) · [Contributing](#contributing) · [License](#license)

## Why this exists
Hot NFT drops sell out in seconds. Browser clicking, schedulers, and per-action agent round-trips
are **too slow**. This toolkit pre-warms everything and broadcasts pre-signed raw transactions across
multiple RPCs, with automatic replace-by-fee if a transaction misses its block — so you mint **on time**.

## Features
- ⚡ **Low-latency fast-mint** — parallel pre-signing, keep-alive socket pre-warm, **multi-RPC fan-out** raw broadcast, **RBF auto re-broadcast**, RPC clock calibration, mode-scaled priority fee
- 👛 **Multi-wallet parallel minting** — mint from many wallets at once
- 📅 **Scheduled drops** — persistent jobs that survive restarts
- 🌊 **OpenSea/SeaDrop** public minting + read-only discovery
- 🏷️ **Listing** — EIP-712 signed Seaport orders (after explicit confirmation)
- 🖥️ **Browser minting** — wallet injection for Connect-Wallet sites
- 🔌 **MCP server** — typed tools for any MCP host (Claude Desktop/Code, Cursor, custom agents)
- 🔗 **Multi-chain** — Ethereum, Polygon, Arbitrum, Optimism, Base, Zora, Blast
- 🛡️ **Safety-first** — hardened browser signer (blocks `approval`/`transfer` calls, per-tx value cap, contract allowlist, pinned `ethers` + Subresource Integrity), `MAX_MINT_PRICE_ETH` enforced on **every** mint path, explicit confirmation before signing/broadcasting, untrusted metadata, and **0 known dependency vulnerabilities**

## Quick start
```bash
git clone https://github.com/dhasap/nft-mint-agent.git
cd nft-mint-agent
npm install
cp .env.example .env   # add RPC_URL + burner WALLET_PRIVATE_KEYS
npm run build
```
```bash
# Check wallets
node runner.mjs check_wallets '{}'
# Detect a contract
node runner.mjs detect_contract '{"contract_address":"0xED5AF388653567Af2F388E6224dC7C4b3241C544"}'
# Health
node runner.mjs get_skill_health '{}'
```
👉 **Copy-paste recipes:** [`docs/QUICKSTART.md`](docs/QUICKSTART.md)

## Three ways to run it
| Surface | Command | Best for |
|---|---|---|
| **MCP server** | `npm run mcp` | Reliable, typed tool calls from an MCP host. See [`docs/MCP.md`](docs/MCP.md) |
| **CLI runner** | `node runner.mjs <tool> '<json>'` | Scripting & manual use; validates your args |
| **fast-mint CLI** | `node fast-mint.mjs ...` | Competitive / hot / FCFS drops (lowest latency) |

> The CLI runner validates required params and types, returning a structured error you can correct — no more silent failures from a wrong argument name.

## Competitive fast-mint
For hot, FCFS, max-mint, or OpenSea drops that sell out in seconds, **do not** browser-click or
`schedule_mint`. Preflight read-only, then broadcast with the raw-TX path:

```bash
# Read-only preflight
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" --time auto --qty max --wallets 0,1 --status

# Competitive broadcast
node fast-mint.mjs --url "https://opensea.io/collection/<slug>/overview" \
  --time auto --qty max --wallets 0,1 \
  --gas-mode aggressive --priority-gwei 8 --max-fee-gwei 150 --early-ms 750 \
  --broadcast-rpcs "https://rpc2...,https://rpc3..." \
  --rbf-after-ms 13000 --rbf-max 4
```

| Flag | Purpose | Hint |
|---|---|---|
| `--priority-gwei` | Tip — drives block ordering | default 5 (aggressive); 8-15 for very hot |
| `--max-fee-gwei` | Hard cap for maxFee | raise on congested mainnet |
| `--max-price-eth` | Hard cap for per-unit mint price (aborts above it) | defaults to `MAX_MINT_PRICE_ETH` or 0.5 |
| `--broadcast-rpcs` | Extra fan-out RPC endpoints | add 2-3 **different** premium RPCs — biggest win |
| `--rbf-after-ms` | Re-broadcast + bump if unmined | ~13000 ETH · ~3000-4000 on L2s |
| `--rbf-max` / `--rbf-bump` | Max bumps / factor | 4 / 1.18 (+18%) |
| `--early-ms` | Broadcast lead before start | 750; too early reverts `NotActive` |

**Rules:** live `getPublicDrop()` wins over OpenSea UI/API; recompute `value = mintPrice * qty` at
broadcast; wallets must afford `mintPrice*qty + gasLimit*maxFeePerGas` upfront; signing/broadcasting/
listing require explicit user confirmation.

## Tools (16)
**Information & detection:** `parse_mint_link` · `detect_contract` · `check_wallets` · `get_mint_schedule` · `get_mint_status` · `scrape_contract_from_website` · `get_skill_health`
**Execution:** `mint_nft` · `browser_mint` · `schedule_mint` · `list_scheduled_mints` · `cancel_scheduled_mint` · `cancel_pending_tx`
**Listing:** `approve_seaport` · `list_nft` · `batch_list_nfts`

Full schemas and examples: [`SKILL.md`](SKILL.md). For agents, start at [`AGENTS.md`](AGENTS.md).

## Configuration
```env
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN=ethereum
WALLET_PRIVATE_KEYS=0xkey1,0xkey2,0xkey3      # burner wallets only
GAS_MODE=aggressive                            # eco | normal | aggressive | custom
MAX_MINT_PRICE_ETH=0.5
OPENSEA_API_KEY=
DRY_RUN=false
# Fast-mint tuning
BROADCAST_RPC_URLS=                            # comma-separated extra RPCs for fan-out
FAST_MINT_RBF_AFTER_MS=13000
FAST_MINT_RBF_MAX=4
```
See [`.env.example`](.env.example) for the full list.

## Supported chains
| Chain | ID | Status |
|---|---|---|
| Ethereum | 1 | Full |
| Polygon | 137 | Full |
| Arbitrum | 42161 | Full |
| Optimism | 10 | Full |
| Base | 8453 | Full |
| Zora | 7777777 | Partial (different protocol) |
| Blast | 81457 | Full |

## Architecture
```
User link
   │  parse_mint_link → detect type
   ▼
┌──────────────────────────────────────────────┐
│ Hot/FCFS/max OpenSea/SeaDrop                   │
│   → fast-mint.mjs (pre-signed raw TX, fan-out, │
│     RBF, clock sync)                           │
├──────────────────────────────────────────────┤
│ Standard mint(uint256)  → mint_nft (parallel)  │
├──────────────────────────────────────────────┤
│ Connect Wallet / server sig → browser_mint     │
├──────────────────────────────────────────────┤
│ Non-competitive future drop → schedule_mint    │
└──────────────────────────────────────────────┘
   ▼
approve_seaport → list_nft   (after price confirmation)
```
```
nft-mint-agent/
├── src/             # TypeScript tools, mint logic, scheduler, gas oracle, wallet, listing
├── runner.mjs       # validated CLI runner
├── mcp-server.mjs   # MCP (Model Context Protocol) server
├── fast-mint.mjs    # competitive raw-TX path
├── docs/            # QUICKSTART.md, MCP.md
├── references/      # operational references & safety checklists
└── SKILL.md         # the agent "brain" (decision tree + rules)
```

## Tech stack
ethers.js v6 · TypeScript 5.5 · Axios · Seaport v1.6 (EIP-712) · `@modelcontextprotocol/sdk`

## Security
This software handles **private keys** and broadcasts **real transactions**. Use burner wallets,
never commit `.env`, and read [`SECURITY.md`](SECURITY.md). Report vulnerabilities privately.

**Hardening built in (v3.4.0):**
- **Hardened browser signer** — the injected `window.ethereum` refuses asset-moving calls
  (`setApprovalForAll`, `approve`, `transfer`, `transferFrom`, `safeTransferFrom`, `increaseAllowance`,
  `permit`), enforces a per-tx **value cap**, supports a **contract allowlist**, and **disables
  typed-data (order) signing by default**. A malicious or compromised mint page can't drain the wallet.
- **Pinned dependency + SRI** — `ethers` loads from a version-pinned CDN with a Subresource Integrity
  hash, so a tampered CDN file is rejected.
- **`MAX_MINT_PRICE_ETH` enforced everywhere** — the agent/MCP path, `DirectMinter`, and the competitive
  `fast-mint.mjs` (re-checked against the freshest on-chain price right before broadcast).
- **Safer key generation** — `generate-wallets` never prints keys to stdout, writes `0600` files, and can
  emit an **encrypted JSON keystore** (password via arg or `WALLET_ENCRYPT_PASSWORD`).
- **0 dependency vulnerabilities** (`npm audit`) and **43 passing tests** (incl. a dedicated security suite).

## Contributing
PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## License
[MIT](LICENSE) © dhasap

---

<div align="center">

`nft` · `minting` · `nft-bot` · `mint-bot` · `opensea` · `seadrop` · `seaport` · `multi-wallet` · `fast-mint` · `erc721` · `erc1155` · `evm` · `ethers` · `mcp` · `model-context-protocol` · `ai-agent` · `hermes-agent` · `claude` · `multi-chain` · `web3`

</div>
