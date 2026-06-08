# Ethereum Private Key Validation

## Valid key format
- Exactly 32 bytes = 64 hexadecimal characters
- With `0x` prefix: 66 characters total
- Example valid: `0x` + 64 hex chars
- Example invalid (too short): `0x5adeee...af38` (62 hex chars — 2 missing, likely truncated)

## Quick validation
```bash
# Check length (should be 66 including newline = 65 visible + newline)
echo -n "0x5adeee824144234e696da848d8be00dcecf06217181a7133926b61af38" | wc -c
# → 63 (WRONG — missing 2 chars)

# Format-length check without committing a raw private-key-shaped literal
python3 - <<'PY'
key = "0x" + ("a" * 64)
print(len(key))
PY
# → 66 (CORRECT)
```

## Common truncation causes
- Terminal line wrapping cut off the end during copy-paste
- Browser input field with max-length limit
- Chat message display truncation (especially Telegram — long messages get cut)

## ethers.js error for invalid key
```
invalid private key (argument="privateKey", value="[REDACTED]", code=INVALID_ARGUMENT, version=6.x.x)
```
If you see this error from `check_wallets` or `mint_nft`, the key is malformed. Ask user to re-paste the full key.

## Multi-wallet format in .env
```
WALLET_PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
```
- Comma-separated, no spaces around commas
- Each key must be independently valid (64 hex chars + 0x)
- Runner loads each key and skips invalid ones with a warning
