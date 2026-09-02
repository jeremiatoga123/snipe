import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { SEADROP_CANONICAL, SEADROP_ABI } from './seadrop.js';
import { log, c } from './util.js';

const PUBLIC_DROP_UPDATED = ethers.id(
  'PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))'
);

const NFT_ABI = new ethers.Interface([
  'function name() view returns (string)',
  'function getMintStats(address) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
]);

export async function collectDropContracts(provider, {
  seadrop = SEADROP_CANONICAL,
  blocks = 2_000_000,
  chunk = 500_000,
  cacheFile,
} = {}) {
  const latest = await provider.getBlockNumber();
  let cache = { fromBlock: 0, toBlock: 0, contracts: [] };
  if (cacheFile && fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  }

  const known = new Set(cache.contracts || []);
  const start = cache.toBlock && cache.toBlock > latest - blocks
    ? cache.toBlock + 1
    : Math.max(0, latest - blocks);

  for (let b = start; b <= latest; b += chunk) {
    const to = Math.min(b + chunk - 1, latest);
    try {
      const logs = await provider.getLogs({
        address: seadrop, topics: [PUBLIC_DROP_UPDATED], fromBlock: b, toBlock: to,
      });
      for (const l of logs) known.add(ethers.getAddress('0x' + l.topics[1].slice(26)));
    } catch (e) {
      log.warn(`getLogs ${b}-${to} gagal: ${(e.shortMessage || e.message).slice(0, 80)}`);
    }
  }

  const contracts = [...known];
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fromBlock: start, toBlock: latest, contracts }));
  }
  return { contracts, latest };
}

export async function checkDrops(provider, contracts, {
  seadrop = SEADROP_CANONICAL,
  concurrency = 25,
  withNames = true,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const live = [];
  const upcoming = [];
  const queue = [...contracts];

  const worker = async () => {
    while (queue.length) {
      const nft = queue.shift();
      try {
        const res = await provider.call({
          to: seadrop, data: SEADROP_ABI.encodeFunctionData('getPublicDrop', [nft]),
        });
        const d = SEADROP_ABI.decodeFunctionResult('getPublicDrop', res)[0];
        const startTime = Number(d.startTime);
        const endTime = Number(d.endTime);
        if (!endTime) continue;
        if (now > endTime) continue;

        const rec = {
          nft,
          mintPrice: BigInt(d.mintPrice),
          startTime,
          endTime,
          maxPerWallet: Number(d.maxTotalMintableByWallet),
        };
        if (withNames) {
          try {
            const nr = await provider.call({ to: nft, data: NFT_ABI.encodeFunctionData('name') });
            rec.name = NFT_ABI.decodeFunctionResult('name', nr)[0];
          } catch {}
          try {
            const sr = await provider.call({
              to: nft, data: NFT_ABI.encodeFunctionData('getMintStats', [ethers.ZeroAddress]),
            });
            const s = NFT_ABI.decodeFunctionResult('getMintStats', sr);
            rec.supply = BigInt(s.currentTotalSupply);
            rec.maxSupply = BigInt(s.maxSupply);
          } catch {}
        }
        (now >= startTime ? live : upcoming).push(rec);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const byPrice = (a, b) => (a.mintPrice < b.mintPrice ? -1 : a.mintPrice > b.mintPrice ? 1 : 0);
  live.sort(byPrice);
  upcoming.sort((a, b) => a.startTime - b.startTime);
  return { live, upcoming };
}

export function printDrops({ live, upcoming }, opts = {}) {
  const sym = opts.currency || 'ETH';
  const max = Number(opts.limit ?? 25);

  const row = (d, showStart) => {
    const sup = d.maxSupply ? `${d.supply}/${d.maxSupply}` : '?';
    const full = d.maxSupply && d.supply >= d.maxSupply;
    const when = showStart
      ? `mulai ${new Date(d.startTime * 1000).toISOString().slice(0, 16).replace('T', ' ')}`
      : `s/d ${new Date(d.endTime * 1000).toISOString().slice(0, 16).replace('T', ' ')}`;
    const price = ethers.formatEther(d.mintPrice);
    const priceTag = d.mintPrice === 0n ? `${c.green}GRATIS${c.reset}` : `${price} ${sym}`;
    log.plain(
      `   ${d.nft}  ${priceTag.padEnd(24)} limit ${String(d.maxPerWallet).padEnd(5)}` +
        ` ${full ? c.red + 'SOLD OUT' + c.reset : sup.padEnd(12)} ${c.dim}${when}${c.reset}  ${d.name ?? ''}`
    );
  };

  log.step(`Drop AKTIF sekarang: ${live.length}`);
  const shown = opts.freeOnly ? live.filter((d) => d.mintPrice === 0n) : live;
  const notFull = shown.filter((d) => !(d.maxSupply && d.supply >= d.maxSupply));
  for (const d of notFull.slice(0, max)) row(d, false);
  if (notFull.length > max) log.plain(`   ${c.dim}... dan ${notFull.length - max} lagi${c.reset}`);

  log.step(`Drop AKAN DATANG: ${upcoming.length}`);
  for (const d of upcoming.slice(0, Math.min(10, max))) row(d, true);

  if (notFull.length) {
    log.ok(`Mint salah satu: node src/index.js mint --contract ${notFull[0].nft} --qty 1`);
  }
}
