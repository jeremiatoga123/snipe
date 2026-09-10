import { ethers } from 'ethers';
import { scanContract } from './scan.js';
import { makePlan } from './plan.js';
import { readMintStats, publicDropStatus } from './seadrop.js';
import { simulate } from './detect.js';
import { buildFees } from './mint.js';
import { log, c, sleep, short, revertReason, fmtEth } from './util.js';

export async function measureClockOffset(provider, samples = 3) {
  const offsets = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const block = await provider.getBlock('latest');
    const t1 = Date.now();
    if (!block) continue;
    offsets.push(t0 + (t1 - t0) / 2 - block.timestamp * 1000);
    if (i < samples - 1) await sleep(150);
  }
  if (!offsets.length) return { offsetMs: 0, samples: 0 };
  const offsetMs = Math.min(...offsets);
  return { offsetMs, samples: offsets.length };
}

export async function warmConnections(targets, { rounds = 2, deadlineMs = null } = {}) {
  return Promise.all(targets.map(async (t) => {
    const times = [];
    for (let i = 0; i < rounds; i++) {
      if (deadlineMs && Date.now() > deadlineMs) break;
      const t0 = performance.now();
      try {
        if (t.provider) await t.provider.send('eth_blockNumber', []);
        else await pokeSequencer(t.url);
        times.push(performance.now() - t0);
      } catch { }
    }
    return { label: t.label, coldMs: times[0] ?? null, warmMs: times[times.length - 1] ?? null, rounds: times.length };
  }));
}

async function pokeSequencer(url) {
  const t0 = performance.now();
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] }),
    signal: AbortSignal.timeout(4000),
  });
  return performance.now() - t0;
}

export async function sendToSequencer(url, rawTx) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rawTx] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'sequencer menolak');
  return j.result;
}

export async function measureSequencerLatency(url, samples = 7) {
  if (!url) return { medianMs: null, minMs: null, samples: 0 };
  try { await pokeSequencer(url); } catch {}
  const xs = [];
  for (let i = 0; i < samples; i++) {
    try { xs.push(await pokeSequencer(url)); } catch {}
  }
  if (!xs.length) return { medianMs: null, minMs: null, samples: 0 };
  xs.sort((a, b) => a - b);
  return { medianMs: xs[Math.floor(xs.length / 2)], minMs: xs[0], samples: xs.length };
}

export async function measureRpcLatency(provider, samples = 9) {
  const xs = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    try { await provider.send('eth_blockNumber', []); } catch { continue; }
    xs.push(performance.now() - t0);
  }
  if (!xs.length) return { medianMs: 60, samples: 0 };
  xs.sort((a, b) => a - b);
  return { medianMs: xs[Math.floor(xs.length / 2)], minMs: xs[0], samples: xs.length };
}

async function boundarySample(provider, timeoutMs) {
  let prevTs = null, prevLocal = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t0 = Date.now();
    let ts;
    try {
      const b = await provider.send('eth_getBlockByNumber', ['latest', false]);
      ts = parseInt(b.timestamp, 16);
    } catch { continue; }
    const mid = t0 + (Date.now() - t0) / 2;
    if (prevTs !== null && ts > prevTs) {
      let offset = (prevLocal + mid) / 2 - ts * 1000;
      if (offset < 0) offset = 0;
      if (offset > 999) offset = 999;
      return { offset, windowMs: mid - prevLocal };
    }
    prevTs = ts; prevLocal = mid;
  }
  return null;
}

export async function measureSecondBoundary(provider, { timeoutMs = 2500, samples = 5 } = {}) {
  const xs = [];
  let windowMs = null;
  for (let i = 0; i < samples; i++) {
    const s = await boundarySample(provider, timeoutMs);
    if (!s) continue;
    xs.push(s.offset);
    if (windowMs === null || s.windowMs < windowMs) windowMs = s.windowMs;
  }
  if (!xs.length) return { boundaryOffsetMs: 0, windowMs: null, ok: false, samples: 0 };
  xs.sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)];
  return {
    boundaryOffsetMs: median,
    minMs: xs[0],
    spreadMs: xs[xs.length - 1] - xs[0],
    meanMs: xs.reduce((s, x) => s + x, 0) / xs.length,
    windowMs, ok: true, samples: xs.length,
  };
}

