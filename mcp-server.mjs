#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { resolveChain } from './src/chains.js';
import { scanContract } from './src/scan.js';
import { makePlan } from './src/plan.js';
import { loadWallets } from './src/wallets.js';
import { runMint } from './src/mint.js';
import { snipe, preflight } from './src/sniper.js';
import { readMintStats, publicDropStatus, probePublicMint } from './src/seadrop.js';
import { collectDropContracts, checkDrops } from './src/drops.js';
import { setLogSink, toJSON } from './src/util.js';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
const KEYS_FILE = path.join(ROOT, 'keys.txt');

setLogSink((...a) => console.error(...a));

const MAX_SPEND_ETH = Number(process.env.MAX_SPEND_ETH ?? '0.05');

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnvVar(key, value) {
  const env = readEnvFile();
  env[key] = value;
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch {}
  process.env[key] = value;
}

function currentChain(chainName) {
  const env = readEnvFile();
  const cfg = { chain: chainName ?? env.CHAIN ?? 'robinhood' };
  const rpc = process.env.RPC_URL ?? env.RPC_URL;
  if (rpc) cfg.rpc = [rpc];
  return resolveChain(cfg);
}

function makeProvider(chain) {
  return new ethers.JsonRpcProvider(
    chain.rpc[0], { chainId: chain.chainId, name: chain.name },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}

function baseCfg(extra = {}) {
  const env = readEnvFile();
  return {
    sequencerUrl: undefined,
    keysFile: 'keys.txt',
    quantity: 1,
    txPerWallet: 1,
    gasLimit: 400000,
    gasLimitMultiplier: 1.4,
    gasMultiplier: 1.3,
    maxFeeGwei: env.MAX_FEE_GWEI || undefined,
    confirmations: 1,
    waitTimeoutMs: 90000,
    retries: 3,
    simulateBeforeSend: true,
    _quiet: true,
    ...extra,
  };
}

function wallets(provider, cfg) {
  try { return loadWallets(provider, cfg, ROOT); } catch { return []; }
}

const ok = (obj) => ({ content: [{ type: 'text', text: toJSON(obj, 2) }] });
const err = (message, extra = {}) => ({
  content: [{ type: 'text', text: toJSON({ ok: false, error: message, ...extra }, 2) }],
  isError: true,
});

const tickets = new Map();
const TICKET_TTL_MS = 10 * 60 * 1000;

function issueTicket(payload) {
  const id = randomBytes(4).toString('hex').toUpperCase();
  tickets.set(id, { ...payload, expiresAt: Date.now() + TICKET_TTL_MS });
  for (const [k, v] of tickets) if (v.expiresAt < Date.now()) tickets.delete(k);
  return id;
}

function redeemTicket(id, { contract, quantity, chainId }) {
  const key = String(id ?? '').toUpperCase();
  const t = tickets.get(key);
  if (!t) {
    return { ok: false, reason: 'confirm_token tidak dikenal, sudah dipakai, atau kedaluwarsa. Tiket hanya berlaku SEKALI - panggil mint_plan lagi kalau memang sengaja mau mint lagi.' };
  }
  if (t.expiresAt < Date.now()) {
    tickets.delete(key);
    return { ok: false, reason: 'confirm_token kedaluwarsa' };
  }
  if (t.contract.toLowerCase() !== contract.toLowerCase()) {
    return { ok: false, reason: 'confirm_token untuk kontrak lain' };
  }
  if (chainId !== undefined && t.chainId !== undefined && t.chainId !== chainId) {
    return { ok: false, reason: `confirm_token diterbitkan untuk chainId ${t.chainId}, bukan ${chainId}` };
  }
  if (Number(quantity) > Number(t.quantity)) {
    return { ok: false, reason: `confirm_token hanya untuk qty ${t.quantity}` };
  }
  tickets.delete(key);
  return { ok: true, ticket: t };
}

const inFlight = new Map();

function acquireLock(contract, what) {
  const key = contract.toLowerCase();
  const held = inFlight.get(key);
  if (held) {
    const sec = Math.round((Date.now() - held.since) / 1000);
    return { ok: false, reason: `${held.what} untuk kontrak ini SEDANG BERJALAN (${sec} detik). JANGAN panggil lagi - tunggu sampai selesai dan laporkan hasilnya ke user.` };
  }
  inFlight.set(key, { what, since: Date.now() });
  return { ok: true, release: () => inFlight.delete(key) };
}

async function alreadySatisfied(provider, contract, wallet, ticket) {
  if (ticket?.mintedAtPlan === null || ticket?.mintedAtPlan === undefined) return null;
  const stats = await readMintStats(provider, contract, wallet);
  if (!stats) return null;
  if (stats.minterNumMinted > ticket.mintedAtPlan) {
    return {
      reason: `wallet ${wallet} sudah mint ${stats.minterNumMinted} (saat mint_plan baru ${ticket.mintedAtPlan}). `
        + 'Mint yang diminta tampaknya SUDAH BERHASIL. Laporkan ini ke user, jangan mint lagi.',
      minted: stats.minterNumMinted,
      atPlan: ticket.mintedAtPlan,
    };
  }
  return null;
}

function guardSpend(valueWeiPerTx, txCount) {
  const total = BigInt(valueWeiPerTx) * BigInt(txCount);
  const cap = ethers.parseEther(String(MAX_SPEND_ETH));
  if (total > cap) {
    return `total belanja ${ethers.formatEther(total)} ETH melebihi batas MAX_SPEND_ETH=${MAX_SPEND_ETH}`;
  }
  return null;
}

function nextStep(plan, drop) {
  if (!plan) return 'kontrak ini tidak punya jalur mint yang dikenal; laporkan apa adanya, jangan tebak-tebak';
  if (!drop) return 'siap -> pakai mint_now dengan confirm_token ini';

  switch (drop.publicMintProbe) {
    case 'mintable_now':
      return 'drop BUKA dan mintPublic terbukti lolos simulasi -> pakai mint_now dengan confirm_token ini';
    case 'not_open_yet':
      return `drop BELUM buka (${drop.startsInSec}s lagi, ${drop.startsAt}). mintPublic valid, cuma menunggu jam. `
        + 'INI KASUS UNTUK mint_snipe - pakai confirm_token ini. Kalau bukanya lebih dari 15 menit lagi, '
        + 'beri tahu user jadwalnya dan tawarkan menjadwalkan lewat cron, jangan bilang tidak bisa di-mint.';
    case 'window_ended':
      return 'jendela public drop sudah lewat. Tidak ada yang bisa dilakukan sampai kreator membukanya lagi.';
    case 'signature_required':
      return 'drop ini benar-benar butuh tanda tangan server OpenSea (terbukti dari revert). Mint mandiri tidak mungkin.';
    case 'sold_out':
      return `SUDAH HABIS (${drop.probeReason}). Tidak ada yang tersisa untuk di-mint. Laporkan ke user, jangan menembak.`;
    case 'no_public_drop':
      return 'kontrak tidak punya konfigurasi public drop; kemungkinan mint hanya lewat allowlist/signed.';
    default:
      return `hasil simulasi tidak pasti (${drop.probeReason}). Laporkan apa adanya ke user, jangan menyimpulkan sendiri.`;
  }
}

const server = new McpServer({ name: 'mintopensea', version: '1.0.0' });

server.registerTool('status', {
  title: 'Status konfigurasi',
  description: 'Lihat RPC yang dipakai, chain, wallet yang termuat beserta saldonya, dan batas belanja. Panggil ini kalau user bertanya "sudah siap belum".',
  inputSchema: {
    chain: z.string().optional().describe('robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora'),
  },
}, async ({ chain: chainName } = {}) => {
  const env = readEnvFile();
  const chain = currentChain(chainName);
  let blockNumber = null, reachable = false;
  const provider = makeProvider(chain);
  try { blockNumber = await provider.getBlockNumber(); reachable = true; } catch {}

  const ws = wallets(provider, baseCfg());
  const balances = [];
  for (const w of ws) {
    let bal = null;
    try { bal = ethers.formatEther(await provider.getBalance(w.address)); } catch {}
    balances.push({ address: w.address, balanceEth: bal });
  }
  return ok({
    ok: true,
    chain: { name: chain.name, chainId: chain.chainId },
    rpcConfigured: Boolean(env.RPC_URL || process.env.RPC_URL),
    rpcReachable: reachable,
    blockNumber,
    walletCount: ws.length,
    wallets: balances,
    maxSpendEth: MAX_SPEND_ETH,
    ready: reachable && ws.length > 0,
  });
});

server.registerTool('set_rpc', {
  title: 'Set RPC',
  description: 'Simpan URL RPC yang dipakai untuk semua operasi. Diuji dulu; kalau tidak merespons, tidak disimpan.',
  inputSchema: {
    url: z.string().describe('URL RPC lengkap, contoh https://robinhood-mainnet.g.alchemy.com/v2/xxx'),
  },
}, async ({ url: rpcUrl }) => {
  if (!/^https?:\/\//i.test(rpcUrl)) return err('URL harus diawali http:// atau https://');
  try {
    const p = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
    const net = await p.getNetwork();
    const bn = await p.getBlockNumber();
    writeEnvVar('RPC_URL', rpcUrl);
    return ok({
      ok: true, saved: true,
      chainId: Number(net.chainId), blockNumber: bn,
      note: 'RPC tersimpan di .env (chmod 600)',
    });
  } catch (e) {
    return err(`RPC tidak bisa dihubungi: ${e.shortMessage ?? e.message}`, { saved: false });
  }
});

server.registerTool('set_pk', {
  title: 'Tambah private key',
  description: 'Tambahkan private key wallet ke keys.txt. Kuncinya TIDAK PERNAH dikembalikan atau ditampilkan - yang dikembalikan hanya alamat wallet. Setelah memanggil ini, suruh user menghapus pesan yang berisi private key dari chat.',
  inputSchema: {
    private_key: z.string().describe('Private key 64 hex, boleh dengan atau tanpa awalan 0x'),
    replace: z.boolean().optional().describe('true = ganti semua key yang ada; false/kosong = tambahkan'),
  },
}, async ({ private_key, replace }) => {
  const key = private_key.trim().startsWith('0x') ? private_key.trim() : '0x' + private_key.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return err('private key tidak valid: harus 64 karakter hex');
  }
  let w;
  try { w = new ethers.Wallet(key); } catch { return err('private key tidak valid'); }

  const existing = fs.existsSync(KEYS_FILE) && !replace
    ? fs.readFileSync(KEYS_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    : [];
  if (existing.some((l) => l.trim().toLowerCase() === key.toLowerCase())) {
    return ok({ ok: true, address: w.address, added: false, note: 'wallet ini sudah terdaftar' });
  }
  existing.push(key);
  fs.writeFileSync(KEYS_FILE, existing.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(KEYS_FILE, 0o600); } catch {}

  let balanceEth = null;
  try {
    const provider = makeProvider(currentChain());
    balanceEth = ethers.formatEther(await provider.getBalance(w.address));
  } catch {}

  return ok({
    ok: true, added: true, address: w.address, balanceEth,
    walletCount: existing.length,
    reminder: 'SURUH USER HAPUS pesan yang berisi private key dari chat Telegram sekarang juga.',
  });
});

server.registerTool('list_wallets', {
  title: 'Daftar wallet',
  description: 'Alamat dan saldo semua wallet yang termuat. Tidak pernah menampilkan private key.',
  inputSchema: {
    chain: z.string().optional().describe('robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora'),
  },
}, async ({ chain: chainName } = {}) => {
  const chain = currentChain(chainName);
  const provider = makeProvider(chain);
  const ws = wallets(provider, baseCfg());
  const out = [];
  for (const w of ws) {
    let bal = null;
    try { bal = ethers.formatEther(await provider.getBalance(w.address)); } catch {}
    out.push({ address: w.address, balanceEth: bal });
  }
  return ok({ ok: true, chain: chain.name, count: out.length, wallets: out });
});

server.registerTool('remove_wallets', {
  title: 'Hapus semua wallet',
  description: 'Hapus semua private key dari server. Dipakai kalau user ingin membersihkan kunci.',
  inputSchema: { confirm: z.literal('HAPUS').describe('harus persis "HAPUS"') },
}, async () => {
  if (fs.existsSync(KEYS_FILE)) fs.rmSync(KEYS_FILE);
  return ok({ ok: true, removed: true });
});

server.registerTool('mint_plan', {
  title: 'Periksa kontrak & rencana mint',
  description: 'PANGGIL INI DULU sebelum mint apa pun. Membaca kontrak dari on-chain: nama, supply, harga, jadwal drop, limit per wallet, dan apakah bisa di-mint. Tidak mengirim transaksi. Mengembalikan confirm_token yang dibutuhkan mint_now dan mint_snipe.',
  inputSchema: {
    contract: z.string().describe('alamat kontrak NFT (0x...)'),
    chain: z.string().optional().describe('nama chain: robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora. URL RPC untuk chain lain diturunkan otomatis dari kunci Alchemy yang tersimpan.'),
    quantity: z.number().int().min(1).max(50).optional().describe('jumlah NFT per tx, default 1'),
  },
}, async ({ contract, quantity = 1, chain: chainName }) => {
  if (!ethers.isAddress(contract)) return err(`alamat tidak valid: ${contract}`);
  const chain = currentChain(chainName);
  const provider = makeProvider(chain);
  const address = ethers.getAddress(contract);
  const cfg = baseCfg({ contract: address, quantity });

  let profile;
  try { profile = await scanContract(provider, address, {}); }
  catch (e) { return err(e.message); }

  const ws = wallets(provider, cfg);
  const from = ws[0]?.address ?? '0x0000000000000000000000000000000000000001';
  const stats = profile.seadrop ? await readMintStats(provider, address, from) : null;
  const plan = await makePlan(provider, cfg, chain, profile, from, { ignoreSchedule: true });

  let drop = null;
  if (profile.seadrop) {
    const d = profile.seadrop.publicDrop;
    const st = publicDropStatus(profile.seadrop);
    const probe = await probePublicMint(provider, profile.seadrop, from);
    drop = {
      type: 'seadrop', open: st.open, status: st.reason,
      priceEth: ethers.formatEther(d.mintPrice),
      startTime: d.startTime, endTime: d.endTime,
      startsInSec: probe.startsInSec ?? st.startsIn ?? null,
      startsAt: d.startTime ? new Date(d.startTime * 1000).toISOString() : null,
      maxPerWallet: d.maxTotalMintableByWallet,
      publicMintProbe: probe.status,
      snipeable: probe.snipeable,
      probeReason: probe.reason,
    };
  }

  const confirmToken = plan
    ? issueTicket({
        contract: address, quantity, valueWei: plan.value, to: plan.to,
        chainId: chain.chainId,
        mintedAtPlan: stats ? stats.minterNumMinted : null,
      })
    : null;

  return ok({
    ok: true,
    contract: address,
    name: profile.name, symbol: profile.symbol, standard: profile.standard,
    supply: stats
      ? { current: stats.currentTotalSupply, max: stats.maxSupply }
      : { current: profile.totalSupply, max: profile.maxSupply },
    alreadyMintedByThisWallet: stats?.minterNumMinted ?? null,
    drop,
    mintable: Boolean(plan) && (drop ? drop.snipeable !== false : true),
    priceEthPerTx: plan ? ethers.formatEther(plan.value) : null,
    how: plan?.how ?? null,
    walletCount: ws.length,
    confirm_token: confirmToken,
    next: nextStep(plan, drop),
  });
});

server.registerTool('mint_now', {
  title: 'Mint sekarang',
  description: 'Kirim transaksi mint SEKARANG. Butuh confirm_token dari mint_plan. Pakai hanya kalau drop sudah buka. Ini membelanjakan uang sungguhan.',
  inputSchema: {
    contract: z.string().describe('alamat kontrak NFT'),
    chain: z.string().optional().describe('nama chain: robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora. URL RPC untuk chain lain diturunkan otomatis dari kunci Alchemy yang tersimpan.'),
    confirm_token: z.string().describe('token dari mint_plan'),
    quantity: z.number().int().min(1).max(50).optional(),
    tx_per_wallet: z.number().int().min(1).max(10).optional(),
  },
}, async ({ contract, confirm_token, quantity = 1, tx_per_wallet = 1, chain: chainName }) => {
  if (!ethers.isAddress(contract)) return err(`alamat tidak valid: ${contract}`);
  const address = ethers.getAddress(contract);
  const chain = currentChain(chainName);
  const provider = makeProvider(chain);
  const redeem = redeemTicket(confirm_token, { contract: address, quantity, chainId: chain.chainId });
  if (!redeem.ok) return err(redeem.reason, { hint: 'panggil mint_plan dulu untuk dapat confirm_token baru' });

  const cfg = baseCfg({ contract: address, quantity, txPerWallet: tx_per_wallet, sequencerUrl: chain.sequencer });
  const ws = wallets(provider, cfg);
  if (!ws.length) return err('belum ada private key - pakai set_pk dulu');

  const spendErr = guardSpend(redeem.ticket.valueWei, ws.length * tx_per_wallet);
  if (spendErr) return err(spendErr);

  const done = await alreadySatisfied(provider, address, ws[0].address, redeem.ticket);
  if (done) return err(done.reason, { alreadyMinted: done.minted, atPlan: done.atPlan });

  const lock = acquireLock(address, 'mint_now');
  if (!lock.ok) return err(lock.reason);

  try {
    const profile = await scanContract(provider, address, {});
    const probe = await makePlan(provider, cfg, chain, profile, ws[0].address);
    if (!probe) return err('mint belum buka atau tidak ada fungsi mint yang valid', { hint: 'pakai mint_snipe' });

    const results = await runMint(
      ws,
      async (w) => (await makePlan(provider, cfg, chain, profile, w.address)) ?? probe,
      cfg, chain.currency
    );
    const stats = profile.seadrop ? await readMintStats(provider, address, ws[0].address) : null;
    const minted = results.filter((r) => r.ok);

    return ok({
      ok: minted.length > 0,
      contract: address,
      minted: minted.length,
      failed: results.length - minted.length,
      txs: results.map((r) => ({ wallet: r.wallet, ok: r.ok, hash: r.hash ?? null, error: r.error ?? null })),
      supply: stats ? { current: stats.currentTotalSupply, max: stats.maxSupply } : null,
      note: 'confirm_token sudah hangus. Untuk mint lagi, panggil mint_plan dari awal.',
    });
  } finally {
    lock.release();
  }
});

server.registerTool('mint_snipe', {
  title: 'Snipe: tunggu drop buka lalu tembak',
  description: 'Menyiapkan dan menandatangani transaksi di depan, menunggu sampai detik pembukaan drop, lalu menembak. Butuh confirm_token dari mint_plan (SEKALI PAKAI). '
    + 'PENTING: tool ini SENGAJA MEMBLOKIR sampai drop buka - bisa belasan menit. Itu NORMAL, bukan hang. '
    + 'JANGAN PERNAH memanggilnya lagi selagi menunggu: setiap panggilan mengirim transaksi terpisah dan membelanjakan uang lagi. '
    + 'Panggil TEPAT SEKALI, tunggu sampai mengembalikan hasil, lalu laporkan. '
    + 'Kalau drop baru buka lebih dari max_wait_sec lagi, tool ini menolak - beri tahu user jadwalnya dan tawarkan cron, jangan memaksa memanggil ulang.',
  inputSchema: {
    contract: z.string(),
    chain: z.string().optional().describe('nama chain: robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora. URL RPC untuk chain lain diturunkan otomatis dari kunci Alchemy yang tersimpan.'),
    confirm_token: z.string().describe('token dari mint_plan'),
    quantity: z.number().int().min(1).max(50).optional(),
    tx_per_wallet: z.number().int().min(1).max(10).optional(),
    at: z.string().optional().describe('waktu buka manual (ISO 8601 atau unix), kalau jadwalnya tidak ada di chain'),
    max_wait_sec: z.number().int().min(1).max(3600).optional().describe('batal kalau harus menunggu lebih lama dari ini, default 900'),
    dry_run: z.boolean().optional().describe('rehearsal: jalan sampai fase tembak tanpa mengirim tx'),
    stagger_ms: z.array(z.number()).optional().describe('HANYA kalau ada >1 wallet: offset tiba per wallet dalam ms relatif batas detik, mis. [-20, 40, 100]. Wallet pertama paling agresif (bisa revert kalau kepagian), berikutnya makin aman. Tanpa ini semua wallet menembak bersamaan.'),
  },
}, async ({ contract, confirm_token, quantity = 1, tx_per_wallet = 1, at, max_wait_sec = 900, dry_run, stagger_ms, chain: chainName }) => {
  if (!ethers.isAddress(contract)) return err(`alamat tidak valid: ${contract}`);
  const address = ethers.getAddress(contract);
  const chain = currentChain(chainName);
  const provider = makeProvider(chain);
  const redeem = redeemTicket(confirm_token, { contract: address, quantity, chainId: chain.chainId });
  if (!redeem.ok) return err(redeem.reason, { hint: 'panggil mint_plan dulu' });

  const cfg = baseCfg({
    contract: address, quantity, txPerWallet: tx_per_wallet,
    at, dryRun: Boolean(dry_run), retryWindowMs: 20000, stagger: stagger_ms,
    sequencerUrl: chain.sequencer,
  });
  const ws = wallets(provider, cfg);
  if (!ws.length) return err('belum ada private key - pakai set_pk dulu');

  if (!dry_run) {
    const spendErr = guardSpend(redeem.ticket.valueWei, ws.length * tx_per_wallet);
    if (spendErr) return err(spendErr);
  }

  try {
    let start = null;
    if (at !== undefined && at !== null && at !== '') {
      const n = Number(at);
      const ms = Number.isFinite(n) && String(at).length <= 13
        ? (String(at).length > 10 ? n : n * 1000)
        : new Date(at).getTime();
      if (Number.isFinite(ms)) start = Math.floor(ms / 1000);
    }
    const profile = await scanContract(provider, address, {});
    if (start === null && profile.seadrop) start = profile.seadrop.publicDrop.startTime;
    if (start !== null) {
      const waitSec = start - Math.floor(Date.now() / 1000);
      if (waitSec > max_wait_sec) {
        return err(
          `drop baru buka ${waitSec} detik lagi (${new Date(start * 1000).toISOString()}), melebihi max_wait_sec=${max_wait_sec}`,
          { startsAt: new Date(start * 1000).toISOString(), startsInSec: waitSec,
            hint: 'jadwalkan lewat cron Hermes supaya snipe dijalankan menjelang waktu itu' }
        );
      }
    }
  } catch {}

  const done = await alreadySatisfied(provider, address, ws[0].address, redeem.ticket);
  if (done) return err(done.reason, { alreadyMinted: done.minted, atPlan: done.atPlan });

  const lock = acquireLock(address, 'mint_snipe');
  if (!lock.ok) return err(lock.reason);

  try {
    const providers = chain.rpc.slice(0, 4).map((u) => makeProvider({ ...chain, rpc: [u] }));
    const res = await snipe({ provider, providers, wallets: ws, cfg, chain, onEvent: () => {} });
    const success = res.results.filter((r) => r.success);

    return ok({
      ok: res.dryRun ? res.bundle.armed.length > 0 : success.length > 0,
      dryRun: Boolean(res.dryRun),
      contract: address,
      openAt: res.bundle.openAtMs ? new Date(res.bundle.openAtMs).toISOString() : null,
      clockOffsetMs: Math.round(res.bundle.offsetMs),
      waves: res.waves,
      minted: success.length,
      failed: res.results.length - success.length,
      txs: res.results.map((r) => ({
        wallet: r.wallet, ok: Boolean(r.success), hash: r.hash ?? null,
        blockNumber: r.blockNumber ?? null, error: r.error ?? null,
      })),
      supply: res.stats ? { current: res.stats.currentTotalSupply, max: res.stats.maxSupply } : null,
      note: 'confirm_token sudah hangus. Untuk mint lagi, panggil mint_plan dari awal.',
    });
  } finally {
    lock.release();
  }
});

server.registerTool('list_drops', {
  title: 'Cari drop yang aktif / akan buka',
  description: 'Scan chain untuk drop OpenSea SeaDrop yang sedang buka atau akan buka. Scan pertama bisa 1-2 menit, hasilnya di-cache.',
  inputSchema: {
    free_only: z.boolean().optional().describe('hanya yang gratis'),
    limit: z.number().int().min(1).max(50).optional(),
    blocks: z.number().int().optional().describe('berapa blok ke belakang di-scan, default 2000000'),
    chain: z.string().optional().describe('nama chain: robinhood (default), base, ethereum, arbitrum, optimism, polygon, zora. URL RPC untuk chain lain diturunkan otomatis dari kunci Alchemy yang tersimpan.'),
  },
}, async ({ free_only, limit = 15, blocks = 2000000, chain: chainName }) => {
  const chain = currentChain(chainName);
  const provider = makeProvider(chain);
  const cacheFile = path.join(ROOT, '.cache', `drops-${chain.chainId}.json`);
  const { contracts } = await collectDropContracts(provider, { blocks, cacheFile });
  const { live, upcoming } = await checkDrops(provider, contracts, {});

  const shape = (d) => ({
    contract: d.nft, name: d.name ?? null,
    priceEth: ethers.formatEther(d.mintPrice), free: d.mintPrice === 0n,
    maxPerWallet: d.maxPerWallet,
    supply: d.supply ?? null, maxSupply: d.maxSupply ?? null,
    startsAt: new Date(d.startTime * 1000).toISOString(),
    endsAt: new Date(d.endTime * 1000).toISOString(),
    soldOut: Boolean(d.maxSupply && d.supply >= d.maxSupply),
  });

  let liveOut = live.map(shape).filter((d) => !d.soldOut);
  if (free_only) liveOut = liveOut.filter((d) => d.free);

  return ok({
    ok: true, scanned: contracts.length,
    liveCount: liveOut.length, upcomingCount: upcoming.length,
    live: liveOut.slice(0, limit),
    upcoming: upcoming.map(shape).slice(0, Math.min(limit, 10)),
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mintopensea] MCP server siap di stdio');
