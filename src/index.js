#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { ethers } from 'ethers';
import 'dotenv/config';

import { resolveChain } from './chains.js';
import { makePlan } from './plan.js';
import { scanContract, resolveImplementation, tryRead } from './scan.js';
import { extractSelectors, localDictionary, lookup4byte } from './selectors.js';
import { detectMint, reportCandidates, buildCalldata } from './detect.js';
import { loadWallets } from './wallets.js';
import { runMint } from './mint.js';
import { resolveSlug, printCollection } from './opensea.js';
import { printSeaDrop, publicDropStatus, buildSeaDropPlan, readMintStats } from './seadrop.js';
import { collectDropContracts, checkDrops, printDrops } from './drops.js';
import { snipe, printArmed, printResults } from './sniper.js';
import { log, c, sleep, fmtEth, short, revertReason } from './util.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        out[k] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
      }
    } else out._.push(a);
  }
  return out;
}

function loadConfig(args) {
  const file = path.resolve(ROOT, args.config || 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  else log.warn('config.json tidak ditemukan, pakai default + flag CLI');

  if (process.env.RPC_URL) cfg.rpc = [process.env.RPC_URL, ...(cfg.rpc || [])];
  if (process.env.CONTRACT) cfg.contract = process.env.CONTRACT;

  const map = {
    contract: 'contract', chain: 'chain', qty: 'quantity', quantity: 'quantity',
    mode: 'mode', sig: 'sig', sigKind: 'sigKind', data: 'data', value: 'value',
    tokenId: 'tokenId', wallets: 'keysFile', gas: 'gasLimit',
    txPerWallet: 'txPerWallet', preferSig: 'preferSig', seadrop: 'seadrop',
    maxFeeGwei: 'maxFeeGwei', priorityFeeGwei: 'priorityFeeGwei',
    gasMultiplier: 'gasMultiplier', gasLimitMultiplier: 'gasLimitMultiplier',
    delayMs: 'delayMs', retries: 'retries',
    watchIntervalMs: 'watchIntervalMs', confirmations: 'confirmations',
    at: 'at', leadMs: 'leadMs', retryWindowMs: 'retryWindowMs', dryRun: 'dryRun',
    pollIntervalMs: 'pollIntervalMs', pollTimeoutMs: 'pollTimeoutMs',
    safetyMs: 'safetyMs', burstLeadMs: 'burstLeadMs', burstIntervalMs: 'burstIntervalMs',
    burstWindowMs: 'burstWindowMs', burstMaxInflight: 'burstMaxInflight', deliveryMs: 'deliveryMs',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (args[flag] !== undefined) cfg[key] = args[flag];
  }
  if (args.rpc !== undefined) cfg.rpc = [args.rpc];
  if (args.conditional) cfg.conditional = true;
  if (args.noConditional) cfg.conditional = false;
  if (!cfg.chain) cfg.chain = 'robinhood';
  return cfg;
}

function makeProvider(chain) {
  return new ethers.JsonRpcProvider(
    chain.rpc[0],
    { chainId: chain.chainId, name: chain.name },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}

function makeBroadcastProviders(chain) {
  return chain.rpc.slice(0, 4).map(
    (u) => new ethers.JsonRpcProvider(u, { chainId: chain.chainId, name: chain.name },
      { staticNetwork: true, batchMaxCount: 1 })
  );
}

function maskRpc(u) {
  return String(u).replace(/(\/v2\/|apiKey=|api-key=)[^/&?]+/i, '$1***');
}

function requireContract(cfg) {
  if (!cfg.contract || !ethers.isAddress(cfg.contract)) {
    log.err('Alamat kontrak belum diisi. Set "contract" di config.json atau pakai --contract 0x...');
    process.exit(1);
  }
  return ethers.getAddress(cfg.contract);
}

function printProfile(p, chain) {
  const sym = chain.currency;
  log.step('Profil kontrak');
  log.plain(`   alamat        : ${p.address}`);
  if (p.implementation) log.plain(`   implementation: ${p.implementation} ${c.dim}(proxy)${c.reset}`);
  log.plain(`   nama / simbol : ${p.name ?? '-'} / ${p.symbol ?? '-'}`);
  log.plain(`   standar       : ${p.standard}`);
  log.plain(`   owner         : ${p.owner ?? '-'}`);
  log.plain(`   supply        : ${p.totalSupply ?? '?'}${p.maxSupply ? ` / ${p.maxSupply}` : ''}`);
  if (p.price) log.plain(`   harga         : ${fmtEth(p.price.value, sym)} ${c.dim}(${p.price.sig})${c.reset}`);
  else log.plain(`   harga         : ${c.dim}tidak terdeteksi (mungkin gratis / harga ada di claim condition)${c.reset}`);
  if (p.maxPerWallet) log.plain(`   limit         : ${p.maxPerWallet.value} ${c.dim}(${p.maxPerWallet.sig})${c.reset}`);
  for (const f of p.saleFlags) {
    const open = f.value === f.openWhen;
    const note = open ? `${c.green}(mint kemungkinan BUKA)` : `${c.yellow}(mint kemungkinan TUTUP)`;
    log.plain(`   ${f.sig.padEnd(22)}: ${f.value} ${note}${c.reset}`);
  }
  if (p.thirdweb) {
    const t = p.thirdweb;
    const start = new Date(Number(t.startTimestamp) * 1000);
    const started = start <= new Date() ? `${c.green}(sudah jalan)${c.reset}` : `${c.yellow}(belum mulai)${c.reset}`;
    log.plain(`   ${c.cyan}thirdweb drop${c.reset} - claim condition #${t.conditionId}`);
    log.plain(`     mulai       : ${start.toISOString()} ${started}`);
    log.plain(`     harga/token : ${fmtEth(t.pricePerToken, sym)}`);
    log.plain(`     terklaim    : ${t.supplyClaimed} / ${t.maxClaimableSupply}`);
    log.plain(`     limit/wallet: ${t.quantityLimitPerWallet}`);
    const al = t.merkleRoot === ethers.ZeroHash ? 'tidak (public)' : `${c.yellow}ADA merkle root - butuh proof${c.reset}`;
    log.plain(`     allowlist   : ${al}`);
  }
  if (p.seadrop) printSeaDrop(p.seadrop, chain, p.mintStats);
  if (p.soldOut) log.warn('totalSupply sudah mencapai maxSupply - kemungkinan SOLD OUT.');
}

function safeWallets(provider, cfg) {
  try { return loadWallets(provider, cfg, ROOT); } catch { return []; }
}

async function scanOrNull(provider, address, cfg) {
  try {
    return await scanContract(provider, address, { seadrop: cfg.seadrop });
  } catch (e) {
    if (cfg.mode === 'raw' || cfg.data || cfg.sig) {
      log.warn(`scan kontrak dilewati: ${e.message}`);
      return { address, standard: 'unknown', mintCandidates: [], saleFlags: [], price: null, totalSupply: null };
    }
    throw e;
  }
}

async function cmdInfo(ctx) {
  const { provider, cfg, chain } = ctx;
  const address = requireContract(cfg);
  log.info(`chain ${chain.name} (${chain.chainId}) via ${maskRpc(chain.rpc[0])}`);

  const profile = await scanContract(provider, address, { seadrop: cfg.seadrop });
  if (profile.maxSupply && profile.totalSupply !== null) {
    profile.soldOut = profile.totalSupply >= profile.maxSupply;
  }

  const wallets = safeWallets(provider, cfg);
  const from = wallets[0]?.address || cfg.simulateFrom || '0x0000000000000000000000000000000000000001';
  if (profile.seadrop) {
    profile.mintStats = await readMintStats(provider, address, from);
    if (profile.mintStats?.maxSupply) {
      profile.soldOut = profile.mintStats.currentTotalSupply >= profile.mintStats.maxSupply;
    }
  }
  printProfile(profile, chain);

  log.step(`Simulasi mint dari ${short(from)} (qty ${cfg.quantity ?? 1})`);
  if (!wallets.length) log.warn('Belum ada private key - simulasi pakai alamat dummy, hasil bisa beda.');

  const plan = await makePlan(provider, cfg, chain, profile, from);
  if (plan) {
    log.ok(`Rencana mint: ${plan.how}`);
    log.plain(`   to    : ${plan.to}`);
    log.plain(`   value : ${fmtEth(plan.value, chain.currency)}`);
    log.plain(`   data  : ${plan.data.slice(0, 74)}${plan.data.length > 74 ? '...' : ''}`);
  } else {
    log.warn('Belum ada cara mint yang lolos simulasi (mint mungkin belum buka / butuh allowlist).');
    log.warn('Alternatif: jalankan `node src/index.js watch`, atau pakai mode raw calldata.');
  }
}

async function cmdSigs(ctx, args) {
  const { provider, cfg } = ctx;
  const address = requireContract(cfg);
  let code = await provider.getCode(address);
  if (!code || code === '0x') { log.err(`Tidak ada kontrak di ${address}`); process.exit(1); }

  const impl = await resolveImplementation(provider, address, code);
  if (impl) {
    log.warn(`Ini proxy -> implementation ${impl}`);
    code = code + (await provider.getCode(impl)).slice(2);
  }

  const selectors = extractSelectors(code);
  const dict = localDictionary();
  const known = [];
  const unknown = [];
  for (const sel of selectors) {
    if (dict.has(sel)) known.push([sel, dict.get(sel)]);
    else unknown.push(sel);
  }

  log.step(`${selectors.length} selector ditemukan di bytecode`);
  for (const [sel, sig] of known.sort((a, b) => a[1].localeCompare(b[1]))) {
    log.plain(`   ${c.green}${sel}${c.reset}  ${sig}`);
  }

  if (args.offline) {
    log.plain(`\n   ${unknown.length} selector tidak dikenal (pakai tanpa --offline untuk lookup 4byte.directory)`);
    for (const sel of unknown) log.plain(`   ${c.dim}${sel}${c.reset}`);
    return;
  }

  log.info(`Lookup ${unknown.length} selector ke 4byte.directory...`);
  const resolved = await lookup4byte(unknown);
  const mintish = [];
  for (const sel of unknown) {
    const sig = resolved.get(sel);
    if (!sig) { log.plain(`   ${c.dim}${sel}  ?${c.reset}`); continue; }
    const hot = /mint|claim|purchase|buy|drop/i.test(sig);
    if (hot) mintish.push([sel, sig]);
    log.plain(`   ${hot ? c.yellow : c.dim}${sel}${c.reset}  ${sig}`);
  }
  if (mintish.length) {
    log.step('Kandidat fungsi mint/claim yang belum ada di katalog');
    for (const [sel, sig] of mintish) log.plain(`   ${c.yellow}${sig}${c.reset}  ${c.dim}${sel}${c.reset}`);
    log.ok(`Coba: node src/index.js info --contract ${address} --sig "${mintish[0][1]}"`);
  }

  const allowed = await tryRead(provider, address, 'getAllowedSeaDrop()', ['address[]']);
  if (allowed && allowed.length) {
    log.step('Kontrak ini pakai OpenSea SeaDrop');
    for (const sd of allowed) log.plain(`   minter SeaDrop: ${sd}`);
    log.plain(`   Mint dipanggil ke kontrak SeaDrop, bukan ke kontrak NFT:`);
    log.plain(`   ${c.cyan}mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)${c.reset}`);
    log.plain(`   Cara paling gampang: mode raw, copy input data dari tx mint yang sukses di explorer.`);
  }
}

async function cmdSnipe(ctx) {
  const { provider, cfg, chain } = ctx;
  requireContract(cfg);
  const wallets = loadWallets(provider, cfg, ROOT);
  if (!wallets.length) {
    log.err('Tidak ada private key. Isi keys.txt atau PRIVATE_KEY di .env');
    process.exit(1);
  }

  const providers = makeBroadcastProviders(chain);
  log.info(`broadcast lewat ${providers.length} RPC`);

  const res = await snipe({
    provider, providers, wallets, cfg, chain,
    onEvent: (e) => {
      if (e.type === 'armed') printArmed(e.bundle, chain);
      else if (e.type === 'waiting') {
        const s = Math.round(e.waitMs / 1000);
        const sec = Math.floor(e.openAtMs / 1000) * 1000;
        const sg = (v) => (v >= 0 ? '+' : '') + Math.round(v);
        const plan = e.mode === 'conditional'
          ? `bersyarat: target tiba +${Math.round(e.arrivalMs - sec)}ms, kirim pertama ${sg(e.fireAt - sec)}ms`
          : `polos: target tiba +${Math.round(e.arrivalMs - sec)}ms, kirim ${sg(e.fireAt - sec)}ms (kompensasi pengiriman ${Math.round(e.arrivalMs - e.fireAt)}ms)`;
        log.info(`${s > 0 ? `menunggu ${s} detik sampai mint buka` : 'mint sudah buka, tembak sekarang'} | ${plan} | batas detik +${Math.round(e.boundaryOffsetMs)}ms via ${e.boundarySource} | sequencer ${e.seqLatencyMs ? Math.round(e.seqLatencyMs) + 'ms' : '-'}`);
      } else if (e.type === 'countdown') log.info(`sisa ${Math.round(e.remainingMs / 1000)} detik`);
      else if (e.type === 'resync') log.info(`resync: batas detik +${Math.round(e.boundaryOffsetMs)}ms via ${e.boundarySource} | sequencer ${e.seqLatencyMs ? Math.round(e.seqLatencyMs) + 'ms' : '-'} | mode ${e.mode}`);
      else if (e.type === 'polling') log.info(`jadwal tidak diketahui, polling simulasi tiap ${e.intervalMs}ms`);
      else if (e.type === 'firing') log.step(`TEMBAK ${e.txCount} tx (${e.mode})`);
      else if (e.type === 'burst') {
        for (const d of e.detail) {
          log.info(`burst ${short(d.wallet)}: ${d.shots} tembakan, ${d.rejected} ditolak gratis${d.accepted ? `, DITERIMA (kirim +${d.sentAtMs % 1000}ms, jawab +${d.acceptedAtMs % 1000}ms)` : `, tidak diterima -> fallback polos (${d.lastReason ?? '-'})`}`);
        }
      } else if (e.type === 'sent') {
        const ok = e.sent.filter((s) => s.ok).length;
        log.info(`gelombang ${e.wave}: ${ok}/${e.sent.length} tx masuk mempool${e.elapsedMs !== undefined ? ` dalam ${e.elapsedMs}ms` : ''}`);
      }
    },
  });

  printResults(res, chain);
  if (!res.results.some((r) => r.success)) process.exitCode = 1;
}

async function cmdDrops(ctx, args) {
  const { provider, cfg, chain } = ctx;
  const blocks = Number(args.blocks ?? cfg.dropsScanBlocks ?? 2_000_000);
  const cacheFile = path.resolve(ROOT, '.cache', `drops-${chain.chainId}.json`);

  log.info(`Scan event SeaDrop ${blocks} blok terakhir (cache: .cache/drops-${chain.chainId}.json)`);
  const { contracts, latest } = await collectDropContracts(provider, {
    seadrop: cfg.seadrop, blocks, cacheFile,
  });
  log.info(`${contracts.length} kontrak pernah punya public drop (blok terakhir ${latest})`);

  const res = await checkDrops(provider, contracts, { seadrop: cfg.seadrop });
  printDrops(res, {
    currency: chain.currency,
    limit: args.limit ?? 25,
    freeOnly: Boolean(args.free),
  });
}

async function cmdResolve(ctx, args) {
  const { chain } = ctx;
  const slug = args._[1] || ctx.cfg.slug;
  if (!slug) {
    log.err('Kasih slug koleksinya, contoh: node src/index.js resolve rexcon-robinhood');
    process.exit(1);
  }
  const info = await resolveSlug(slug, chain.chainId);
  printCollection(info);
}

async function cmdBalance(ctx) {
  const { provider, cfg, chain } = ctx;
  const wallets = loadWallets(provider, cfg, ROOT);
  if (!wallets.length) return log.err('Tidak ada private key. Isi keys.txt atau PRIVATE_KEY di .env');
  log.step(`Saldo ${wallets.length} wallet di ${chain.name}`);
  for (const w of wallets) {
    const bal = await provider.getBalance(w.address);
    log.plain(`   ${w.address}  ${fmtEth(bal, chain.currency)}`);
  }
}

async function cmdMint(ctx) {
  const { provider, cfg, chain } = ctx;
  const address = requireContract(cfg);
  const wallets = loadWallets(provider, cfg, ROOT);
  if (!wallets.length) {
    log.err('Tidak ada private key. Isi keys.txt atau PRIVATE_KEY di .env');
    process.exit(1);
  }

  const profile = await scanOrNull(provider, address, cfg);
  printProfile(profile, chain);

  const probe = await makePlan(provider, cfg, chain, profile, wallets[0].address);
  if (!probe) {
    log.err('Simulasi gagal untuk semua kandidat. Mint kemungkinan belum buka.');
    log.err('Jalankan `node src/index.js watch` untuk auto-fire begitu buka.');
    process.exit(1);
  }
  log.ok(`Rencana: ${probe.how} | value ${fmtEth(probe.value, chain.currency)} per tx`);

  log.step(`Mint dengan ${wallets.length} wallet x ${cfg.txPerWallet ?? 1} tx, qty ${cfg.quantity ?? 1}/tx`);
  cfg._quiet = true;
  const planFor = async (wallet) => {
    const plan = await makePlan(provider, cfg, chain, profile, wallet.address);
    if (!plan) throw new Error('Tidak ada cara mint yang valid untuk wallet ini.');
    return plan;
  };
  await runMint(wallets, planFor, cfg, chain.currency);
}

async function cmdWatch(ctx) {
  const { provider, cfg, chain } = ctx;
  const address = requireContract(cfg);
  const wallets = loadWallets(provider, cfg, ROOT);
  if (!wallets.length) { log.err('Tidak ada private key.'); process.exit(1); }

  const interval = Number(cfg.watchIntervalMs ?? 3000);
  let profile = await scanOrNull(provider, address, cfg);
  printProfile(profile, chain);
  log.step(`Watch mode: cek tiap ${interval}ms, auto-mint begitu simulasi lolos. Ctrl+C untuk berhenti.`);

  cfg._quiet = true;
  for (let tick = 1; ; tick++) {
    try {
      if (tick % 20 === 0) profile = await scanOrNull(provider, address, cfg);
      const plan = await makePlan(provider, cfg, chain, profile, wallets[0].address);
      if (plan) {
        log.ok(`MINT TERBUKA -> ${plan.how}`);
        await runMint(
          wallets,
          async (w) => (await makePlan(provider, cfg, chain, profile, w.address)) ?? plan,
          cfg,
          chain.currency
        );
        return;
      }
      if (tick % 20 === 0) {
        const sup = profile.maxSupply ? `${profile.totalSupply}/${profile.maxSupply}` : `${profile.totalSupply ?? '?'}`;
        log.info(`masih tutup | supply ${sup} | tick ${tick}`);
      }
    } catch (e) {
      log.err('watch error:', revertReason(e));
    }
    await sleep(interval);
  }
}

const HELP = `
${c.bold}mintopensea${c.reset} - mint NFT langsung lewat contract (default: Robinhood Chain)

  node src/index.js <command> [flags]

Commands:
  info            Scan kontrak: harga, supply, status sale, deteksi fungsi mint + simulasi
  mint            Eksekusi mint pakai semua wallet di keys.txt / .env
  watch           Pantau terus, auto-mint begitu simulasi lolos (mint dibuka)
  balance         Cek saldo semua wallet
  snipe           Siapkan tx di depan, tunggu detik pembukaan, lalu tembak (auto-mint cepat)
  drops           Cari drop OpenSea yang lagi AKTIF / akan datang di chain ini
  sigs            Bongkar semua fungsi di bytecode kontrak (buat kontrak aneh/non-standar)
  resolve <slug>  Cari alamat kontrak dari slug koleksi OpenSea (butuh OPENSEA_API_KEY)
  help            Tampilkan bantuan ini

Flags (menimpa config.json):
  --contract 0x..         alamat kontrak NFT
  --chain <nama>          robinhood | robinhood-testnet | ethereum | base | arbitrum
  --rpc <url>             RPC custom
  --qty <n>               jumlah NFT per tx (default 1)
  --txPerWallet <n>       jumlah tx per wallet
  --sig "mint(uint256)"   paksa pakai signature ini
  --mode raw --data 0x.. --value 0.01    kirim calldata mentah (copy dari explorer)
  --tokenId <n>           untuk ERC1155
  --maxFeeGwei <n>        patok gas manual (dompet tipis -> turunkan)

Khusus snipe:
  --at <iso|unix>         paksa waktu buka (kalau jadwalnya tidak ada di chain)
  --leadMs <n>            geser tembakan, negatif = lebih awal (default 0)
  --retryWindowMs <n>     lama mencoba lagi kalau gelombang pertama gagal (default 20000)
  --pollIntervalMs <n>    jarak polling kalau jadwal tidak diketahui (default 250)
  --config <file>         pakai file config lain

Contoh:
  node src/index.js info --contract 0xABC...
  node src/index.js mint --contract 0xABC... --qty 2
  node src/index.js watch --contract 0xABC...
  node src/index.js mint --mode raw --data 0xa0712d68...0001 --value 0.005
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'help' || args.help) return console.log(HELP);

  const cfg = loadConfig(args);
  const chain = resolveChain(cfg);
  const provider = makeProvider(chain);

  try {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== chain.chainId) {
      log.warn(`chainId RPC (${net.chainId}) beda dari preset (${chain.chainId}), pakai nilai dari RPC`);
      chain.chainId = Number(net.chainId);
    }
  } catch (e) {
    log.err(`RPC tidak bisa dihubungi: ${maskRpc(chain.rpc[0])}`);
    log.err(revertReason(e));
    process.exit(1);
  }

  const ctx = { provider, cfg, chain };
  switch (cmd) {
    case 'info': await cmdInfo(ctx); break;
    case 'mint': await cmdMint(ctx); break;
    case 'watch': await cmdWatch(ctx); break;
    case 'balance': await cmdBalance(ctx); break;
    case 'resolve': await cmdResolve(ctx, args); break;
    case 'sigs': await cmdSigs(ctx, args); break;
    case 'drops': await cmdDrops(ctx, args); break;
    case 'snipe': await cmdSnipe(ctx); break;
    default:
      log.err(`command tidak dikenal: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  log.err(e.message || e);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