export async function measureSecondBoundaryViaFeed(feedUrl, { seconds = 8, drainTimeoutMs = 20000 } = {}) {
  if (!feedUrl || typeof WebSocket === 'undefined') return { ok: false, boundaryOffsetMs: 0, samples: 0, source: 'feed' };
  return new Promise((resolve) => {
    const firstSeen = new Map();
    let drainedAt = null, drainSec = null, done = false, ws = null, hardStop = null;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      if (hardStop) clearTimeout(hardStop);
      try { ws && ws.close(); } catch {}
      const xs = [...firstSeen.values()].sort((a, b) => a - b);
      if (!xs.length) return resolve({ ok: false, boundaryOffsetMs: 0, samples: 0, source: 'feed', ...extra });
      resolve({
        ok: true, source: 'feed',
        boundaryOffsetMs: xs[Math.floor(xs.length / 2)],
        minMs: xs[0], spreadMs: xs[xs.length - 1] - xs[0], samples: xs.length,
        ...extra,
      });
    };
    try { ws = new WebSocket(feedUrl); } catch (e) { return resolve({ ok: false, boundaryOffsetMs: 0, samples: 0, source: 'feed', error: String(e.message) }); }
    hardStop = setTimeout(() => finish({ timedOut: true }), drainTimeoutMs + seconds * 1000 + 2000);
    ws.onerror = () => finish({ error: 'ws error' });
    ws.onclose = () => finish();
    ws.onmessage = (e) => {
      const now = Date.now();
      let j;
      try { j = JSON.parse(e.data); } catch { return; }
      for (const m of j.messages || []) {
        const ts = m?.message?.message?.header?.timestamp;
        if (ts == null) continue;
        if (drainedAt === null) {
          if (ts >= Math.floor(now / 1000) - 1) { drainedAt = now; drainSec = ts; }
          continue;
        }
        if (ts > drainSec && !firstSeen.has(ts)) firstSeen.set(ts, now % 1000);
      }
      if (drainedAt !== null && now - drainedAt >= seconds * 1000) finish();
    };
  });
}

export async function measureBoundaryRobust(provider, feedUrl, opts = {}) {
  let rpc = null;
  try { rpc = await measureSecondBoundary(provider, opts.rpc); } catch { rpc = null; }
  if (rpc && rpc.ok && rpc.samples >= 2) return { ...rpc, source: 'rpc' };
  const feed = await measureSecondBoundaryViaFeed(feedUrl, opts.feed);
  if (feed.ok) return feed;
  if (rpc && rpc.ok) return { ...rpc, source: 'rpc' };
  return { ok: false, boundaryOffsetMs: 0, samples: 0, source: 'none' };
}

export function computeArrivalAt(startTimeSec, { boundaryOffsetMs, leadMs = 0 }) {
  return startTimeSec * 1000 + boundaryOffsetMs + leadMs;
}

export function computeFireAt(startTimeSec, { boundaryOffsetMs, latencyMs, safetyMs = 40, leadMs = 0 }) {
  const oneWay = (latencyMs ?? 60) / 2;
  return startTimeSec * 1000 + boundaryOffsetMs + safetyMs - oneWay + leadMs;
}

export function chainNowMs(offsetMs) {
  return Date.now() - offsetMs;
}

export async function sleepUntil(targetMs, offsetMs, onTick) {
  for (;;) {
    const remaining = targetMs - chainNowMs(offsetMs);
    if (remaining <= 0) return;
    if (remaining > 5000) {
      if (onTick) onTick(remaining);
      await sleep(Math.min(remaining - 2000, 30000));
    } else if (remaining > 25) {
      await sleep(remaining - 20);
    } else {
      const end = targetMs;
      while (chainNowMs(offsetMs) < end) { }
      return;
    }
  }
}

