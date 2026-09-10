# Catatan bug

Ditemukan lewat audit kode 1–2 September 2026, setelah tiga bug lolos ke produksi
lebih dulu. Diurutkan dari yang paling merugikan.

Yang sudah lolos ke produksi lebih dulu tercatat di bagian **Riwayat** di bawah.

---

## Prioritas 1 — bisa menghabiskan uang

### B1. Pagar anti dobel-mint di gelombang susulan adalah kode mati
`src/sniper.js` — gelombang susulan

`collect()` tidak pernah menyetel `pending`; hanya `sendMint()` di `mint.js` yang
melakukannya. Jadi cabang `results.filter(r => r.pending)` tidak pernah berisi
apa pun, dan tx yang sudah tersiar tapi receipt-nya telat tetap dianggap gagal.
Gelombang berikutnya menandatangani ulang dengan `getNonce('pending')` yang sudah
maju, lalu menembak lagi.

**Akibat:** dobel mint — persis penyakit yang membuat wallet ter-mint 4×.

**Ironi:** komentar di atas kode itu mengklaim mencegahnya. Ditulis oleh saya,
beberapa menit sebelum audit menemukannya.

### B2. Offset batas detik negatif membungkus jadi ~990 ms
`src/sniper.js` — `boundarySample()`

```js
offset = ((offset % 1000) + 1000) % 1000;
```

Kalau offset sebenarnya sedikit negatif (mis. −8 ms karena jitter jam), hasilnya
jadi 992 ms. `computeFireAt` lalu menembak **satu detik penuh terlambat**.

**Akibat:** kalah total, bukan sekadar lambat. Ini persis risiko yang diperingatkan
riset paralel: meleset satu detik jauh lebih mahal daripada 300 ms yang dikejar.

### B3. RPC chain lain dipakai diam-diam untuk chain yang diminta
`src/chains.js` — `resolveChain()`

RPC non-Alchemy dari user dipertahankan di indeks 0 untuk chain **apa pun**.
Digabung `staticNetwork:true` dan chainId preset di `makeProvider`, memanggil
`mint_plan({chain:'base'})` bisa membaca state Robinhood tapi dilabeli Base.
`set_rpc` juga tidak pernah memvalidasi chainId.

**Akibat:** keputusan mint diambil dari data chain yang salah.

### B4. Tiket konfirmasi tidak mencatat chain
`mcp-server.mjs` — `issueTicket` / `redeemTicket`

Tiket dari `mint_plan` di satu chain bisa ditukar untuk mint di chain lain.
`guardSpend`/`MAX_SPEND_ETH` lalu dievaluasi terhadap harga chain yang keliru.

### B5. Cek saldo hanya untuk satu tx, padahal yang ditandatangani sebanyak `txPerWallet`
`src/sniper.js` — `preflight()`

`needed = gasLimit*maxFee + plan.value` dihitung untuk satu transaksi, tapi
sampai 10 tx disiapkan dan ditembakkan.

**Akibat:** wallet yang hanya cukup untuk satu mint dinyatakan siap untuk sepuluh.

### B6. Celah nonce menyandera seluruh tx berikutnya
`src/mint.js` — `runMint()`

`nonce++` tetap jalan walau `sendMint` tidak pernah menyiarkan apa pun (simulasi
gagal, saldo kurang). Nonce berikutnya jadi meloncat.

**Akibat:** semua tx setelahnya menggantung di mempool selamanya.

---

## Prioritas 2 — menggagalkan operasi

### B7. `planFor` bisa mengembalikan null lalu TypeError
`mcp-server.mjs` — `mint_now`

Jendela SeaDrop bisa tertutup antara probe dan panggilan per-wallet. `sendMint`
lalu membaca `plan.to` dari `null`. `src/index.js` menjaga ini dengan `?? plan`;
call site di MCP tidak.

### B8. `max_wait_sec` mengabaikan override `at`
`mcp-server.mjs` — `mint_snipe`

Penjaga hanya membaca `startTime` on-chain dan dilewati sepenuhnya untuk kontrak
non-SeaDrop. `at` yang berjarak berjam-jam membuat tool menggantung.

### B9. Gelombang susulan memakai fee yang dibekukan saat arm
`src/sniper.js`

Nonce disegarkan, fee tidak. Gelombang yang ditolak karena fee terlalu rendah
akan diulang dengan fee sama persis sampai jendela habis.

### B10. Override saldo probe dipaku 1 ETH
`src/seadrop.js` — `probePublicMint()`

Drop berharga ≥1 ETH gagal karena dana, `raw` jadi null, dan drop yang sebenarnya
bisa di-mint dilaporkan `unknown`.

### B11. `results.concat(rechecked)` menggandakan hitungan
`src/sniper.js`

Menambahkan salinan alih-alih mengganti, jadi jumlah tx dan kegagalan di
`mint_snipe` dan `printResults` dihitung dua kali.

---

## Kebersihan (bukan bug)

- `conditionalSpray` dan `supportsConditional` sekarang dipakai lewat
  `fireWaveOne`, tapi hanya kalau `--conditional` diberikan. Default-nya polos,
  karena jalur bersyarat terbukti ~600 ms lebih lambat di sequencer Robinhood
  (lihat H7).
