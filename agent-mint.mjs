#!/usr/bin/env node
import path from 'node:path';
import url from 'node:url';
import { ethers } from 'ethers';
import 'dotenv/config';

import { resolveChain } from './src/chains.js';
import { scanContract } from './src/scan.js';
import { makePlan } from './src/plan.js';
import { loadWallets } from './src/wallets.js';
import { runMint } from './src/mint.js';
import { snipe, preflight } from './src/sniper.js';
import { readMintStats, publicDropStatus } from './src/seadrop.js';
import { collectDropContracts, checkDrops } from './src/drops.js';
import { setLogSink, toJSON, log } from './src/util.js';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));

setLogSink((...a) => console.error(...a));

const EXIT = { OK: 0, MINT_FAILED: 1, BAD_CONFIG: 2 };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function emit(obj, code = EXIT.OK) {
  process.stdout.write(toJSON(obj) + '\n');
  process.exit(code);
}

function fail(message, extra = {}, code = EXIT.BAD_CONFIG) {
  emit({ ok: false, error: message, ...extra }, code);
}

function buildConfig(args) {
  const num = (v) => (v === undefined ? undefined : Number(v));
  const cfg = {
    chain: args.chain ?? process.env.AGENT_CHAIN ?? 'robinhood',
    contract: args.contract ?? process.env.AGENT_CONTRACT ?? process.env.CONTRACT,
    quantity: num(args.qty ?? args.quantity ?? process.env.AGENT_QTY) ?? 1,
    txPerWallet: num(args.txPerWallet ?? process.env.AGENT_TX_PER_WALLET) ?? 1,
    keysFile: args.wallets ?? process.env.AGENT_KEYS ?? 'keys.txt',

    mode: args.mode,
    sig: args.sig,
    data: args.data,
    value: args.value,
    tokenId: num(args.tokenId) ?? 0,
    seadrop: args.seadrop,

    at: args.at ?? process.env.AGENT_AT,
    leadMs: num(args.leadMs) ?? 0,
    retryWindowMs: num(args.retryWindowMs) ?? 20000,
    pollIntervalMs: num(args.pollIntervalMs) ?? 250,
    pollTimeoutMs: num(args.pollTimeoutMs) ?? 3600000,

    gasLimit: num(args.gas) ?? 400000,
    gasLimitMultiplier: num(args.gasLimitMultiplier) ?? 1.4,
    gasMultiplier: num(args.gasMultiplier) ?? 1.3,
    maxFeeGwei: args.maxFeeGwei ?? process.env.AGENT_MAX_FEE_GWEI,
    priorityFeeGwei: args.priorityFeeGwei,
    confirmations: num(args.confirmations) ?? 1,
    waitTimeoutMs: num(args.waitTimeoutMs) ?? 60000,
    retries: num(args.retries) ?? 3,
    simulateBeforeSend: args.noSimulate ? false : true,
    dryRun: Boolean(args.dryRun ?? args.dry),
    json: true,
  };
  if (process.env.RPC_URL) cfg.rpc = [process.env.RPC_URL];
  if (args.rpc) cfg.rpc = [args.rpc, ...(cfg.rpc || [])];
  return cfg;
}