export async function preflight({ provider, wallets, cfg, chain, quiet = false }) {
  const address = ethers.getAddress(cfg.contract);
  const say = quiet ? () => {} : (...a) => log.info(...a);

  const profile = await scanContract(provider, address, { seadrop: cfg.seadrop });

  const plans = [];
  for (const w of wallets) {
    const plan = await makePlan(provider, cfg, chain, profile, w.address, { ignoreSchedule: true });
    if (!plan) {
      throw new Error(
        'Tidak bisa menyusun calldata mint. Kontrak ini bukan SeaDrop/thirdweb dan ' +
        'tidak punya fungsi mint yang dikenal. Pakai --sig atau --mode raw --data 0x...'
      );
    }
    plans.push({ wallet: w, plan });
  }

  let openAtMs = null;
  let source = 'tidak diketahui';
  if (cfg.at) {
    const n = Number(cfg.at);
    openAtMs = Number.isFinite(n) && String(cfg.at).length <= 13
      ? (String(cfg.at).length > 10 ? n : n * 1000)
      : new Date(cfg.at).getTime();
    if (!Number.isFinite(openAtMs)) throw new Error(`--at tidak bisa dibaca: ${cfg.at}`);
    source = 'manual (--at)';
  } else if (plans[0].plan.scheduled) {
    openAtMs = plans[0].plan.startTime * 1000;
    source = 'SeaDrop publicDrop.startTime';
  }

  const probe = plans[0];
  let gasLimit = null;
  const sim = await simulate(provider, {
    from: probe.wallet.address, to: probe.plan.to,
    data: probe.plan.data, value: probe.plan.value,
  });
  if (sim.ok && sim.gas) {
    gasLimit = (sim.gas * BigInt(Math.round(Number(cfg.gasLimitMultiplier ?? 1.4) * 100))) / 100n;
    say(`estimasi gas ${sim.gas} -> gasLimit ${gasLimit}`);
  } else {
    gasLimit = BigInt(cfg.gasLimit ?? 400000);
    say(`simulasi belum lolos (${sim.error ?? 'mint belum buka'}), pakai gasLimit tetap ${gasLimit}`);
  }

  const fees = await buildFees(provider, cfg);
  const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;

  const armed = [];
  const skipped = [];
  for (const { wallet, plan } of plans) {
    const [balance, nonce] = await Promise.all([
      provider.getBalance(wallet.address),
      wallet.getNonce('pending'),
    ]);
    const needed = (gasLimit * maxFee + plan.value) * BigInt(Math.max(1, Number(cfg.txPerWallet ?? 1)));
    if (balance < needed) {
      const reason = `saldo kurang: butuh ~${ethers.formatEther(needed)}, punya ${ethers.formatEther(balance)}`;
      skipped.push({ wallet: wallet.address, reason });
      if (!cfg.dryRun) continue;
      say(`[dry-run] ${short(wallet.address)} ${reason} - tetap disertakan`);
    }
    armed.push({ wallet, plan, nonce, balance, needed, underfunded: balance < needed });
  }
  if (!armed.length) {
    throw new Error(`Tidak ada wallet yang siap. ${skipped.map((s) => `${short(s.wallet)}: ${s.reason}`).join('; ')}`);
  }

  const txPerWallet = Math.max(1, Number(cfg.txPerWallet ?? 1));
  for (const a of armed) {
    a.signed = [];
    for (let k = 0; k < txPerWallet; k++) {
      const tx = {
        chainId: chain.chainId,
        to: a.plan.to,
        data: a.plan.data,
        value: a.plan.value,
        gasLimit,
        nonce: a.nonce + k,
        ...fees,
      };
      a.signed.push(await a.wallet.signTransaction(tx));
    }
  }

  const lat = await measureRpcLatency(provider);
  const boundary = await measureBoundaryRobust(provider, chain.feed);
  const seqLat = await measureSequencerLatency(chain.sequencer, 7);
  const conditionalOk = chain.sequencer ? await supportsConditional(chain.sequencer) : false;
  say(
    `latensi RPC ${lat.medianMs.toFixed(0)}ms | sequencer ${seqLat.medianMs ? seqLat.medianMs.toFixed(0) + 'ms' : '-'}` +
    ` | batas detik +${boundary.boundaryOffsetMs.toFixed(0)}ms via ${boundary.source}${boundary.ok ? '' : ' (gagal diukur, pakai 0)'}` +
    ` | bersyarat: ${conditionalOk ? 'ya' : 'tidak'}`
  );

  const { offsetMs, samples } = await measureClockOffset(provider);

  if (profile.seadrop) {
    for (const a of armed) {
      const st = await readMintStats(provider, address, a.wallet.address);
      a.mintedBefore = st ? st.minterNumMinted : null;
    }
  }

  return {
    address, profile, armed, skipped, gasLimit, fees, maxFee,
    openAtMs, scheduleSource: source, offsetMs,
    latencyMs: lat.medianMs, boundaryOffsetMs: boundary.boundaryOffsetMs, boundaryOk: boundary.ok,
    boundarySource: boundary.source, seqLatencyMs: seqLat.medianMs, conditionalOk,
    deliveryMs: cfg.deliveryMs != null ? Number(cfg.deliveryMs) : (chain.deliveryMs ?? null),
    totalTx: armed.length * txPerWallet,
  };
}

