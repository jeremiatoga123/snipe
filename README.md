# mintopensea

Tool mint NFT **langsung lewat smart contract**, tanpa lewat UI OpenSea.
Default-nya Robinhood Chain (chainId 4663), tapi jalan di chain EVM mana pun.

Dibuat untuk kasus: *"kalau mintnya nggak habis, saya mint sendiri lewat contract."*

## Kenapa nggak bisa asal panggil `mint()`

Drop OpenSea (termasuk koleksi di Robinhood Chain) pakai **SeaDrop**.
Kontrak NFT-nya sendiri **tidak punya fungsi mint publik** — yang ada cuma
`mintSeaDrop(address,uint256)` yang hanya boleh dipanggil kontrak SeaDrop.

Jadi mint yang benar adalah:

```
kamu -> SeaDrop (0x00005EA00Ac477B1030CE78506496e8C2dE24bf5)
         .mintPublic(nftContract, feeRecipient, minterIfNotPayer, quantity)
```

Tool ini mendeteksi pola itu otomatis, baca konfigurasi drop-nya
(harga, jadwal, limit per wallet, fee recipient), lalu menyusun tx yang benar.

## Setup

```bash
npm install
cp .env.example .env      # isi RPC_URL
cp keys.txt.example keys.txt   # isi private key, satu per baris
```

`.env`:

```
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/xxx
```

`keys.txt` dan `.env` sudah masuk `.gitignore`.

## Perintah

```bash
node src/index.js info    --contract 0x...     # scan kontrak + simulasi mint
node src/index.js mint    --contract 0x...     # eksekusi mint
node src/index.js watch   --contract 0x...     # tunggu sampai mint buka, lalu auto-fire
node src/index.js snipe   --contract 0x...     # siapkan tx di depan, tembak pas detik buka
node src/index.js drops                        # cari drop yang lagi AKTIF di chain ini
node src/index.js sigs    --contract 0x...     # bongkar semua fungsi di bytecode
node src/index.js balance                      # cek saldo semua wallet
node src/index.js resolve <slug-opensea>       # slug OpenSea -> alamat kontrak
```

### `info` — selalu jalankan ini dulu

Membaca dari on-chain: nama, standar (ERC721/1155), supply, harga,
status sale, proxy/implementation, konfigurasi SeaDrop atau thirdweb,
lalu **mensimulasikan mint** dan melaporkan rencana tx yang akan dikirim.

```
>> Profil kontrak
   alamat        : 0x7e646BCceC7df36Ab9e6AF146794b1f38BA8686b
   implementation: 0x09a26fC8FCEF18192E267D7A6da9dFb4be81Dd6A (proxy)
   nama / simbol : Loopkins / LOOP
   standar       : ERC721
   supply        : 358 / 10000
   OpenSea SeaDrop @ 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5
     status      : public drop AKTIF
     harga/item  : 0.0 ETH
     window      : 2026-08-30T04:43:58.000Z s/d 2027-08-30T04:43:58.000Z
     limit/wallet: 5
     fee         : 10% -> 0x0000a26b00c1F0DF003000390027140000fAa719

>> Simulasi mint dari 0xD2AE..31fB (qty 1)
OK Rencana mint: SeaDrop mintPublic qty 1 @ 0.0 /item
```

### `drops` — cari mint yang lagi buka

Scan event `PublicDropUpdated` di kontrak SeaDrop, lalu cek satu per satu
mana yang window-nya aktif sekarang. Hasil scan di-cache di `.cache/`.

```bash
node src/index.js drops --free --limit 20      # cuma yang gratis
node src/index.js drops --blocks 500000        # scan lebih pendek (lebih cepat)
```

## Sniper: tembak pas detik pembukaan

```bash
node src/index.js snipe --contract 0x... --qty 1
```

Semua pekerjaan berat dikerjakan **sebelum** mint buka: scan kontrak, susun
calldata, estimasi gas, ambil nonce, dan tanda tangan tx. Saat detik pembukaan
tiba yang tersisa cuma satu `eth_sendRawTransaction`.

