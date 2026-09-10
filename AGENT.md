# Panduan untuk AI Agent

Entrypoint: **`agent-mint.mjs`**. Dibuat khusus supaya bisa dijalankan agent tanpa
pengawasan manusia.

- **stdout hanya satu baris JSON.** Semua log manusia dibuang ke stderr.
- **Tidak pernah interaktif.** Tidak ada prompt, tidak ada tunggu input.
- **Exit code:** `0` sukses · `1` mint gagal · `2` salah konfigurasi.
- **Bentuk output tetap** per action, jadi aman diparse.

```bash
node agent-mint.mjs <action> [flags]
```

## Alur yang disarankan

```
drops  ->  plan  ->  arm  ->  snipe
 cari     periksa   pastikan   tembak pas
 target   kelayakan  siap      detik buka
```

## Action

### `plan` — periksa dulu, tidak mengirim apa pun

Aman dipanggil kapan saja. Ini yang harus dijalankan agent sebelum memutuskan.

```bash
node agent-mint.mjs plan --contract 0x7e646BCceC7df36Ab9e6AF146794b1f38BA8686b
```

```json
{
  "ok": true, "action": "plan",
  "contract": "0x7e646...", "name": "Loopkins", "standard": "ERC721",
  "supply": { "current": "378", "max": "10000" },
  "alreadyMintedByWallet": "1",
  "drop": {
    "type": "seadrop", "open": true, "status": "public drop AKTIF",
    "mintPriceEth": "0.0", "startTime": 1788065038, "endTime": 1819601038,
    "startsInSec": null, "maxPerWallet": 5,
    "publicMintProbe": "mintable_now", "snipeable": true
  },
  "mintable": true,
  "plan": { "to": "0x00005EA0...", "valueEth": "0.0", "data": "0x161ac21f...", "how": "SeaDrop mintPublic qty 1" }
}
```

Yang perlu dibaca agent:

| Field | Artinya |
|---|---|
| `mintable` | `true` → bisa langsung `now` |
| `drop.open` | `false` + `startsInSec` ada → pakai `snipe` |
| `drop.publicMintProbe` | `mintable_now` → `now`. `not_open_yet` → `snipe`. `signature_required` → tidak bisa mandiri. `window_ended` → sudah lewat |
| `drop.snipeable` | hasil simulasi `mintPublic`, bukan tebakan dari ada/tidaknya signer |
| `alreadyMintedByWallet` vs `drop.maxPerWallet` | sudah kena limit atau belum |
| `supply.current` vs `supply.max` | sudah sold out atau belum |

### `arm` — pastikan siap tembak, tetap tidak mengirim

Menyusun calldata, estimasi gas, cek saldo tiap wallet, **menandatangani tx**,
dan mengukur selisih jam. Gagal di sini berarti `snipe` juga akan gagal.

```bash
node agent-mint.mjs arm --contract 0x... --qty 1
```

```json
{
  "ok": true, "action": "arm",
  "gasLimit": "151716", "maxFeeGwei": "0.7", "signedTxCount": 1,
  "walletsArmed": [{ "wallet": "0xD2AE...", "nonce": 3, "balanceEth": "0.0005", "neededEth": "0.000089" }],
  "walletsSkipped": [],
  "openAt": "2026-09-15T12:00:00.000Z", "scheduleSource": "SeaDrop publicDrop.startTime",
  "clockOffsetMs": -928
}
```

`walletsSkipped` berisi wallet yang saldonya kurang, lengkap dengan angkanya.

### `snipe` — tunggu jadwal buka, lalu tembak

Ini action utamanya.

```bash
node agent-mint.mjs snipe --contract 0x... --qty 1
```

Prosesnya:

1. **Preflight** — scan kontrak, susun calldata, estimasi gas, ambil nonce,
   **tandatangani semua tx di depan**.
2. **Sinkron jam** — ukur selisih jam mesin terhadap timestamp blok.
3. **Tunggu** — tidur sampai ~30 detik sebelum buka, ukur ulang batas detik dan
   latensi, panaskan koneksi di T−6 dan T−0,9 detik, lalu tidur presisi
   (busy-wait 20 ms terakhir).
