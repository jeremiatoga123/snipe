import { ethers } from 'ethers';
import { detectMint, reportCandidates, buildCalldata } from './detect.js';
import { publicDropStatus, buildSeaDropPlan } from './seadrop.js';
import { log, short } from './util.js';

export function guessKind(sig) {
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  const parts = inner ? inner.split(',') : [];
  if (parts.length === 0) return 'none';
  if (parts.length === 1) return parts[0].trim() === 'address' ? 'to' : 'qty';
  if (parts.length === 2) {
    if (parts[0].trim() === 'address') return 'to_qty';
    if (parts[1].trim() === 'address') return 'qty_to';
    return 'id_qty';
  }
  if (parts.length === 3 && parts[0].trim() === 'address') return 'to_id_qty';
  if (parts.length === 6) return 'tw_claim';
  throw new Error(`Tidak bisa menebak bentuk argumen untuk ${sig}, isi "sigKind" di config.`);
}

export async function makePlan(provider, cfg, chain, profile, fromAddress, opts = {}) {
  const qty = BigInt(cfg.quantity ?? 1);
  const tokenId = BigInt(cfg.tokenId ?? 0);
  const to = ethers.getAddress(cfg.contract);

  if (cfg.mode === 'raw' || cfg.data) {
    if (!cfg.data) throw new Error('mode raw butuh "data" (input data hex dari tx mint).');
    const value = cfg.value ? ethers.parseEther(String(cfg.value)) : 0n;
    return {
      to: cfg.rawTo ? ethers.getAddress(cfg.rawTo) : to,
      data: cfg.data,
      value,
      how: 'raw calldata',
    };
  }

  if (cfg.sig) {
    const kind = cfg.sigKind || guessKind(cfg.sig);
    const data = buildCalldata({ sig: cfg.sig, kind }, {
      to: fromAddress,
      quantity: qty,
      tokenId,
      pricePerToken: profile?.thirdweb?.pricePerToken ?? profile?.price?.value ?? 0n,
    });
    const value = cfg.value !== undefined
      ? ethers.parseEther(String(cfg.value))
      : (profile?.price?.value ?? 0n) * qty;
    return { to, data, value, how: `manual ${cfg.sig}` };
  }

  if (profile?.seadrop) {
    const st = publicDropStatus(profile.seadrop);
    if (st.open || opts.ignoreSchedule) {
      const plan = buildSeaDropPlan(profile.seadrop, { minter: fromAddress, quantity: qty });
      return {
        ...plan,
        scheduled: true,
        startTime: profile.seadrop.publicDrop.startTime,
        endTime: profile.seadrop.publicDrop.endTime,
        how: `${plan.how} (SeaDrop ${short(profile.seadrop.address)})`,
      };
    }
    if (!cfg._quiet) {
      log.warn(`SeaDrop public drop belum bisa dipakai: ${st.reason}`);
      if (st.startsIn) {
        log.warn(`Jendelanya baru buka ${st.startsIn} detik lagi - pakai perintah "snipe" untuk menunggunya.`);
      }
    }
    return null;
  }

  const results = await detectMint(provider, profile, {
    from: fromAddress,
    quantity: qty,
    tokenId,
    extraPrices: cfg.tryPrices || [],
  });
  if (!cfg._quiet) reportCandidates(profile, results, chain.currency);
  if (!results.length) return null;

  const pick = (cfg.preferSig && results.find((r) => r.sig === cfg.preferSig)) || results[0];
  return {
    to,
    data: pick.data,
    value: pick.value,
    gasLimit: pick.gas ? (pick.gas * 13n) / 10n : undefined,
    how: `auto ${pick.sig} @ ${ethers.formatEther(pick.value)} ${chain.currency}`,
  };
}