- `preflight` diimpor di `mcp-server.mjs` tapi tidak dipakai.
- `writeEnvVar` membuang semua komentar dan baris kosong di `.env` saat menulis ulang.

---

## Riwayat — bug yang sempat lolos ke produksi

### H1. `signatureGated` ditebak dari keberadaan signer
Setiap drop yang belum buka dicap butuh tanda tangan, karena OpenSea mendaftarkan
signer di hampir semua drop Studio. Agent menolak dua drop yang sebenarnya bisa
di-snipe. **Diganti** dengan simulasi `mintPublic` sungguhan yang membaca jenis
revert (`NotActive` = cuma soal jam).

### H2. `mint_plan` tidak menerbitkan token untuk drop terjadwal
`makePlan` dipanggil tanpa `ignoreSchedule`, jadi drop yang belum buka mendapat
`confirm_token: null` — dan `mint_snipe` menolak jalan tanpa token. Kasus yang
paling butuh sniper justru satu-satunya yang terkunci.

### H3. Tiket konfirmasi bisa dipakai berulang
`redeemTicket` tidak pernah menghapus tiket. Model memanggil `mint_snipe` 3× lalu
`mint_now` 1× dengan token yang sama → wallet ter-mint 4× padahal user minta 1.
Rugi ~0,00047 ETH. **Diperbaiki:** tiket sekali pakai, kunci per kontrak, pagar
idempotensi.

### H4. Pemanasan koneksi justru memperlambat 1,1 detik
Dijadwalkan 1,5 detik sebelum tembak dan berjalan berurutan; memanaskan sequencer
saja butuh 0,9 detik, jadi jatuh temponya terlewat. **Diperbaiki:** paralel,
bertenggat, dimulai di T−6 detik.

---

## Pelajaran

Empat dari lima bug yang sampai ke produksi punya bentuk yang sama: **kode yang
menembak ulang tanpa memastikan tembakan pertama gagal.** Setiap kali muncul di
tempat baru — `sendMint`, tiket MCP, gelombang susulan sniper.

Aturan untuk perubahan berikutnya: apa pun yang bisa mengirim transaksi kedua
harus lebih dulu membaca keadaan on-chain, bukan mengandalkan variabel di memori.

### H5. Handler `resync` di CLI membaca field yang tidak pernah dikirim
`src/index.js` — `cmdSnipe`

`log.info(\`resync jam, offset ${e.offsetMs.toFixed(0)}ms\`)`, padahal event
`resync` sudah lama memancarkan `boundaryOffsetMs`, bukan `offsetMs`.
`undefined.toFixed` melempar TypeError di dalam `onEvent`, yang merambat keluar
dari `snipe()`.

**Akibat:** setiap snipe dengan waktu tunggu lebih dari 20 detik crash tepat di
T−15 detik. Tidak pernah terpicu karena semua dry-run kebetulan menunggu kurang
dari 20 detik. Ditemukan 10 September saat membaca ulang handler-nya.

### H6. Kompensasi latensi memakai besaran yang salah, dua kali
`src/sniper.js` — `computeFireAt` / `firstSendAt`

Versi pertama mengurangi setengah RTT ke **Alchemy** (7 ms dari VPS Singapura),
padahal transaksinya terbang ke sequencer di Ohio. Versi kedua mengurangi
setengah RTT ke **sequencer** (117 ms). Dua-duanya salah besaran: yang harus
dikompensasi adalah waktu dari kirim sampai *diterima* sequencer, dan itu
diukur ~430 ms lewat Alchemy, ~630 ms lewat jalur langsung — ada ~500 ms proses
ingest di luar jaringan.

Diukur dengan transaksi sungguhan dari wallet debu, 10 September 2026:

| Kompensasi | Mendarat |
|---|---|
| 3,5 ms (RTT Alchemy/2) | blok ke-5 |
| 117 ms (RTT sequencer/2), jalur langsung | blok ke-8 |
| 117 ms, lewat Alchemy | blok ke-5 |
| **300 ms, Alchemy + langsung** | **blok ke-2 dan ke-3** |

**Akibat sebelum diperbaiki:** setiap snipe mendarat ~300 ms lebih lambat dari
yang bisa dicapai. **Sekarang:** `deliveryMs` per chain di `chains.js`.

### H7. Jalur bersyarat diasumsikan gratis dan cepat
Riset menyimpulkan `eth_sendRawTransactionConditional` menolak tembakan yang
kepagian secara gratis, jadi bisa disemprot agresif. Benar untuk syarat yang jauh
(+3 detik ditolak seketika), **salah** untuk syarat yang dekat: tembakan
kepagian *ditahan* dan baru diproses ~+800 ms, dan siblingnya ditolak sebagai
duplikat. Uji dengan target sesudah batas detik pun tetap +800 ms, karena
endpoint langsung memang lambat menerima tx apa pun. Sekarang opt-in.

---

## Pelajaran tambahan

Tiga bug di atas punya akar yang sama: **mengukur hal yang mudah diukur, lalu
mengira itu hal yang penting.** RTT `poke` ke sequencer mudah diukur dan
stabil, tapi bukan waktu yang dialami transaksi sungguhan. Satu-satunya
pengukuran yang sah untuk sniper adalah transaksi sungguhan yang dicatat blok
pendaratannya, dan itu murah: 21.000 gas, ~$0,02.
