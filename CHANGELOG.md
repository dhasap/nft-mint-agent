# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

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