export async function fire(providers, bundle, { label = 'wave-1', dryRun = false, sequencerUrl = null } = {}) {
  const jobs = [];
  for (const a of bundle.armed) {
    for (const raw of a.signed) {
      jobs.push({ wallet: a.wallet.address, raw });
    }
  }

  if (dryRun) {
    return jobs.map((j) => ({
      ...j, ok: true, dryRun: true, label,
      hash: ethers.keccak256(j.raw),
    }));
  }

  const sent = await Promise.all(
    jobs.map(async (j) => {
      const attempts = providers.map(async (p) => {
        const res = await p.broadcastTransaction(j.raw);
        return res.hash;
      });
      if (sequencerUrl) attempts.push(sendToSequencer(sequencerUrl, j.raw));

      try {
        const hash = await Promise.any(attempts);
        return { ...j, ok: true, hash, label };
      } catch (e) {
        const err = e?.errors?.[0] ?? e;
        return { ...j, ok: false, error: revertReason(err), label };
      }
    })
  );
  return sent;
}

export async function collect(provider, sent, { timeoutMs = 60000, confirmations = 1 } = {}) {
  return Promise.all(
    sent.map(async (s) => {
      if (!s.ok) return { ...s, mined: false };
      try {
        const rc = await provider.waitForTransaction(s.hash, confirmations, timeoutMs);
        if (!rc) return { ...s, mined: false, error: `tidak ter-mine dalam ${timeoutMs}ms` };
        return {
          ...s, mined: true, success: rc.status === 1,
          blockNumber: rc.blockNumber, gasUsed: rc.gasUsed,
          error: rc.status === 1 ? undefined : 'tx reverted on-chain',
        };
      } catch (e) {
        return { ...s, mined: false, error: revertReason(e) };
      }
    })
  );
}

