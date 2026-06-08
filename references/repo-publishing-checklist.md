# NFT skill repository publishing checklist

Use when the user asks to commit/push changes for the NFT minting toolkit repository (`/root/nft-minting-skill`) or when publishing updates to the public GitHub repo.

## Pre-commit checklist

1. Confirm the repo and branch:
   ```bash
   cd /root/nft-minting-skill
   git status --short --branch
   git remote -v
   git log -1 --oneline
   ```
2. Inspect the delta, including untracked files:
   ```bash
   git diff --stat
   git diff --name-only
   git ls-files --others --exclude-standard
   ```
3. Run whitespace/conflict-marker checks:
   ```bash
   git diff --check
   ```
4. Do a lightweight secret scan before staging. At minimum scan changed + untracked text files for private keys, mnemonics, API-token assignments, and raw 64-hex EVM keys. Do not stage `.env`, `wallets.json`, logs, or generated `dist/`/`node_modules/` output.
5. Validate TypeScript and standalone scripts:
   ```bash
   npm run build
   node --check fast-mint.mjs
   # If present/changed:
   node --check plop-auto-mint.mjs
   ```

## Commit/push pattern

```bash
git add <reviewed files>
git commit -m "feat: harden SeaDrop fast minting"
git fetch origin
git push origin main
```

After push, verify local and remote point at the same commit:

```bash
git status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Report the short SHA, full SHA, branch, validation commands, and push range to the user. Keep the report concise.

