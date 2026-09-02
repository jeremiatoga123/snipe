# Deployment: Hermes Agent + tool mint di VPS

Panduan memasang tool ini sebagai MCP server di [Hermes Agent](https://hermes-agent.nousresearch.com/),
supaya bisa dikendalikan lewat Telegram. Diuji di Ubuntu 22.04, 6 CPU, 15 GB RAM.

## Susunannya

```
Telegram bot
      │  long-poll
      ▼
Hermes Agent                  systemd user service: hermes-gateway
  /usr/local/lib/hermes-agent   linger=yes (hidup terus walau logout)
  config: ~/.hermes/config.yaml
  secrets: ~/.hermes/.env (chmod 600)
      │
      ├─ model: bebas, lewat endpoint OpenAI-compatible
      │
      └─ MCP stdio: node /opt/mintopensea/mcp-server.mjs
           9 tool: status, set_rpc, set_pk, list_wallets, remove_wallets,
                   mint_plan, mint_now, mint_snipe, list_drops
```

## 1. Pasang Hermes

```bash
apt-get update && apt-get install -y curl git ripgrep ffmpeg build-essential
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o install.sh
less install.sh          # baca dulu sebelum dijalankan
bash install.sh
```

Sebagai root, Hermes masuk ke `/usr/local/lib/hermes-agent`, config di `/root/.hermes/`.
Installer ikut menarik uv, Python 3.11, dan Node.js.

## 2. Arahkan ke model pilihanmu

Endpoint OpenAI-compatible mana pun bisa. Contoh untuk gateway kustom:

```bash
# simpan kunci di ~/.hermes/.env
echo 'MY_API_KEY=xxx' >> ~/.hermes/.env && chmod 600 ~/.hermes/.env

hermes config set providers.custom.base_url 'https://gateway-kamu.example/v1' --force
hermes config set providers.custom.api_mode chat_completions --force
hermes config set providers.custom.model nama-model --force
hermes config set providers.custom.api_key '${MY_API_KEY}' --force
hermes config set model.provider custom --force
hermes config set model.default nama-model --force
hermes config unset model.base_url        # buang sisa base_url bawaan
hermes -z "tes: berapa 17*23?"            # harus menjawab 391
```

Model **wajib mendukung tool calling**. Uji dulu dengan satu permintaan
chat completion berisi definisi `tools` — kalau balasannya tidak pernah
`finish_reason: "tool_calls"`, Hermes tidak akan bisa memakai tool apa pun.

## 3. Pasang tool mint

```bash
git clone https://github.com/jeremiatoga123/snipe.git /opt/mintopensea
cd /opt/mintopensea && npm install --omit=dev
chmod 700 /opt/mintopensea
: > .env && chmod 600 .env
node src/index.js help    # smoke test
```

## 4. Daftarkan sebagai MCP server

```bash
printf 'y\n' | hermes mcp add mintopensea \
  --env MAX_SPEND_ETH=0.05 --connect-timeout 60 \
  --command /usr/local/bin/node --args /opt/mintopensea/mcp-server.mjs
hermes mcp list
```

## 5. Gateway Telegram

Nama env var diambil dari sumber Hermes, bukan dokumentasi online
(beberapa halamannya 404):

```bash
# di ~/.hermes/.env
TELEGRAM_BOT_TOKEN=<token dari @BotFather>
TELEGRAM_ALLOWED_USERS=          # KOSONGKAN - lihat catatan keamanan
TELEGRAM_ALLOW_ALL_USERS=false
```

```bash
printf 'y\n' | hermes gateway install
hermes gateway status
```

Kirim pesan ke bot, lalu setujui kode pairing yang muncul:

```bash
hermes pairing list
hermes pairing approve telegram <KODE>
```

## Keamanan

| Lapis | Isi |
|---|---|
| Akses bot | `TELEGRAM_ALLOWED_USERS` **dikosongkan** → user baru wajib DM pairing dan disetujui manual. Ini bukan berarti terbuka; justru sebaliknya |
| Private key | `set_pk` hanya mengembalikan alamat, tidak pernah kuncinya. Disimpan `keys.txt` chmod 600 |
| Belanja | `mint_now` / `mint_snipe` wajib `confirm_token` dari `mint_plan` — sekali pakai, terikat kontrak dan chain. `MAX_SPEND_ETH` batas keras |
| Panggilan ganda | Kunci per kontrak menolak operasi mint kedua selagi yang pertama berjalan |
| Idempotensi | Sebelum menembak ulang, jumlah mint on-chain dibandingkan dengan catatan saat plan |
| Snipe panjang | `max_wait_sec` default 900 — drop yang bukanya masih lama ditolak, disuruh pakai cron |

**Bot Telegram itu publik.** Siapa pun yang menemukan username-nya bisa
mengirim pesan. Kunci ke satu user ID, dan pakai wallet khusus mint yang
isinya secukupnya — chat Telegram biasa tidak end-to-end encrypted, jadi
private key yang dikirim lewat chat tersimpan di server Telegram.

## Browser & web

Hermes butuh CLI `agent-browser` + Chrome:

```bash
npm install -g agent-browser && agent-browser install --with-deps
```

Yang perlu diperhatikan: Hermes secara **default** memakai mode Browser Use,
yang menyambung lewat CDP ke Chrome yang **sudah berjalan**. Di VPS headless
tidak ada Chrome yang berjalan, jadi `browser_exec` selalu gagal. Set:

```bash
hermes config set browser.backend off
```

Setelah itu `browser_navigate` jalan normal, termasuk di halaman berat
JavaScript seperti OpenSea. Di `hermes doctor`, `browser-cdp` dan `browser-use`
tetap ⚠ — itu wajar, keduanya memang tidak dipakai. Yang penting `browser` ✓.

Web search dan web extract memakai provider bawaan Nous, tanpa API key tambahan.

## Operasional

```bash
hermes gateway status                       # service hidup?
hermes gateway restart                      # WAJIB setelah update kode -
                                            # Node memuat modul saat import
tail -f ~/.hermes/logs/gateway.log
tail -f ~/.hermes/logs/mcp-stderr.log
hermes pairing list                         # siapa yang punya akses
hermes pairing revoke telegram <user_id>
hermes mcp list
hermes -z "..."                             # tes tanpa Telegram
```

Ganti batas belanja:

```bash
hermes config set mcp_servers.mintopensea.env.MAX_SPEND_ETH 0.2
hermes gateway restart
```

Update tool:

```bash
cd /opt/mintopensea && git pull && npm install --omit=dev
hermes gateway restart
```

## Catatan

- `hermes model` dan `hermes gateway setup` sepenuhnya interaktif. Untuk
  otomatisasi pakai `hermes config set` dan tulis langsung ke `~/.hermes/.env`.
- Setelah mengubah kode tool, **restart gateway**. File di disk berubah tidak
  otomatis termuat oleh proses MCP yang sedang jalan.
