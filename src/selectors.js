import { selectorOf } from './util.js';
import {
  MINT_SIGS, PRICE_SIGS, SUPPLY_SIGS, MAXSUPPLY_SIGS,
  MAXPERWALLET_SIGS, SALE_BOOL_SIGS, PAUSED_BOOL_SIGS,
} from './sigs.js';

const PUSH1 = 0x60, PUSH32 = 0x7f, PUSH4 = 0x63;

export function extractSelectors(code) {
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  const bytes = Buffer.from(hex, 'hex');
  const found = new Set();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op >= PUSH1 && op <= PUSH32) {
      const n = op - PUSH1 + 1;
      if (op === PUSH4 && i + 4 < bytes.length) {
        const sel = '0x' + bytes.subarray(i + 1, i + 5).toString('hex');
        if (sel !== '0x00000000' && sel !== '0xffffffff') found.add(sel);
      }
      i += n;
    }
  }
  return [...found];
}

export function localDictionary() {
  const dict = new Map();
  const all = [
    ...MINT_SIGS.map((m) => m.sig),
    ...PRICE_SIGS, ...SUPPLY_SIGS, ...MAXSUPPLY_SIGS,
    ...MAXPERWALLET_SIGS, ...SALE_BOOL_SIGS, ...PAUSED_BOOL_SIGS,
    'name()', 'symbol()', 'owner()', 'tokenURI(uint256)', 'balanceOf(address)',
    'ownerOf(uint256)', 'approve(address,uint256)', 'setApprovalForAll(address,bool)',
    'transferFrom(address,uint256)', 'safeTransferFrom(address,address,uint256)',
    'supportsInterface(bytes4)', 'totalSupply()', 'contractURI()',
    'getAllowedSeaDrop()', 'supportedSeaDrop()', 'getMintStats(address)',
    'multiConfigure((uint256,uint256,string,string,address[],address[],address[],(uint256,uint256,uint256,uint16,uint16,bool),bytes32,string[],string,(address,bytes32,string[]),(address,uint16)[]))',
    'getActiveClaimConditionId()', 'getClaimConditionById(uint256)',
    'claimCondition()', 'setClaimConditions((uint256,uint256,uint256,uint256,bytes32,uint256,address,string)[],bool)',
    'MINTER_ROLE()', 'hasRole(bytes32,address)', 'mintSeaDrop(address,uint256)',
  ];
  for (const sig of all) dict.set(selectorOf(sig), sig);
  return dict;
}

export async function lookup4byte(selectors, { concurrency = 6, timeoutMs = 8000 } = {}) {
  const out = new Map();
  const queue = [...selectors];
  const worker = async () => {
    while (queue.length) {
      const sel = queue.shift();
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(
          `https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`,
          { signal: ctrl.signal }
        );
        clearTimeout(t);
        if (!r.ok) continue;
        const j = await r.json();
        const best = (j.results || []).sort((a, b) => a.id - b.id)[0];
        if (best) out.set(sel, best.text_signature);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