4. **Tembak** — broadcast semua tx yang sudah ditandatangani serentak ke
   semua RPC. Yang tersisa saat detik pembukaan hanya satu `eth_sendRawTransaction`.
5. **Susulan** — kalau semua gagal, tanda tangan ulang dengan nonce terbaru dan
   coba lagi selama `retryWindowMs`.

Kalau jadwalnya tidak ada di chain (bukan SeaDrop, dan `--at` tidak diisi),
`snipe` otomatis pindah ke polling simulasi tiap `pollIntervalMs` dan menembak
pada simulasi pertama yang lolos.

### `now` — mint sekarang juga

Untuk drop yang **sudah** buka. Tidak menunggu apa pun.

```bash
node agent-mint.mjs now --contract 0x... --qty 2
```

### `drops` — cari target

```bash
node agent-mint.mjs drops --free --limit 20
```

```json
{
  "ok": true, "action": "drops", "scanned": 1483,
  "liveCount": 112, "upcomingCount": 186,
  "live": [{ "contract": "0x7e64...", "name": "Loopkins", "priceEth": "0.0", "free": true,
             "maxPerWallet": 5, "supply": "378", "maxSupply": "10000", "soldOut": false }],
  "upcoming": [{ "contract": "0xacbB...", "startTime": 1788269400, "priceEth": "0.00008" }]
}
```

Scan pertama agak lama (~1-2 menit); hasilnya di-cache di `.cache/`, scan
berikutnya hanya mengambil blok baru.

## Flag

| Flag | Default | Guna |
|---|---|---|
| `--contract 0x...` | — | wajib kecuali action `drops` |
| `--qty <n>` | 1 | jumlah NFT per tx |
| `--txPerWallet <n>` | 1 | jumlah tx per wallet |
| `--wallets <file>` | `keys.txt` | file private key |
| `--at <iso\|unix>` | — | paksa waktu buka kalau tidak ada di chain |
| `--leadMs <n>` | 0 | geser tembakan; negatif = lebih awal |
| `--retryWindowMs <n>` | 20000 | lama mencoba lagi kalau gelombang pertama gagal |
| `--pollIntervalMs <n>` | 250 | jarak polling kalau jadwal tidak diketahui |
| `--maxFeeGwei <n>` | otomatis | patok gas manual |
| `--gasLimitMultiplier <n>` | 1.4 | pengali gas limit dari estimasi |
| `--dry` | off | rehearsal: jalan sampai fase tembak tanpa broadcast |
| `--chain <nama>` | `robinhood` | `base`, `ethereum`, `arbitrum`, ... |
| `--rpc <url>` | dari `.env` | RPC custom |

Semua juga bisa lewat env: `AGENT_CONTRACT`, `AGENT_QTY`, `AGENT_KEYS`,
`AGENT_AT`, `AGENT_CHAIN`, `AGENT_MAX_FEE_GWEI`, `RPC_URL`.

## Soal waktu

Kontrak membandingkan `startTime` dengan `block.timestamp`, yang di chain ini
**dibulatkan ke detik penuh** padahal bloknya 0,1 detik. Itu jebakannya.

Versi pertama menghitung waktu chain dari `block.timestamp` dan mengambil `min`
dari beberapa sampel agar aman. Hasil pengukuran di VPS: sebarannya **865 ms**
(min 500, median 958) — jadi tembakan selalu terlambat sekitar satu detik penuh.
Itulah penyebab mint pertama mendarat di +1,22 detik, bukan latensi jaringan.

Cara sekarang, tiga besaran diukur langsung:

| Besaran | Fungsi | Nilai terukur di VPS |
|---|---|---|
| Jam mesin | referensi waktu (NTP aktif) | tersinkron |
| `measureSecondBoundary` | kapan chain benar-benar masuk detik baru | **~300 ms** setelah detik UTC bulat |
| `measureRpcLatency` | RTT baca ke RPC (untuk deteksi batas detik) | **6–28 ms** |
| `measureSequencerLatency` | RTT jaringan ke endpoint sequencer | **235 ms** (Singapura) |
| `deliveryMs` | kirim → diterima sequencer, diukur dengan tx sungguhan | **~430 ms** via Alchemy; dipatok 300 |

```
tiba   = startTime*1000 + batasDetik + safetyMs + leadMs
kirim  = tiba - deliveryMs          (deliveryMs Robinhood: 300, di chains.js)
```

