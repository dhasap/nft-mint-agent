# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [3.4.0] - 2026-06-22

### Security
- **Browser injected provider hardened** (`src/browser/inject.ts`). The injected EIP-1193 provider previously signed/sent *any* request from the page. It now:
  - blocks asset-moving selectors (`setApprovalForAll`, `approve`, `transfer`, `transferFrom`, `safeTransferFrom`, `increaseAllowance`, `permit`) — common wallet-drain vectors;
  - enforces a per-tx **value cap** (defaults to `MAX_MINT_PRICE_ETH`);
  - supports an optional **destination contract allowlist**;
  - **disables typed-data signing by default** (Seaport orders/permits can authorize transfers) — opt in via `allowOrderSigning`;
  - loads `ethers` from a **pinned CDN with Subresource Integrity (SRI)** instead of an unpinned URL.
- **`fast-mint.mjs` now enforces `MAX_MINT_PRICE_ETH`** (new `--max-price-eth` flag), checked at startup and again against the freshest on-chain price right before broadcast. Previously the competitive CLI had no price cap.
- **`DirectMinter.mint()`** enforces the price cap internally (defense-in-depth) instead of relying solely on the tool layer.
- **Wallet generation** (`src/wallet/generate.ts`) no longer prints private keys to stdout, writes output with `0600` permissions, and supports an **encrypted JSON keystore** (password via arg or `WALLET_ENCRYPT_PASSWORD`).
- **Dependencies**: upgraded to clear all advisories (`ws`, `form-data`, and dev-chain `esbuild`/`vite`/`vitest`). `npm audit` now reports **0 vulnerabilities**.

### Added
- 15 new security unit tests (`tests/security.test.ts`) executing the actual injected guard logic, the `DirectMinter` price cap, and a `fast-mint` cap regression check (43 tests total).

### Changed
- **Docs consolidated** — removed 4 redundant/duplicate agent-instruction files (`AGENT.md`, `AGENT_HERMES.md` (byte-identical), `AGENT_CLAUDE_CODE.md`, `AGENT_GENERIC.md`) and a stale root reference stub. Agents now read one router ([`AGENTS.md`](AGENTS.md)) plus the authoritative [`SKILL.md`](SKILL.md). Added a documentation map to the README.
- **CI** now tests on Node 20 & 22 (dropped EOL Node 18); added `engines: ">=20"`. `vitest@4` requires Node 20+.

## [3.3.0] - 2026-06-22

### Added
- **MCP server** (`mcp-server.mjs`, `npm run mcp`) exposing the tools over the Model Context Protocol with validated JSON Schemas, **per-tool safety annotations** (`readOnlyHint`/`destructiveHint`), and an opt-in **`MCP_READONLY`** mode that hides execution tools. See [`docs/MCP.md`](docs/MCP.md).
- Argument **validation in `runner.mjs`** — required-param checks, type checks, unknown-param detection, and self-correcting error output for agents.
- **Test suite (Vitest)** with 28 unit tests covering gas params, RBF bump (>=10% replacement), `defaultGasLimit`, the URL parser, concurrency/retry utils, and config — wired into CI via `npm test`.
- Extracted pure gas helpers into `lib/fastmint-gas.mjs` (unit-testable).
- **Opt-in WebSocket block-active trigger** for `fast-mint` (`--ws-active`, needs `RPC_WS_URL`) that fires the instant a block timestamp shows the drop is active — avoids both `NotActive` reverts and lateness. Default stays the proven timer path. Persistent socket warmer keeps broadcast RPC connections hot during the wait.
- Security automation: **Dependabot** (npm + actions) and a **Gitleaks** CI job, plus a targeted private-key/mnemonic scan and `npm audit`.
- Professional repo scaffolding: `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, GitHub issue/PR templates, and CI.
- `docs/QUICKSTART.md` agent cheat sheet and a hardened decision tree in `SKILL.md`.

### Fixed
- Stale `v2.1` banner in `src/index.ts` → `v3.3`.
- CI secret-scan false positives on legitimate 64-hex constants (`zoneHash`, `conduitKey`, test tx hash) — scan now targets real key/mnemonic assignments.

### Changed
- `fast-mint.mjs` low-latency rewrite (see 3.2.x perf notes): parallel pre-signing, multi-RPC fan-out with keep-alive socket pre-warm, raw `eth_sendRawTransaction`, RBF auto re-broadcast, clock calibration, and a higher mode-scaled priority fee (aggressive default 2 → 5 gwei).
- Synced all docs to the new fast-mint flags and priority defaults.

## [3.2.0] - 2026-06-08
- Hardened SeaDrop fast minting; OpenSea read-only discovery lessons; SEO README.

## [3.0.0] - 2026-06-03
- 25 bug fixes + PRD optimizations.

## [2.1.0] - 2026-05-19
- Browser-based minting (2 new tools), scheduled auto-minting (4 new tools).

## [1.0.0] - 2026-05-19
- Initial release: NFT minting Hermes skill.