function makeProvider(chain, urlStr) {
  return new ethers.JsonRpcProvider(
    urlStr, { chainId: chain.chainId, name: chain.name },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}

function dropSummary(profile) {
  if (!profile.seadrop) return null;
  const d = profile.seadrop.publicDrop;
  const st = publicDropStatus(profile.seadrop);
  return {
    type: 'seadrop',
    seadropContract: profile.seadrop.address,
    open: st.open,
    status: st.reason,
    mintPriceWei: d.mintPrice,
    mintPriceEth: ethers.formatEther(d.mintPrice),
    startTime: d.startTime,
    endTime: d.endTime,
    startsInSec: st.startsIn ?? null,
    maxPerWallet: d.maxTotalMintableByWallet,
    feeBps: d.feeBps,
    signatureGated: Boolean(profile.seadrop.signers?.length) && !st.open,
  };
}

async function actionPlan(ctx) {
  const { provider, cfg, chain } = ctx;
  const address = ethers.getAddress(cfg.contract);
  const profile = await scanContract(provider, address, { seadrop: cfg.seadrop });

  const wallets = safeWallets(provider, cfg);
  const from = wallets[0]?.address ?? '0x0000000000000000000000000000000000000001';
  const stats = profile.seadrop ? await readMintStats(provider, address, from) : null;
  const plan = await makePlan(provider, { ...cfg, _quiet: true }, chain, profile, from);

  return {
    ok: true,
    action: 'plan',
    chain: { name: chain.name, chainId: chain.chainId },
    contract: address,
    name: profile.name,
    symbol: profile.symbol,
    standard: profile.standard,
    implementation: profile.implementation,
    supply: stats
      ? { current: stats.currentTotalSupply, max: stats.maxSupply }
      : { current: profile.totalSupply, max: profile.maxSupply },
    alreadyMintedByWallet: stats?.minterNumMinted ?? null,
    drop: dropSummary(profile),
    mintable: Boolean(plan),
    plan: plan && {
      to: plan.to,
      valueWei: plan.value,
      valueEth: ethers.formatEther(plan.value),
      data: plan.data,
      how: plan.how,
    },
    wallets: wallets.map((w) => w.address),
  };
}

async function actionNow(ctx) {
  const { provider, cfg, chain } = ctx;
  const address = ethers.getAddress(cfg.contract);
  const wallets = requireWallets(provider, cfg);
  const profile = await scanContract(provider, address, { seadrop: cfg.seadrop });

  const quietCfg = { ...cfg, _quiet: true };
  const probe = await makePlan(provider, quietCfg, chain, profile, wallets[0].address);
  if (!probe) {
    return {
      ok: false, action: 'now', contract: address,
      error: 'mint belum buka atau tidak ada fungsi mint yang valid',
      drop: dropSummary(profile),
      hint: 'pakai action "snipe" untuk menunggu jadwal pembukaan',
    };
  }

  const results = await runMint(
    wallets,
    async (w) => makePlan(provider, quietCfg, chain, profile, w.address),
    quietCfg,
    chain.currency
  );
  const stats = profile.seadrop ? await readMintStats(provider, address, wallets[0].address) : null;
  const minted = results.filter((r) => r.ok);

  return {
    ok: minted.length > 0,
    action: 'now',
    contract: address,
    plan: { to: probe.to, valueEth: ethers.formatEther(probe.value), how: probe.how },
    minted: minted.length,
    failed: results.length - minted.length,
    txs: results.map((r) => ({ wallet: r.wallet, ok: r.ok, hash: r.hash ?? null, error: r.error ?? null })),
    supply: stats ? { current: stats.currentTotalSupply, max: stats.maxSupply } : null,
  };
}

async function actionSnipe(ctx, args) {
  const { provider, cfg, chain } = ctx;
  const address = ethers.getAddress(cfg.contract);
  const wallets = requireWallets(provider, cfg);

  const providers = (chain.rpc.slice(0, 4)).map((u) => makeProvider(chain, u));
  const timeline = [];

  const res = await snipe({
    provider, providers, wallets, cfg, chain,
    onEvent: (e) => {
      if (e.type === 'armed') {
        timeline.push({ t: new Date().toISOString(), event: 'armed', txCount: e.bundle.totalTx });
        log.info(`armed: ${e.bundle.totalTx} tx ditandatangani, buka ${e.bundle.openAtMs ? new Date(e.bundle.openAtMs).toISOString() : 'tidak diketahui'}`);
      } else if (e.type === 'waiting') {
        timeline.push({ t: new Date().toISOString(), event: 'waiting', waitMs: e.waitMs });
        log.info(`menunggu ${Math.round(e.waitMs / 1000)} detik`);
      } else if (e.type === 'firing') {
        timeline.push({ t: new Date().toISOString(), event: 'firing', txCount: e.txCount });
      } else if (e.type === 'sent') {
        timeline.push({ t: new Date().toISOString(), event: 'sent', wave: e.wave, elapsedMs: e.elapsedMs ?? null });
      }
    },
  });

  const success = res.results.filter((r) => r.success);
  return {
    ok: res.dryRun ? res.bundle.armed.length > 0 : success.length > 0,
    action: 'snipe',
    dryRun: Boolean(res.dryRun),
    contract: address,
    openAt: res.bundle.openAtMs ? new Date(res.bundle.openAtMs).toISOString() : null,
    scheduleSource: res.bundle.scheduleSource,
    clockOffsetMs: Math.round(res.bundle.offsetMs),
    walletsArmed: res.bundle.armed.length,
    walletsSkipped: res.bundle.skipped,
    waves: res.waves,
    minted: success.length,
    failed: res.results.length - success.length,
    txs: res.results.map((r) => ({
      wallet: r.wallet, ok: Boolean(r.success), hash: r.hash ?? null,
      blockNumber: r.blockNumber ?? null, wave: r.label, error: r.error ?? null,
    })),
    supply: res.stats ? { current: res.stats.currentTotalSupply, max: res.stats.maxSupply } : null,
    alreadyMintedByWallet: res.stats?.minterNumMinted ?? null,
    timeline,
  };
}

async function actionArm(ctx) {
  const { provider, cfg, chain } = ctx;
  const wallets = requireWallets(provider, cfg);
  const b = await preflight({ provider, wallets, cfg, chain, quiet: true });
  return {
    ok: b.armed.length > 0,
    action: 'arm',
    contract: b.address,
    target: b.armed[0].plan.to,
    valueEthPerTx: ethers.formatEther(b.armed[0].plan.value),
    gasLimit: b.gasLimit,
    maxFeeGwei: ethers.formatUnits(b.maxFee, 'gwei'),
    walletsArmed: b.armed.map((a) => ({
      wallet: a.wallet.address,
      nonce: a.nonce,
      balanceEth: ethers.formatEther(a.balance),
      neededEth: ethers.formatEther(a.needed),
    })),
    walletsSkipped: b.skipped,
    signedTxCount: b.totalTx,
    openAt: b.openAtMs ? new Date(b.openAtMs).toISOString() : null,
    scheduleSource: b.scheduleSource,
    clockOffsetMs: Math.round(b.offsetMs),
  };
}

async function actionDrops(ctx, args) {
  const { provider, cfg, chain } = ctx;
  const cacheFile = path.resolve(ROOT, '.cache', `drops-${chain.chainId}.json`);
  const { contracts } = await collectDropContracts(provider, {
    seadrop: cfg.seadrop,
    blocks: Number(args.blocks ?? 2000000),
    cacheFile,
  });
  const { live, upcoming } = await checkDrops(provider, contracts, { seadrop: cfg.seadrop });

  const shape = (d) => ({
    contract: d.nft,
    name: d.name ?? null,
    priceWei: d.mintPrice,
    priceEth: ethers.formatEther(d.mintPrice),
    free: d.mintPrice === 0n,
    startTime: d.startTime,
    endTime: d.endTime,
    maxPerWallet: d.maxPerWallet,
    supply: d.supply ?? null,
    maxSupply: d.maxSupply ?? null,
    soldOut: Boolean(d.maxSupply && d.supply >= d.maxSupply),
  });

  const limit = Number(args.limit ?? 50);
  let liveOut = live.map(shape).filter((d) => !d.soldOut);
  if (args.free) liveOut = liveOut.filter((d) => d.free);

  return {
    ok: true,
    action: 'drops',
    chain: { name: chain.name, chainId: chain.chainId },
    scanned: contracts.length,
    liveCount: liveOut.length,
    upcomingCount: upcoming.length,
    live: liveOut.slice(0, limit),
    upcoming: upcoming.map(shape).slice(0, limit),
  };
}

function safeWallets(provider, cfg) {
  try { return loadWallets(provider, cfg, ROOT); } catch { return []; }
}

function requireWallets(provider, cfg) {
  const w = safeWallets(provider, cfg);
  if (!w.length) fail('tidak ada private key: isi keys.txt atau PRIVATE_KEY di .env');
  return w;
}

const ACTIONS = {
  plan: actionPlan,
  arm: actionArm,
  now: actionNow,
  snipe: actionSnipe,
  drops: actionDrops,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] ?? 'plan';
  if (!ACTIONS[action]) {
    fail(`action tidak dikenal: ${action}`, { validActions: Object.keys(ACTIONS) });
  }

  const cfg = buildConfig(args);
  if (action !== 'drops' && !cfg.contract) {
    fail('contract wajib diisi: --contract 0x... atau env AGENT_CONTRACT');
  }
  if (cfg.contract && !ethers.isAddress(cfg.contract)) {
    fail(`alamat kontrak tidak valid: ${cfg.contract}`);
  }

  const chain = resolveChain(cfg);
  const provider = makeProvider(chain, chain.rpc[0]);
  try {
    const net = await provider.getNetwork();
    chain.chainId = Number(net.chainId);
  } catch (e) {
    fail(`RPC tidak bisa dihubungi: ${e.shortMessage ?? e.message}`);
  }

  const result = await ACTIONS[action]({ provider, cfg, chain }, args);
  const mintingAction = action === 'now' || action === 'snipe';
  emit(result, result.ok || !mintingAction ? EXIT.OK : EXIT.MINT_FAILED);
}

main().catch((e) => {
  fail(e.message ?? String(e), { stack: process.env.DEBUG ? e.stack : undefined }, EXIT.BAD_CONFIG);
});