export async function snipe({ provider, providers, wallets, cfg, chain, onEvent = () => {} }) {
  const bundle = await preflight({ provider, wallets, cfg, chain, quiet: cfg.json });
  onEvent({ type: 'armed', bundle });

  let firePlan = { mode: 'plain', sendAt: null, arrivalMs: null };
  if (bundle.openAtMs) {
    firePlan = firstSendAt(bundle, cfg);
    let target = firePlan.sendAt;
    const waitMs = target - Date.now();
    onEvent({
      type: 'waiting', openAtMs: bundle.openAtMs, waitMs, source: bundle.scheduleSource,
      fireAt: target, mode: firePlan.mode, arrivalMs: firePlan.arrivalMs,
      boundaryOffsetMs: bundle.boundaryOffsetMs, boundarySource: bundle.boundarySource,
      latencyMs: bundle.latencyMs, seqLatencyMs: bundle.seqLatencyMs,
    });
    if (waitMs > 0) {
      if (waitMs > 45000) {
        await sleepUntil(target - 30000, 0, (r) => onEvent({ type: 'countdown', remainingMs: r }));
        const [lat2, b2, s2] = await Promise.all([
          measureRpcLatency(provider, 7),
          measureBoundaryRobust(provider, chain.feed, {
            rpc: { timeoutMs: 1500, samples: 3 },
            feed: { seconds: 4, drainTimeoutMs: 6000 },
          }),
          measureSequencerLatency(chain.sequencer, 5),
        ]);
        if (b2.ok) { bundle.boundaryOffsetMs = b2.boundaryOffsetMs; bundle.boundarySource = b2.source; }
        bundle.latencyMs = lat2.medianMs;
        if (s2.medianMs) bundle.seqLatencyMs = s2.medianMs;
        firePlan = firstSendAt(bundle, cfg);
        target = firePlan.sendAt;
        onEvent({
          type: 'resync', fireAt: target, mode: firePlan.mode, arrivalMs: firePlan.arrivalMs,
          boundaryOffsetMs: bundle.boundaryOffsetMs, boundarySource: bundle.boundarySource,
          latencyMs: bundle.latencyMs, seqLatencyMs: bundle.seqLatencyMs,
        });
      }

      const warmTargets = [
        ...providers.map((p, i) => ({ label: `rpc${i + 1}`, provider: p })),
        ...(chain.sequencer ? [{ label: 'sequencer', url: chain.sequencer }] : []),
      ];

      const deepWarmAt = target - 6000;
      if (deepWarmAt > Date.now()) {
        await sleepUntil(deepWarmAt, 0);
        onEvent({ type: 'warmed', warm: await warmConnections(warmTargets, { rounds: 2, deadlineMs: target - 2500 }) });
      }

      const topUpAt = target - 900;
      if (topUpAt > Date.now()) {
        await sleepUntil(topUpAt, 0);
        warmConnections(warmTargets, { rounds: 1, deadlineMs: target - 150 })
          .then((warm) => onEvent({ type: 'warmed', warm }))
          .catch(() => {});
      }

      await sleepUntil(target, 0);
    }
  } else {
    onEvent({ type: 'polling', intervalMs: Number(cfg.pollIntervalMs ?? 250) });
    const probe = bundle.armed[0];
    const deadline = Date.now() + Number(cfg.pollTimeoutMs ?? 3600_000);
    for (;;) {
      const sim = await simulate(provider, {
        from: probe.wallet.address, to: probe.plan.to,
        data: probe.plan.data, value: probe.plan.value,
      });
      if (sim.ok) break;
      if (Date.now() > deadline) throw new Error('Timeout: mint tidak kunjung buka.');
      await sleep(Number(cfg.pollIntervalMs ?? 250));
    }
  }

  onEvent({ type: 'firing', at: new Date().toISOString(), txCount: bundle.totalTx, mode: firePlan.mode });
  const t0 = Date.now();
  let sent = await fireWaveOne({ providers, bundle, cfg, chain, plan: firePlan, onEvent });
  onEvent({ type: 'sent', wave: 1, elapsedMs: Date.now() - t0, sent });

  if (cfg.dryRun) {
    return {
      bundle, waves: 1, stats: null, dryRun: true,
      results: sent.map((s) => ({ ...s, mined: false, success: false, error: 'dry-run: tidak dikirim' })),
    };
  }

  let results = await collect(provider, sent, {
    timeoutMs: Number(cfg.waitTimeoutMs ?? 60000),
    confirmations: Number(cfg.confirmations ?? 1),
  });

  const retryWindowMs = Number(cfg.retryWindowMs ?? 20000);
  const retryDelayMs = Number(cfg.retryDelayMs ?? 1000);
  const deadline = Date.now() + retryWindowMs;
  let wave = 1;
  while (!results.some((r) => r.success) && Date.now() < deadline) {
    if (bundle.profile.seadrop) {
      let alreadyDone = false;
      for (const a of bundle.armed) {
        if (a.mintedBefore === null || a.mintedBefore === undefined) continue;
        const st = await readMintStats(provider, bundle.address, a.wallet.address);
        if (st && st.minterNumMinted > a.mintedBefore) {
          onEvent({ type: 'already-minted', wallet: a.wallet.address, before: a.mintedBefore, now: st.minterNumMinted });
          alreadyDone = true;
        }
      }
      if (alreadyDone) break;
    }
    const unresolved = results.filter((r) => r.hash && !r.success);
    if (unresolved.length) {
      let landed = false;
      for (const u of unresolved) {
        const rc = await provider.getTransactionReceipt(u.hash).catch(() => null);
        if (rc && rc.status === 1) {
          u.success = true; u.mined = true; u.blockNumber = rc.blockNumber;
          landed = true;
        }
      }
      if (landed) {
        onEvent({ type: 'sudah-mendarat', note: 'tx gelombang sebelumnya ternyata sukses; berhenti' });
        break;
      }
    }
    wave++;
    await sleep(retryDelayMs);
    const perWallet = Math.max(1, Number(cfg.txPerWallet ?? 1));
    for (const a of bundle.armed) {
      const nonce = await a.wallet.getNonce('pending');
      a.signed = [];
      bundle.fees = await buildFees(provider, cfg).catch(() => bundle.fees);
      for (let k = 0; k < perWallet; k++) {
        a.signed.push(await a.wallet.signTransaction({
          chainId: chain.chainId,
          to: a.plan.to, data: a.plan.data, value: a.plan.value,
          gasLimit: bundle.gasLimit, nonce: nonce + k, ...bundle.fees,
        }));
      }
    }
    sent = await fire(providers, bundle, { label: `wave-${wave}`, sequencerUrl: chain.sequencer });
    onEvent({ type: 'sent', wave, sent });
    const more = await collect(provider, sent, {
      timeoutMs: Number(cfg.waitTimeoutMs ?? 60000),
      confirmations: Number(cfg.confirmations ?? 1),
    });
    results = results.concat(more);
  }

  const stats = bundle.profile.seadrop
    ? await readMintStats(provider, bundle.address, bundle.armed[0].wallet.address)
    : null;

  return { bundle, results, stats, waves: wave };
}