`deliveryMs` adalah waktu dari **kirim sampai sequencer menerima**, bukan RTT
jaringan. Ini pelajaran mahal: RTT jaringan ke sequencer 235 ms, tapi transaksi
sungguhan baru di-ack 750 ms lewat jalur langsung dan ~430 ms lewat Alchemy.
Selisihnya adalah waktu proses ingest sequencer, dan tidak bisa dipangkas dengan
VPS yang lebih dekat.

Waktu tembak dihitung ulang ~30 detik sebelum buka, karena besaran-besaran itu
bisa bergeser selama menunggu berjam-jam. Kalau RPC gagal, batas detik diambil
dari feed sequencer sebagai cadangan.

**Batas detik diambil dari MEDIAN beberapa sampel, bukan minimum.** Tiap sampel
bernilai `batas_sebenarnya + fase_blok` (0–102 ms), jadi minimum terlihat menarik
secara teori — tapi terbukti salah di lapangan: menembak berdasarkan minimum
(+294 ms) membuat tx tiba sebelum chain masuk detik target, artinya revert.
Median (+302 ms) lolos.

`safetyMs` (default 40) mengatur condongnya. Menaikkannya = lebih aman tapi lebih
lambat. `deliveryMs` (default 300 untuk Robinhood) menentukan seberapa awal
tembakan dilepas; dengan nilai itu tx mendarat di blok ke-2/ke-3 detik target
tanpa kepagian. Menaikkannya ke ~400 mengejar blok pertama, tapi jitter
pengiriman ±100 ms membuat sebagian tembakan tiba sebelum detik target dan
revert.

Terverifikasi di VPS, tiga percobaan berturut-turut: bangun meleset **0,2 ms**,
dan pada saat itu blok berstempel detik target sudah ada — jadi tx valid, bukan
revert. Lantai kerasnya adalah batas detik sequencer ~300 ms; RPC secepat apa pun
tidak bisa menembusnya.

### Koneksi dingin — biaya tersembunyi terbesar

Terukur di VPS, permintaan pertama vs berikutnya:

| Endpoint | Dingin | Hangat |
|---|---|---|
| Alchemy | **490 ms** | 28 ms |
| Sequencer | **858 ms** | 224 ms |

Sniper menunggu berjam-jam, jadi koneksinya dijamin dingin tepat saat dibutuhkan.
Tanpa pemanasan, tembakan pertama menanggung DNS + TCP + TLS — jauh lebih besar
dari seluruh margin yang diperebutkan. `warmConnections()` dijalankan dua kali:
penuh di T−6 detik, sentuhan akhir di T−0,9 detik.

Pemanasan harus **paralel dan bertenggat**. Versi berurutan pertama justru
membuat tembakan telat 1,1 detik karena memanaskan sequencer sendiri butuh
~0,9 detik dan jatuh temponya terlewat.

### Endpoint submit sequencer

`https://sequencer.mainnet.chain.robinhood.com` (AWS us-east-2, Ohio) menerima
`eth_sendRawTransaction` dan **menolak semua metode baca** — khas endpoint submit
Arbitrum. Terbukti: raw tx rusak dibalas error RLP, sedangkan `eth_chainId`
dibalas "method does not exist".

`fire()` menembak ke Alchemy **dan** endpoint ini bersamaan lewat `Promise.any`.
Tx-nya identik jadi hash-nya sama — yang datang belakangan ditolak sebagai
duplikat, tidak ada risiko dobel mint.

Untuk membaca, Alchemy tetap yang terbaik: terukur **3–4 blok lebih dulu** tahu
blok baru dibanding RPC publik (yang di balik Cloudflare).

### Jalur mana yang lebih cepat: terjawab

Diukur 10 September 2026 dari VPS Singapura dengan transaksi sungguhan,
margin 40 ms, kompensasi 117 ms (RTT/2):

| Jalur | Ack | Mendarat |
|---|---|---|
| Langsung ke sequencer | **750 ms** | blok ke-8 detik itu |
| Alchemy | **426 ms** | blok ke-5 |
| Keduanya (`Promise.any`) | Alchemy menang, 488 ms | blok ke-5 |

