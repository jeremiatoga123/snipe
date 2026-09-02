import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

export function loadWallets(provider, cfg, root) {
  const raw = [];

  const keysFile = path.resolve(root, cfg.keysFile || 'keys.txt');
  if (fs.existsSync(keysFile)) {
    for (const line of fs.readFileSync(keysFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) raw.push(t);
    }
  }
  if (process.env.PRIVATE_KEYS) raw.push(...process.env.PRIVATE_KEYS.split(',').map((s) => s.trim()));
  if (process.env.PRIVATE_KEY) raw.push(process.env.PRIVATE_KEY.trim());

  const seen = new Set();
  const wallets = [];
  for (const k of raw) {
    const key = k.startsWith('0x') ? k : '0x' + k;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(`Private key tidak valid (panjang harus 64 hex): ${key.slice(0, 10)}...`);
    }
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    wallets.push(new ethers.Wallet(key, provider));
  }
  return wallets;
}