export function firstSendAt(bundle, cfg) {
  const startSec = Math.floor(bundle.openAtMs / 1000);
  const leadMs = Number(cfg.leadMs ?? 0);
  const haveSeq = Number.isFinite(bundle.seqLatencyMs) && bundle.seqLatencyMs > 0;
  const conditional = cfg.conditional === true && bundle.conditionalOk && haveSeq;
  if (conditional) {
    const arrivalMs = computeArrivalAt(startSec, { boundaryOffsetMs: bundle.boundaryOffsetMs, leadMs });
    const burstLeadMs = Number(cfg.burstLeadMs ?? 50);
    return { mode: 'conditional', arrivalMs, sendAt: arrivalMs + burstLeadMs - bundle.seqLatencyMs / 2, startSec };
  }
  const safetyMs = Number(cfg.safetyMs ?? 40);
  const arrivalMs = computeArrivalAt(startSec, { boundaryOffsetMs: bundle.boundaryOffsetMs, leadMs: leadMs + safetyMs });
  const networkOneWay = haveSeq ? bundle.seqLatencyMs / 2 : (bundle.latencyMs ?? 60) / 2;
  const deliveryMs = Number.isFinite(bundle.deliveryMs) && bundle.deliveryMs > 0 ? bundle.deliveryMs : networkOneWay;
  return { mode: 'plain', arrivalMs, startSec, sendAt: arrivalMs - deliveryMs, deliveryMs };
}

export async function fireWaveOne({ providers, bundle, cfg, chain, plan, onEvent = () => {} }) {
  if (cfg.dryRun || plan.mode !== 'conditional') {
    return fire(providers, bundle, { label: 'wave-1', dryRun: cfg.dryRun, sequencerUrl: chain.sequencer });
  }
  const jobs = [];
  for (const a of bundle.armed) for (const raw of a.signed) jobs.push({ wallet: a.wallet.address, raw });
  const perJobInflight = Math.max(1, Math.floor(Number(cfg.burstMaxInflight ?? 3) / Math.max(1, jobs.length)));
  const bursts = await Promise.all(jobs.map((job) =>
    conditionalSpray(chain.sequencer, job.raw, plan.startSec, {
      startAtMs: null,
      intervalMs: Number(cfg.burstIntervalMs ?? 150),
      windowMs: Number(cfg.burstWindowMs ?? 1500),
      maxInflight: perJobInflight,
    }).then((r) => ({ job, r }))
  ));
  const sent = [];
  const fallback = [];
  for (const { job, r } of bursts) {
    if (r.accepted) {
      sent.push({
        ...job, ok: true, hash: r.accepted.hash, label: 'wave-1-cond',
        shots: r.shots, rejected: r.rejected, sentAtMs: r.accepted.sentAtMs, acceptedAtMs: r.accepted.acceptedAtMs,
      });
    } else fallback.push(job);
  }
  onEvent({
    type: 'burst', accepted: sent.length, fallback: fallback.length,
    detail: bursts.map(({ job, r }) => ({
      wallet: job.wallet, shots: r.shots, rejected: r.rejected, errors: r.errors,
      accepted: Boolean(r.accepted), lastReason: r.lastReason,
      sentAtMs: r.accepted?.sentAtMs ?? null, acceptedAtMs: r.accepted?.acceptedAtMs ?? null,
    })),
  });
  if (fallback.length) {
    const sub = { armed: fallback.map((job) => ({ wallet: { address: job.wallet }, signed: [job.raw] })) };
    sent.push(...await fire(providers, sub, { label: 'wave-1-plain', sequencerUrl: chain.sequencer }));
  }
  return sent;
}

