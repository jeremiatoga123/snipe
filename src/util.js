import { ethers } from 'ethers';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const ts = () => new Date().toISOString().slice(11, 23);

let sink = (...a) => console.log(...a);
export function setLogSink(fn) { sink = fn; }

export const log = {
  info: (...a) => sink(`${C.gray}[${ts()}]${C.reset}`, ...a),
  ok: (...a) => sink(`${C.gray}[${ts()}]${C.reset} ${C.green}OK${C.reset}`, ...a),
  warn: (...a) => sink(`${C.gray}[${ts()}]${C.reset} ${C.yellow}!${C.reset}`, ...a),
  err: (...a) => sink(`${C.gray}[${ts()}]${C.reset} ${C.red}ERR${C.reset}`, ...a),
  step: (...a) => sink(`\n${C.bold}${C.cyan}>>${C.reset} ${C.bold}${a.join(' ')}${C.reset}`),
  plain: (...a) => sink(...a),
};

export function toJSON(value, space) {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}
export const c = C;

export function selectorOf(sig) {
  return ethers.id(sig).slice(0, 10);
}

export function fnName(sig) {
  return sig.slice(0, sig.indexOf('('));
}

export function fnArgs(sig) {
  const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
  if (!inner) return [];
  const out = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(' ) depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function iface(sig, outputs = []) {
  const outs = outputs.length ? ` returns (${outputs.join(',')})` : '';
  return new ethers.Interface([`function ${sig}${outs}`]);
}

export function fmtEth(wei, symbol = 'ETH') {
  return `${ethers.formatEther(wei ?? 0n)} ${symbol}`;
}

export function short(addr) {
  return addr ? `${addr.slice(0, 6)}..${addr.slice(-4)}` : '-';
}

export function revertReason(e) {
  const cands = [
    e?.revert?.args?.[0],
    e?.shortMessage,
    e?.info?.error?.message,
    e?.error?.message,
    e?.reason,
    e?.message,
  ].filter(Boolean);
  let msg = cands[0] || 'unknown error';
  const data = e?.data ?? e?.info?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    try {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10));
      msg = reason;
    } catch {}
  } else if (typeof data === 'string' && data.length >= 10 && data !== '0x') {
    msg = `${msg} (custom error ${data.slice(0, 10)})`;
  }
  return String(msg).slice(0, 220);
}
