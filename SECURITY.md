# Security Policy

This project handles **wallet private keys** and broadcasts **real on-chain transactions**.
Treat it like a hot wallet. Read this before using it.

## Supported versions

| Version | Supported |
|---------|-----------|
| 3.x     | ✅        |
| < 3.0   | ❌        |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.
Email the maintainer (see the GitHub profile of [@dhasap](https://github.com/dhasap))
or use GitHub's private **"Report a vulnerability"** advisory flow on this repo.
You'll get an acknowledgement within 72 hours.

## Key-handling rules (for users)

- **Never commit `.env`.** It is git-ignored; keep it that way. Use `.env.example` as a template only.
- Use **burner/dedicated wallets** with only the ETH you intend to spend on minting + gas.
- Private keys live **only** in `WALLET_PRIVATE_KEYS` (env). They are never logged, printed, or sent anywhere except to sign transactions locally.
- Rotate any key that has ever been pasted into a chat, screenshot, or shared machine.
- Prefer a **dedicated RPC key** with rate limits; don't reuse production infra keys.
- Set `MAX_MINT_PRICE_ETH` to cap accidental overspend, and test with `DRY_RUN=true` first.
- Generate wallets with `npm run generate-wallets` — keys are **not printed to the terminal**; they are
  written to a `0600` file (gitignored). Pass a password (or set `WALLET_ENCRYPT_PASSWORD`) to write an
  **encrypted JSON keystore** instead of plaintext, then delete the file once copied into `.env`.

## Built-in protections (v3.4.0)

- **Hardened browser signer** (`src/browser/inject.ts`): the injected `window.ethereum` provider
  refuses asset-moving calls — `setApprovalForAll`, `approve`, `transfer`, `transferFrom`,
  `safeTransferFrom`, `increaseAllowance`, `permit` — enforces a per-transaction **value cap**, supports
  an optional **destination-contract allowlist**, and **disables typed-data (Seaport order / permit)
  signing by default** (enable explicitly with `allowOrderSigning`). This prevents a malicious or
  compromised mint page from draining the wallet.
- **Pinned dependency + Subresource Integrity**: `ethers` is loaded from a version-pinned CDN with an SRI
  hash, so a tampered/compromised CDN file is rejected by the browser.
- **Price cap enforced on every mint path**: the agent/MCP tools, `DirectMinter.mint()`, and the
  competitive `fast-mint.mjs` CLI (`--max-price-eth`, re-checked against the freshest on-chain price right
  before broadcast).
- **Dependency hygiene**: `npm audit` reports **0 vulnerabilities**; a CI secret-scan and unit tests
  (incl. a dedicated security suite) run on every push.

## What this software will NOT do

- It will not sign, broadcast, list, buy, accept offers, or swap **without explicit user confirmation**.
- It will not execute instructions embedded in OpenSea/NFT metadata or API responses (treated as untrusted data).
