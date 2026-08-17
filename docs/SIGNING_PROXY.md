# Signing Proxy — browser minting tanpa private key di browser

Browser minting (situs yang WAJIB Connect Wallet / server-signature) dulunya
memakai **embedded mode**: script injeksi membawa private key ke dalam memori
browser. Berbahaya — halaman jahat / XSS / penyedia browser cloud bisa
mengaksesnya.

**Signing proxy** menghilangkan risiko itu: **private key TIDAK PERNAH
meninggalkan mesin agent.** Browser hanya mendapat *relay script* berisi
(1) address wallet, (2) URL signing server, (3) token sesi. Setiap permintaan
signing diteruskan ke server lokal, DIVALIDASI ulang di sana (guard), lalu
ditandatangani dan di-broadcast.

```
                      ┌─────────────────────────── agent machine ───────────────────────────┐
 Situs mint (browser) │                                                                      │
  window.ethereum     │   relay script (tanpa key)                                          │
  (relay)             │        │                                                             │
      │               │        ▼                                                             │
      │  transport 1: │  WebSocket  ws://127.0.0.1:18545?token=…   ┌──────────────────────┐ │
      │  (browser     │        └──────────────────────────────────▶│  proxy-server.js     │ │
      │   lokal)      │                                            │  · guard server-side │ │
      │               │                                            │  · sign + broadcast  │ │
      │  transport 2: │  window.__signQ / __signR (antrian bridge) │  · RPC (Infura/dll)  │ │
      │  (Browser Use │  agent tarik request → node bridge-client  │                      │ │
      │   cloud)      │  ─────────────────────────────────────────▶│  keys di .env        │ │
      ▼               │                                            └──────────────────────┘ │
  eth_sendTransaction │                                                                      │
  dll → hasil balik   │                                                                      │
                      └──────────────────────────────────────────────────────────────────────┘
```

## Kapan dipakai

- Situs mint butuh **Connect Wallet** / **server signature** (WL/signed mint).
- Drop **bukan** hot/FCFS — untuk drop panas tetap `fast-mint.mjs`.
- Lebih aman daripada `signing:"embedded"` (legacy).

## Quick start — browser lokal (ws://127.0.0.1)

```bash
cd /root/nft-mint-agent

# 1. Start proxy (tanpa tunnel — browser lokal cukup)
node runner.mjs start_signing_proxy '{"publish":false}'

# 2. Generate relay script (mode proxy)
node runner.mjs browser_mint '{"url":"https://situs-mint.example","signing":"proxy"}'
#   → walletScripts[0].injectScript = relay (TANPA key)

# 3. Di browser: buka situs, F12 → Console, paste relay script, Enter.
#    Situs melihat window.ethereum (isMetaMask:true) dan bisa Connect.

# 4. Selesai — WAJIB stop (token langsung mati):
node runner.mjs stop_signing_proxy '{}'
```

## Quick start — Browser Use cloud (jalur bridge)

Browser cloud berjalan REMOTE — halaman webnya TIDAK bisa mencapai
`ws://127.0.0.1` mesin kamu. Relay script otomatis fallback ke **bridge**:
request ditumpuk di `window.__signQ`, agent menariknya, memproses lewat proxy
lokal, dan menulis hasil ke `window.__signR`.

```bash
node runner.mjs start_signing_proxy '{"publish":true}'   # tunnel dicoba; kalau gagal → localhost (tetap jalan via bridge)
node runner.mjs browser_mint '{"url":"<situs>","signing":"proxy"}'
# catat token: ada di data/signing_proxy.json
```

Di sesi browser (Hermes browser_exec):

```python
# 1. inject relay (dari walletScripts[0].injectScript)
js(relay_script)

# 2. loop bridge — untuk TIAP request yang masuk antrian:
q = js("window.__signQ && window.__signQ.length ? JSON.stringify(window.__signQ.shift()) : 'null'")
# → {"id":1,"method":"eth_sendTransaction","params":[...],"__addr":"0x..."}

# 3. proses via proxy lokal:
#    node bridge-client.mjs --req '<json di atas>' --token <TOKEN>
#    → {"success":true,"result":...} atau error JSON

# 4. tulis hasil balik ke halaman:
js('window.__signR[1] = {"result": "0x<txhash>"}')   # sukses
js('window.__signR[1] = {"error": {"code":-32603,"message":"..."}}')  # error
```