export function printArmed(bundle, chain) {
  log.step('Sniper siap');
  log.plain(`   kontrak     : ${bundle.address} ${bundle.profile.name ? `(${bundle.profile.name})` : ''}`);
  log.plain(`   target tx   : ${bundle.armed[0].plan.to}`);
  log.plain(`   value/tx    : ${fmtEth(bundle.armed[0].plan.value, chain.currency)}`);
  log.plain(`   gasLimit    : ${bundle.gasLimit}`);
  log.plain(`   maxFee      : ${ethers.formatUnits(bundle.maxFee, 'gwei')} gwei`);
  log.plain(`   wallet siap : ${bundle.armed.length} (${bundle.totalTx} tx sudah ditandatangani)`);
  for (const s of bundle.skipped) log.warn(`   dilewati ${short(s.wallet)}: ${s.reason}`);
  if (bundle.openAtMs) {
    const d = new Date(bundle.openAtMs);
    log.plain(`   buka pada   : ${d.toISOString()} ${c.dim}(${bundle.scheduleSource})${c.reset}`);
  } else {
    log.plain(`   buka pada   : ${c.yellow}tidak diketahui - mode polling simulasi${c.reset}`);
  }
}

export function printResults(res, chain) {
  const ok = res.results.filter((r) => r.success);
  log.step(`Hasil: ${ok.length} sukses / ${res.results.length} tx (${res.waves} gelombang)`);
  for (const r of res.results) {
    const mark = r.success ? `${c.green}OK  ` : `${c.red}FAIL`;
    log.plain(`   ${mark}${c.reset} ${short(r.wallet)} ${r.hash ?? ''} ${r.success ? `block=${r.blockNumber}` : c.dim + (r.error ?? 'reverted') + c.reset}`);
  }
  if (res.stats) {
    log.plain(`   supply sekarang: ${res.stats.currentTotalSupply} / ${res.stats.maxSupply}`);
    log.plain(`   wallet pertama sudah mint: ${res.stats.minterNumMinted}`);
  }
}

export async function conditionalSpray(sequencerUrl, rawTx, timestampMin, {
  startAtMs = null,
  intervalMs = 45,
  windowMs = 1500,
  maxInflight = 6,
  onShot = () => {},
} = {}) {
  if (startAtMs && startAtMs > Date.now()) await sleepUntil(startAtMs, 0);

  const deadline = Date.now() + windowMs;
  const inflight = new Set();
  let accepted = null;
  let shots = 0, rejected = 0, errors = 0, lastReason = null;
  const t0 = Date.now();

  const shoot = async (n) => {
    const s0 = Date.now();
    try {
      const res = await fetch(sequencerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: n, method: 'eth_sendRawTransactionConditional',
          params: [rawTx, { timestampMin }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await res.json();
      if (j.result) {
        if (!accepted) accepted = { hash: j.result, shot: n, sentAtMs: s0, acceptedAtMs: Date.now(), rttMs: Date.now() - s0 };
      } else if (j.error) {
        rejected++;
        lastReason = j.error.message;
        onShot({ n, ok: false, reason: lastReason, rttMs: Date.now() - s0 });
      }
    } catch (e) {
      errors++;
      lastReason = String(e.message);
    }
  };

  while (!accepted && Date.now() < deadline) {
    if (inflight.size < maxInflight) {
      const n = ++shots;
      const pr = shoot(n);
      inflight.add(pr);
      pr.finally(() => inflight.delete(pr));
      await sleep(intervalMs);
    } else {
      await sleep(5);
    }
  }
  await Promise.allSettled([...inflight]);

  return { accepted, shots, rejected, errors, lastReason, elapsedMs: Date.now() - t0 };
}

export async function supportsConditional(sequencerUrl) {
  try {
    const res = await fetch(sequencerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransactionConditional',
        params: ['0x00', { timestampMin: 1 }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    return !(j.error && j.error.code === -32601);
  } catch { return false; }
}
