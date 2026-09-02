import { ethers } from 'ethers';
import { selectorOf, iface, log } from './util.js';
import {
  MINT_SIGS, PRICE_SIGS, SUPPLY_SIGS, MAXSUPPLY_SIGS,
  MAXPERWALLET_SIGS, SALE_BOOL_SIGS, PAUSED_BOOL_SIGS,
} from './sigs.js';
import { looksLikeSeaDrop, readSeaDrop, SEADROP_CANONICAL } from './seadrop.js';

export function hasSelector(code, sig) {
  const sel = selectorOf(sig).slice(2).toLowerCase();
  return code.includes(sel);
}

export function parseMinimalProxy(code) {
  const hex = (code.startsWith('0x') ? code.slice(2) : code).toLowerCase();
  const m = hex.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/)
    || hex.match(/3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e/)
    || hex.match(/363d3d373d3d3d363d6f[0-9a-f]{0,64}73([0-9a-f]{40})5af43d/);
  if (!m) return null;
  try {
    const addr = ethers.getAddress('0x' + m[1]);
    return addr === ethers.ZeroAddress ? null : addr;
  } catch {
    return null;
  }
}

export async function resolveImplementation(provider, address, code) {
  const bytecode = code ?? (await provider.getCode(address));
  const clone = parseMinimalProxy(bytecode);
  if (clone) return clone;

  const SLOTS = [
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
    '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  ];
  for (const slot of SLOTS) {
    try {
      const raw = await provider.getStorage(address, slot);
      const addr = ethers.getAddress('0x' + raw.slice(26));
      if (addr !== ethers.ZeroAddress) {
        const code = await provider.getCode(addr);
        if (code && code !== '0x') return addr;
      }
    } catch {}
  }
  return null;
}

export async function tryRead(provider, address, sig, outputs) {
  try {
    const i = iface(sig, outputs);
    const data = i.encodeFunctionData(sig.slice(0, sig.indexOf('(')), []);
    const res = await provider.call({ to: address, data });
    if (!res || res === '0x') return null;
    const dec = i.decodeFunctionResult(sig.slice(0, sig.indexOf('(')), res);
    return dec.length === 1 ? dec[0] : dec;
  } catch {
    return null;
  }
}

async function firstRead(provider, address, sigs, outputs, code) {
  for (const sig of sigs) {
    if (code && !hasSelector(code, sig)) continue;
    const v = await tryRead(provider, address, sig, outputs);
    if (v !== null && v !== undefined) return { sig, value: v };
  }
  return null;
}

export async function scanContract(provider, address, opts = {}) {
  let code = await provider.getCode(address);
  if (!code || code === '0x') throw new Error(`Tidak ada kontrak di ${address} pada chain ini`);

  const impl = await resolveImplementation(provider, address, code);
  let scanCode = code.toLowerCase();
  if (impl) {
    const ic = await provider.getCode(impl);
    scanCode = (code + ic.slice(2)).toLowerCase();
  }

  const out = { address, implementation: impl, codeSize: (code.length - 2) / 2 };

  out.name = (await tryRead(provider, address, 'name()', ['string'])) ?? null;
  out.symbol = (await tryRead(provider, address, 'symbol()', ['string'])) ?? null;
  out.owner = (await tryRead(provider, address, 'owner()', ['address'])) ?? null;

  const supports = async (id) => {
    try {
      const i = iface('supportsInterface(bytes4)', ['bool']);
      const res = await provider.call({
        to: address,
        data: i.encodeFunctionData('supportsInterface', [id]),
      });
      return i.decodeFunctionResult('supportsInterface', res)[0];
    } catch { return false; }
  };
  out.isERC721 = await supports('0x80ac58cd');
  out.isERC1155 = out.isERC721 ? false : await supports('0xd9b67a26');
  out.standard = out.isERC721 ? 'ERC721' : out.isERC1155 ? 'ERC1155' : 'unknown';

  const price = await firstRead(provider, address, PRICE_SIGS, ['uint256'], scanCode);
  out.price = price ? { sig: price.sig, value: BigInt(price.value) } : null;

  const sup = await firstRead(provider, address, SUPPLY_SIGS, ['uint256'], scanCode);
  out.totalSupply = sup ? BigInt(sup.value) : null;

  const max = await firstRead(provider, address, MAXSUPPLY_SIGS, ['uint256'], scanCode);
  out.maxSupply = max ? BigInt(max.value) : null;

  const perw = await firstRead(provider, address, MAXPERWALLET_SIGS, ['uint256'], scanCode);
  out.maxPerWallet = perw ? { sig: perw.sig, value: BigInt(perw.value) } : null;

  out.saleFlags = [];
  for (const sig of SALE_BOOL_SIGS) {
    if (!hasSelector(scanCode, sig)) continue;
    const v = await tryRead(provider, address, sig, ['bool']);
    if (v !== null) out.saleFlags.push({ sig, value: Boolean(v), openWhen: true });
  }
  for (const sig of PAUSED_BOOL_SIGS) {
    if (!hasSelector(scanCode, sig)) continue;
    const v = await tryRead(provider, address, sig, ['bool']);
    if (v !== null) out.saleFlags.push({ sig, value: Boolean(v), openWhen: false });
  }

  out.mintCandidates = MINT_SIGS.filter(
    (m) => m.kind !== 'seadrop' && hasSelector(scanCode, m.sig)
  );

  if (looksLikeSeaDrop(scanCode) || opts.seadrop) {
    out.seadrop = await readSeaDrop(provider, address, opts.seadrop || SEADROP_CANONICAL);
    if (!out.seadrop) {
      log.warn(`Kontrak ini pola SeaDrop tapi ${opts.seadrop || SEADROP_CANONICAL} tidak merespons di chain ini.`);
    }
  }

  if (hasSelector(scanCode, 'getActiveClaimConditionId()')) {
    try {
      const id = await tryRead(provider, address, 'getActiveClaimConditionId()', ['uint256']);
      const i = new ethers.Interface([
        'function getClaimConditionById(uint256) view returns (tuple(uint256 startTimestamp,uint256 maxClaimableSupply,uint256 supplyClaimed,uint256 quantityLimitPerWallet,bytes32 merkleRoot,uint256 pricePerToken,address currency,string metadata))',
      ]);
      const res = await provider.call({
        to: address,
        data: i.encodeFunctionData('getClaimConditionById', [id]),
      });
      const cc = i.decodeFunctionResult('getClaimConditionById', res)[0];
      out.thirdweb = {
        conditionId: BigInt(id),
        startTimestamp: BigInt(cc.startTimestamp),
        maxClaimableSupply: BigInt(cc.maxClaimableSupply),
        supplyClaimed: BigInt(cc.supplyClaimed),
        quantityLimitPerWallet: BigInt(cc.quantityLimitPerWallet),
        merkleRoot: cc.merkleRoot,
        pricePerToken: BigInt(cc.pricePerToken),
        currency: cc.currency,
      };
      if (!out.price) out.price = { sig: 'claimCondition.pricePerToken', value: BigInt(cc.pricePerToken) };
    } catch (e) {
      log.warn('gagal baca claim condition thirdweb:', e.message);
    }
  }

  return out;
}