Alur request yang umum muncul: `eth_requestAccounts` → `eth_estimateGas`
(atau `eth_call`) → `eth_sendTransaction` → `eth_getTransactionReceipt`.
Ulangi sampai antrian kosong. Catatan: ekspresi `js()` jangan mengembalikan
Promise yang di-await harness (`void (...)` pola) — lihat Troubleshooting.

## Tools

| Tool | Fungsi |
|---|---|
| `start_signing_proxy` | Start server + (opsional) tunnel. Param: `publish` (default true), `port` (18545), `allowed_contracts`, `max_tx_value_eth`, `allow_order_signing`. |
| `stop_signing_proxy` | Stop server (+tunnel) dan revoke token. WAJIB setelah selesai. |
| `get_signing_proxy_status` | Status: running?, wsUrl, publicUrl, chain, pid. |
| `browser_mint` | Param baru: `signing:"proxy"|"embedded"`, `publish`, `allowed_contracts`, `max_tx_value_eth`, `allow_order_signing`. |

State tersimpan di `data/signing_proxy.json` (gitignored, mode 0600), log di
`data/signing_proxy.log` & `data/signing_proxy_tunnel.log`.

## Model keamanan

- **Key tidak pernah keluar dari agent.** `WALLET_PRIVATE_KEYS` hanya dibaca
  oleh `proxy-server.js` di mesin yang sama.
- **Token auth**: koneksi WS ditolak tanpa `?token=…` yang benar. Token dibuat
  acak (48 hex) per start, hilang saat `stop_signing_proxy`.
- **Guard server-side** (divalidasi ULANG sebelum sign, tidak percaya browser):
  - blocklist selector: `setApprovalForAll`, `approve`, `transfer`,
    `transferFrom`, `safeTransferFrom`, `increaseAllowance`, `permit`
  - value cap per-tx (`max_tx_value_eth`, default `MAX_MINT_PRICE_ETH`)
  - optional destination-contract allowlist (`allowed_contracts`)
  - `from` harus wallet relay (cegah wallet lain dipakai)
  - chainId harus cocok dengan CHAIN terkonfigurasi
- **Typed-data / personal_sign mati default** (`allow_order_signing:true` untuk
  menyalakan; hati-hati — bisa otorisasi transfer).
- **Batasi exposure**: kalau tunnel publik dipakai, token + guard membatasi,
  tapi stop proxy segera setelah mint. `bridge-client.mjs` hanya bisa dipakai
  dari mesin lokal (127.0.0.1).
- Semua tool tetap mengikuti aturan besar: konfirmasi harga/total sebelum TX
  paid, `MAX_MINT_PRICE_ETH`, `DRY_RUN`.

## Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| `cloudflared` tidak menghasilkan URL / tunnel 404 | Quick tunnel Cloudflare sering diblokir dari IP datacenter. Tidak masalah — bridge tetap jalan tanpa tunnel. Pakai `publish:false` + bridge. |
| `bridge-client timeout` | Token tidak dikirim (`--token`) atau proxy tidak berjalan. Cek `get_signing_proxy_status`; token di `data/signing_proxy.json`. |
| `proxy connection closed (4001 …)` | Token salah / sesi sudah di-stop. Start ulang. |
| Halaman promise menggantung (PENDING) | Pastikan hasil ditulis ke `window.__signR[<id>]` dengan id yang SAMA dari antrian, dan id bukan duplikat. |
| `js()` harness timeout | Jangan kembalikan Promise ke `js()` (harness meng-await). Pakai pola `void (window.xxx = window.ethereum.request(...).then(...))` lalu baca `window.xxx`. |
| WS mixed content (https → ws://) | Browser lokal: `ws://127.0.0.1` dikecualikan dari aturan mixed-content (loopback aman). Kalau masih diblokir, pakai tunnel (`publish:true`). |
| Port 18545 sibuk | `start_signing_proxy '{"port":18546,...}'` atau stop instance lama. |

## Embedded mode (legacy)

`signing:"embedded"` tetap tersedia (perilaku lama: key di browser). Hanya
untuk kompatibilitas; dokumen & tool menampilkan peringatan besar. Gunakan
proxy kecuali ada alasan kuat.

## Referensi terkait

- `src/browser/proxy-server.ts` — server (guard + sign + broadcast)
- `src/browser/signing.ts` — lifecycle & tunnel
- `src/browser/inject.ts` — relay script (dual transport ws/bridge)
- `bridge-client.mjs` — CLI bridge satu-request
- `tests/proxy.test.ts` — unit test guard & relay
