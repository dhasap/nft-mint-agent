# Contributing

Thanks for your interest in improving **nft-mint-agent**! 🎉

## Ways to contribute

- 🐛 Report bugs via [Issues](../../issues) (use the Bug Report template).
- 💡 Propose features via the Feature Request template.
- 🔧 Open a PR for fixes, new chains, new mint patterns, or docs.

## Development setup

```bash
git clone https://github.com/dhasap/nft-mint-agent.git
cd nft-mint-agent
npm install
cp .env.example .env   # add RPC_URL + burner WALLET_PRIVATE_KEYS
npm run build          # tsc -> dist/
```

## Before you open a PR

1. `npm run build` must pass with no TypeScript errors.
2. Keep the **competitive mint path** (`fast-mint.mjs`) free of per-mint LLM/round-trip dependencies — latency is the product.
3. Never weaken the safety rules in `SECURITY.md` or `SKILL.md` (explicit confirmation before signing/broadcasting).
4. Update `CHANGELOG.md` under "Unreleased".
5. Do not commit secrets. Run a quick scan: `git grep -nE "0x[a-fA-F0-9]{64}"` should return nothing.

## Commit style

Conventional commits: `feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `chore:`.

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
