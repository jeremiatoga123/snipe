import { ethers } from 'ethers';
import { log, c, sleep, revertReason, fmtEth, short } from './util.js';
import { simulate } from './detect.js';
import { sendToSequencer } from './sniper.js';

export async function buildFees(provider, cfg) {
  const mult = Number(cfg.gasMultiplier ?? 1.25);
  const scale = (v) => (v === null || v === undefined ? null : (BigInt(v) * BigInt(Math.round(mult * 100))) / 100n);
  const fd = await provider.getFeeData();

  if (cfg.maxFeeGwei) {
    return {
      maxFeePerGas: ethers.parseUnits(String(cfg.maxFeeGwei), 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits(String(cfg.priorityFeeGwei ?? 0.01), 'gwei'),
    };
  }
  if (fd.maxFeePerGas) {
    const prio = cfg.priorityFeeGwei
      ? ethers.parseUnits(String(cfg.priorityFeeGwei), 'gwei')
      : scale(fd.maxPriorityFeePerGas ?? 1000000n);
    return { maxFeePerGas: scale(fd.maxFeePerGas), maxPriorityFeePerGas: prio };
  }
  return { gasPrice: scale(fd.gasPrice ?? 1000000n) };
}

export async function sendMint(wallet, plan, cfg, ctx = {}) {
  const provider = wallet.provider;
  const tag = `${c.blue}${short(wallet.address)}${c.reset}${ctx.label ? ` ${c.dim}${ctx.label}${c.reset}` : ''}`;
  const attempts = Number(cfg.retries ?? 3);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (cfg.simulateBeforeSend !== false) {
        const sim = await simulate(provider, {
          from: wallet.address, to: plan.to, data: plan.data, value: plan.value,
        });
        if (!sim.ok) {
          log.err(`${tag} simulasi gagal: ${sim.error}`);
          if (/insufficient funds/i.test(sim.error)) return { ok: false, error: sim.error };
          if (attempt < attempts) { await sleep(Number(cfg.retryDelayMs ?? 1500)); continue; }
          return { ok: false, error: sim.error };
        }
        if (sim.gas && !plan.gasLimit) {
          plan.gasLimit = (sim.gas * BigInt(Math.round(Number(cfg.gasLimitMultiplier ?? 1.3) * 100))) / 100n;
        }
      }

      const fees = await buildFees(provider, cfg);
      const tx = {
        to: plan.to,
        data: plan.data,
        value: plan.value,
        gasLimit: plan.gasLimit ?? BigInt(cfg.gasLimit ?? 500000),
        ...fees,
      };
      if (ctx.nonce !== undefined) tx.nonce = ctx.nonce;

      const maxFee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
      const needed = tx.gasLimit * maxFee + (tx.value ?? 0n);
      const balance = await provider.getBalance(wallet.address);
      if (balance < needed) {
        const msg =
          `saldo kurang: butuh ~${ethers.formatEther(needed)} ` +
          `(gas ${tx.gasLimit} x ${ethers.formatUnits(maxFee, 'gwei')} gwei` +
          `${tx.value ? ` + harga ${ethers.formatEther(tx.value)}` : ''}), ` +
          `punya ${ethers.formatEther(balance)}`;
        log.err(`${tag} ${msg}`);
        return { ok: false, error: msg };
      }

      let sent;
      if (cfg.sequencerUrl) {
        const populated = await wallet.populateTransaction(tx);
        const raw = await wallet.signTransaction(populated);
        const hash = await Promise.any([
          provider.broadcastTransaction(raw).then((r) => r.hash),
          sendToSequencer(cfg.sequencerUrl, raw),
        ]).catch((e) => { throw (e?.errors?.[0] ?? e); });
        sent = { hash, wait: (c1, t1) => provider.waitForTransaction(hash, c1, t1) };
      } else {
        sent = await wallet.sendTransaction(tx);
      }
      log.info(`${tag} tx terkirim ${c.dim}${sent.hash}${c.reset}`);

      try {
        const rc = await sent.wait(Number(cfg.confirmations ?? 1), Number(cfg.waitTimeoutMs ?? 120000));
        if (rc && rc.status === 1) {
          log.ok(`${tag} MINT SUKSES  block=${rc.blockNumber} gasUsed=${rc.gasUsed}`);
          return { ok: true, hash: sent.hash, receipt: rc };
        }
        if (!rc) {
          log.warn(`${tag} receipt belum datang, tx masih di mempool: ${sent.hash}`);
          return { ok: false, hash: sent.hash, pending: true, error: 'timeout menunggu receipt (tx SUDAH tersiar, jangan kirim ulang)' };
        }
        log.err(`${tag} tx reverted on-chain: ${sent.hash}`);
        return { ok: false, error: 'reverted', hash: sent.hash };
      } catch (waitErr) {
        log.warn(`${tag} gagal menunggu receipt: ${revertReason(waitErr)}`);
        return { ok: false, hash: sent.hash, pending: true, error: `tx tersiar, hasil belum diketahui: ${revertReason(waitErr)}` };
      }
    } catch (e) {
      const msg = revertReason(e);
      log.err(`${tag} percobaan ${attempt}/${attempts} gagal: ${msg}`);
      if (/insufficient funds/i.test(msg)) return { ok: false, error: msg };
      if (attempt < attempts) await sleep(Number(cfg.retryDelayMs ?? 1500));
      else return { ok: false, error: msg };
    }
  }
  return { ok: false, error: 'kehabisan percobaan' };
}

export async function runMint(wallets, planFor, cfg, symbol = 'ETH') {
  const perWallet = Number(cfg.txPerWallet ?? 1);
  const results = [];

  const jobs = [];
  for (const w of wallets) {
    for (let n = 0; n < perWallet; n++) {
      jobs.push({ wallet: w, index: n });
    }
  }

  if (cfg.parallel === false) {
    for (const j of jobs) {
      const plan = await planFor(j.wallet, j.index);
      results.push({ wallet: j.wallet.address, ...(await sendMint(j.wallet, plan, cfg, { label: `#${j.index + 1}` })) });
      if (cfg.delayMs) await sleep(Number(cfg.delayMs));
    }
  } else {
    const byWallet = new Map();
    for (const j of jobs) {
      if (!byWallet.has(j.wallet.address)) byWallet.set(j.wallet.address, []);
      byWallet.get(j.wallet.address).push(j);
    }
    const settled = await Promise.all(
      [...byWallet.values()].map(async (list) => {
        const out = [];
        let nonce = await list[0].wallet.getNonce('pending');
        for (const j of list) {
          const plan = await planFor(j.wallet, j.index);
          const r = await sendMint(j.wallet, plan, cfg, { label: `#${j.index + 1}`, nonce });
          out.push({ wallet: j.wallet.address, ...r });
          if (r.hash) nonce++;
          if (cfg.delayMs) await sleep(Number(cfg.delayMs));
        }
        return out;
      })
    );
    results.push(...settled.flat());
  }

  const ok = results.filter((r) => r.ok).length;
  log.step(`Selesai: ${c.green}${ok} sukses${c.reset} / ${results.length - ok} gagal dari ${results.length} tx`);
  for (const r of results) {
    log.plain(`   ${r.ok ? c.green + 'OK  ' : c.red + 'FAIL'}${c.reset} ${short(r.wallet)} ${r.hash ?? ''} ${r.ok ? '' : c.dim + (r.error ?? '') + c.reset}`);
  }
  return results;
}
