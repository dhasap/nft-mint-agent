# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [3.3.0] - 2026-06-22

### Added
- **MCP server** (`src/mcp/server.ts`, `npm run mcp`) exposing the read/decision/listing tools over the Model Context Protocol with validated JSON Schemas. See [`docs/MCP.md`](docs/MCP.md).
- Argument **validation in `runner.mjs`** — required-param checks, type checks, unknown-param detection, and self-correcting error output for agents.
- Professional repo scaffolding: `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, and CI.
- `docs/QUICKSTART.md` agent cheat sheet and a hardened decision tree in `SKILL.md`.

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