Jam mesin disinkronkan ke timestamp blok, bukan jam OS — di mesin ini jam Windows
tertinggal ~900 ms dari chain, cukup untuk membuat tembakan meleset. Tidur
presisinya meleset 0.00 ms dari target (`setTimeout` polos meleset ~5 ms).

Kalau jadwalnya tidak ada di chain, pakai `--at`, atau biarkan kosong dan tool
akan polling simulasi lalu menembak pada yang pertama lolos.

Untuk dipakai AI agent, lihat [AGENT.md](AGENT.md) — ada entrypoint terpisah
`agent-mint.mjs` yang keluarannya JSON.

## Tiga mode mint

**1. Auto (default).** Tool mendeteksi sendiri:

- Pola SeaDrop → `mintPublic` ke kontrak SeaDrop.
- thirdweb drop → baca claim condition aktif, panggil `claim(...)`.
- Kontrak biasa → scan selector di bytecode, cocokkan dengan katalog
  (`mint`, `publicMint`, `purchase`, `claim`, dst), lalu **simulasi tiap
  kandidat dengan beberapa kemungkinan harga** dan pakai yang lolos.

**2. Signature manual** — kalau kamu sudah tahu fungsinya:

```bash
node src/index.js mint --contract 0x... --sig "mint(uint256)" --qty 3 --value 0.01
```

**3. Raw calldata** — paling ampuh, buat kontrak aneh atau mint yang
butuh tanda tangan server (`mintSigned`). Buka tx mint orang lain yang
sukses di explorer, copy `Input Data`-nya:

```bash
node src/index.js mint --mode raw --data 0x161ac21f0000... --value 0.005 --contract 0x...
```

## Flag penting

| Flag | Guna |
|---|---|
| `--qty <n>` | jumlah NFT per tx |
| `--txPerWallet <n>` | berapa tx per wallet |
| `--maxFeeGwei <n>` | patok gas manual (dompet tipis → turunkan ini) |
| `--gasLimitMultiplier <n>` | pengali gas limit dari hasil estimasi (default 1.3) |
| `--retries <n>` | percobaan ulang per tx (default 3) |
| `--chain <nama>` | `robinhood`, `base`, `ethereum`, `arbitrum`, ... |
| `--rpc <url>` | RPC custom |

Semua flag juga bisa ditaruh permanen di `config.json`.

## Cara kerja deteksi

- **Bytecode selector scan** — jalan-jalan opcode, ambil semua operand
  `PUSH4`. Ini isi dispatch table Solidity, jadi ketahuan persis fungsi apa
  saja yang ada tanpa perlu ABI dari explorer.
- **Proxy resolution** — EIP-1167 (minimal proxy / clone, alamat impl
  ditanam di bytecode), EIP-1967, EIP-1822, dan beacon.
- **Simulasi sebelum kirim** — setiap tx di-`eth_call` dulu. Kalau revert,
  tool tidak membakar gas dan menampilkan alasan revert-nya.
- **Pre-flight saldo** — dicek `gasLimit x maxFee + harga` vs saldo, dan
  dilaporkan angkanya kalau kurang.
- **`sigs` + 4byte.directory** — buat kontrak yang benar-benar tidak dikenal,
  semua selector diterjemahkan jadi signature.

## Keamanan

- Private key hanya dibaca dari `keys.txt` / `.env`, tidak pernah dikirim
  ke mana pun. Yang keluar cuma tx yang sudah ditandatangani lokal.
- `.env`, `keys.txt`, dan `.cache/` sudah di-`.gitignore`.
- Kalau sebuah drop pakai `mintSigned`, tanda tangannya keluar dari server
  OpenSea — tool tidak bisa memalsukannya. Untuk kasus itu pakai mode raw.

## Catatan soal koleksi Rexcon

Koleksi `rexcon-robinhood` window mint publiknya **19–21 Agustus 2026**
dan sudah lewat, dengan 0 dari 2.222 item ter-mint. Selama window-nya
belum dibuka ulang oleh kreator, tidak ada jalan mint — lewat UI maupun
lewat contract. Pantau dengan:

```bash
node src/index.js watch --contract <alamat-kontrak-rexcon>
```

Begitu kreator membuka lagi public drop-nya, tool langsung menembak.
