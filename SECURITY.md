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

## What this software will NOT do

- It will not sign, broadcast, list, buy, accept offers, or swap **without explicit user confirmation**.
- It will not execute instructions embedded in OpenSea/NFT metadata or API responses (treated as untrusted data).