Endpoint langsung menjawab *poke* dalam 235 ms, tapi transaksi asli baru diterima
750 ms kemudian: ada ~500 ms proses di sisi ingest. Alchemy lebih cepat.

Setelah kompensasi diganti ke `deliveryMs = 300` (kirim ~60–90 ms **sebelum**
detik bulat, lewat Alchemy + langsung): mendarat di **blok ke-2 dan ke-3**,
tidak ada yang kepagian. Itu default sekarang.

Konsekuensi untuk kolokasi: VPS di us-east-2 hanya memangkas ~230 ms
perjalanan; ~500 ms proses ingest tetap ada. Tidak sepadan.

## Contoh pemakaian dari agent

```bash
# 1. Cek dulu
OUT=$(node agent-mint.mjs plan --contract "$C")
echo "$OUT" | jq -e '.drop.snipeable' >/dev/null || exit 1

# 2. Buka -> mint sekarang. Belum buka -> snipe.
if echo "$OUT" | jq -e '.mintable' >/dev/null; then
  node agent-mint.mjs now   --contract "$C" --qty 1
else
  node agent-mint.mjs snipe --contract "$C" --qty 1
fi
```

Dari JavaScript, modulnya bisa langsung diimpor tanpa lewat CLI:

```js
import { snipe, preflight } from './src/sniper.js';
import { makePlan } from './src/plan.js';
import { scanContract } from './src/scan.js';
```

## Yang tidak bisa dilakukan

- **Drop dengan `publicMintProbe: signature_required`.** SeaDrop `mintSigned` butuh tanda tangan dari
  server OpenSea. Tidak ada cara memalsukannya. Satu-satunya jalan: ambil
  calldata dari tx yang sudah jadi dan kirim ulang lewat `--mode raw --data 0x...`
  (dan tanda tangan itu biasanya terikat pada satu alamat + salt, jadi tidak
  bisa dipakai wallet lain).
- **Allowlist dengan merkle proof.** Proof-nya harus disediakan sendiri.
- **Mendahului sequencer.** Robinhood Chain punya sequencer terpusat dengan
  urutan first-come-first-served, jadi yang menentukan adalah latensi jaringan
  ke RPC — bukan gas price. Menaikkan gas tidak mempercepat apa pun di sini.

## Transaksi bersyarat — jaring pengaman, bukan pemercepat

Robinhood Chain mendukung `eth_sendRawTransactionConditional` di endpoint
sequencer (Alchemy tidak: `-32600 Unsupported method`). Semantiknya diuji
langsung di chain:

| Syarat | Hasil | Biaya |
|---|---|---|
| `timestampMin` +1 jam | `TimestampMin condition not met` | **nol** — tanpa gas, tanpa nonce |
| `timestampMin` sudah lewat | diterima, masuk blok, status 1 | normal |
| `timestampMin` +3 detik | ditolak, **tidak** ditahan/antre | nol |

Syarat dievaluasi **saat pengiriman**, sekali. Tx yang kepagian dibuang gratis.

Konsekuensinya: `conditionalSpray()` bisa menembak berkali-kali sebelum waktunya
tanpa biaya, memakai **raw tx yang sama** (nonce sama) — jadi mustahil ter-mint
dua kali betapapun banyak tembakan yang dikirim.

**Tapi ia tidak mempercepat dari Jakarta.** Diuji: 90 tembakan mulai −400ms,
interval 12ms → diterima di tembakan ke-62, mendarat di blok ke-6 detik itu.
Sebabnya RTT 225ms (Jakarta–Ohio) lebih besar dari dua kali interval blok, jadi
waktu tiba tiap tembakan tersebar dan tidak bisa dikendalikan halus. Total biaya
90 tembakan: 0,0000066 ETH — hanya yang diterima yang berbayar.

**Diuji ulang dengan target tiba sesudah batas detik (+273 … +339 ms):** tetap
mendarat di blok ke-8 sampai ke-10, ack 795–833 ms. Jalur bersyarat memakai
ingest yang sama lambatnya dengan jalur langsung, jadi ia bukan pemercepat dan
bukan pula jaring pengaman yang murah — tembakan yang kepagian *ditahan* sampai
~+800 ms, bukan ditolak. Karena itu bersyarat sekarang **opt-in** (`--conditional`),
bukan default.
