# Robinhood Chain (chainId 4663) — referensi operasional

Robinhood Chain adalah EVM L2 yang didukung penuh oleh OpenSea/SeaDrop
(`opensea.io/discover/chain/robinhood`). Ditambahkan ke nft-mint-agent pada
2026-08-17 setelah verifikasi on-chain.

## Fakta terverifikasi

| Item | Nilai | Bukti |
|---|---|---|
| chainId | **4663** (`0x1237`) | `eth_chainId` via GetBlock |
| Native token | ETH | — |
| Explorer | `https://robinhoodchain.blockscout.com` | — |
| SeaDrop V1 | `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` | `eth_getCode` → 42.164 byte (deployed) |
| SeaDrop V1 lama | `0x00005ea67ac36d4aa7f7be4d33385971bae75dee` | `eth_getCode` → kosong (tidak dipakai) |
| Seaport (listing) | **BELUM terdeploy** di address standar `0x00000000006c3852cbEf3e08E8dF289169EdE581` | `eth_getCode` → `0x` |
| OpenSea fee recipient | `0x0000a26b00c1F0DF003000390027140000fAa719` | konvensi SeaDrop |

Konsekuensi: **minting jalan penuh** (OpenSeaMinter, scheduler, fast-mint),
**listing belum support** (approve_seaport/list_nft akan menolak graceful
dengan "Seaport not supported on chain 4663") sampai Seaport/konduit versi
robinhood ditemukan & diverifikasi.

## RPC

| Tipe | URL |
|---|---|
| GetBlock shared (endpoint user) | `https://shared.us-east-1.getblock.io/<ID>` |
| Public | `https://rpc.mainnet.chain.robinhood.com` |
| Sequencer (send-only, cepat) | `https://sequencer.mainnet.chain.robinhood.com` |
| Alchemy host | `robinhood-mainnet.g.alchemy.com` |

## Cara pakai di nft-mint-agent

```bash
# .env — pindah ke robinhood:
CHAIN=robinhood
RPC_URL=https://shared.us-east-1.getblock.io/<ID>
# RPC_WS_URL bila perlu: (WS chain ini belum diverifikasi — fast-mint tetap
# jalan via timer kalau WS tidak ada)

# Test cepat:
node runner.mjs check_wallets '{}'
node runner.mjs get_mint_schedule '{"contract_address":"0x..."}'

# fast-mint (L2 → RBF lebih cepat):
node fast-mint.mjs --contract 0x... --time auto --qty max --wallets 0 \
  --gas-mode aggressive --priority-gwei 0.5 --max-fee-gwei 5 \
  --rbf-after-ms 3000 --rbf-max 4 \
  --broadcast-rpcs "https://rpc.mainnet.chain.robinhood.com,https://sequencer.mainnet.chain.robinhood.com"
```

Tips:
- Chain baru → tip cukup rendah (L2 murah); `--priority-gwei` 0.1–1 biasanya
  sudah masuk blok; naikkan kalau drop ramai.
- `--rbf-after-ms` ~3000 (blok cepat), bukan 13000 seperti Ethereum.
- `MAX_MINT_PRICE_ETH` tetap berlaku; konfirmasi harga on-chain via
  `getPublicDrop()` menang atas UI/API OpenSea (pelajaran PLOP).

## Kode yang menyentuh chain ini

- `src/config/index.ts` → `CHAIN_IDS.robinhood = 4663`
- `src/mint/opensea.ts`, `src/scheduler/index.ts`, `fast-mint.mjs` →
  `SEADROP_CANDIDATES[4663]`
- `fast-mint.mjs` → `EXPLORERS[4663]`
- `README.md`, `SKILL.md`, `.env.example` → daftar chain

## Referensi luar

- Repo `morsyxbt/nft-public-mint` (ter-clone di `/root/nft-public-mint`) —
  `src/chains.ts` berisi profil robinhood (RPC publik + explorer).
