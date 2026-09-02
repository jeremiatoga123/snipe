import { ethers } from 'ethers';
import { fnName, revertReason, log, c } from './util.js';

const ZERO = ethers.ZeroAddress;
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export function buildCalldata({ sig, kind }, { to, quantity, tokenId = 0n, pricePerToken = 0n }) {
  const i = new ethers.Interface([`function ${sig} payable`]);
  const name = fnName(sig);
  const q = BigInt(quantity);
  switch (kind) {
    case 'qty': return i.encodeFunctionData(sig, [q]);
    case 'to_qty': return i.encodeFunctionData(sig, [to, q]);
    case 'qty_to': return i.encodeFunctionData(sig, [q, to]);
    case 'to': return i.encodeFunctionData(sig, [to]);
    case 'none': return i.encodeFunctionData(sig, []);
    case 'id_qty': return i.encodeFunctionData(sig, [BigInt(tokenId), q]);
    case 'to_id_qty': return i.encodeFunctionData(sig, [to, BigInt(tokenId), q]);
    case 'tw_claim':
      return i.encodeFunctionData(sig, [
        to, q, NATIVE, pricePerToken,
        [[], ethers.MaxUint256, 0n, NATIVE],
        '0x',
      ]);
    default:
      throw new Error(`kind tidak dikenal: ${kind} (${name})`);
  }
}

export async function simulate(provider, { from, to, data, value }) {
  try {
    await provider.call({ from, to, data, value });
    let gas = null;
    try {
      gas = await provider.estimateGas({ from, to, data, value });
    } catch {}
    return { ok: true, gas };
  } catch (e) {
    return { ok: false, error: revertReason(e) };
  }
}

export async function detectMint(provider, profile, { from, quantity = 1n, tokenId = 0n, extraPrices = [] }) {
  const unit = profile.price?.value ?? null;
  const q = BigInt(quantity);

  const priceCandidates = [];
  const push = (v, label) => {
    if (v === null || v === undefined) return;
    const bv = BigInt(v);
    if (!priceCandidates.some((p) => p.value === bv)) priceCandidates.push({ value: bv, label });
  };
  push(0n, 'gratis');
  if (unit !== null) {
    push(unit * q, `${profile.price.sig} x qty`);
    push(unit, `${profile.price.sig} (flat)`);
  }
  if (profile.thirdweb) push(profile.thirdweb.pricePerToken * q, 'claimCondition x qty');
  for (const p of extraPrices) push(ethers.parseEther(String(p)), `manual ${p}`);

  const results = [];
  for (const cand of profile.mintCandidates) {
    for (const price of priceCandidates) {
      let data;
      try {
        data = buildCalldata(cand, {
          to: from,
          quantity: q,
          tokenId,
          pricePerToken: profile.thirdweb?.pricePerToken ?? unit ?? 0n,
        });
      } catch { continue; }
      const sim = await simulate(provider, { from, to: profile.address, data, value: price.value });
      if (sim.ok) {
        results.push({ ...cand, data, value: price.value, priceLabel: price.label, gas: sim.gas });
        break;
      }
      results.lastError = sim.error;
      cand.lastError = sim.error;
    }
  }
  results.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return results;
}

export function reportCandidates(profile, results, symbol = 'ETH') {
  if (!profile.mintCandidates.length) {
    log.warn('Tidak ada selector mint yang cocok di bytecode.');
    log.warn('Pakai mode "raw": copy input data dari tx mint yang sukses di explorer.');
    return;
  }
  log.plain(`\n  Kandidat fungsi mint di bytecode (${profile.mintCandidates.length}):`);
  for (const m of profile.mintCandidates) {
    const hit = results.find((r) => r.sig === m.sig);
    if (hit) {
      log.plain(
        `   ${c.green}PASS${c.reset} ${m.sig}  value=${ethers.formatEther(hit.value)} ${symbol}` +
          ` ${c.dim}(${hit.priceLabel}${hit.gas ? `, gas~${hit.gas}` : ''})${c.reset}`
      );
    } else {
      log.plain(`   ${c.red}FAIL${c.reset} ${m.sig}  ${c.dim}${m.lastError ?? ''}${c.reset}`);
    }
  }
}
