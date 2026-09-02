import { log, c } from './util.js';

const CHAIN_SLUG = {
  4663: 'robinhood',
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
};

export async function resolveSlug(slug, chainId) {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) {
    throw new Error(
      'OPENSEA_API_KEY belum diisi di .env. Ambil gratis di https://docs.opensea.io/reference/api-keys'
    );
  }
  const url = `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { 'x-api-key': key, accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenSea API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  const contracts = data.contracts || [];
  const want = CHAIN_SLUG[chainId];
  const match = contracts.find((x) => !want || x.chain === want) || contracts[0];

  return {
    slug,
    name: data.name,
    description: data.description,
    totalSupply: data.total_supply,
    contracts,
    address: match?.address ?? null,
    chain: match?.chain ?? null,
  };
}

export function printCollection(info) {
  log.step(`Koleksi OpenSea: ${info.name ?? info.slug}`);
  log.plain(`   slug     : ${info.slug}`);
  log.plain(`   supply   : ${info.totalSupply ?? '-'}`);
  if (!info.contracts.length) {
    log.warn('OpenSea tidak melaporkan kontrak apa pun untuk koleksi ini.');
    log.warn('Biasanya berarti kontrak belum di-deploy (drop lazy-deploy) atau belum diindeks.');
    return;
  }
  for (const ct of info.contracts) {
    const mark = ct.address === info.address ? `${c.green}<- dipakai${c.reset}` : '';
    log.plain(`   ${ct.chain.padEnd(12)} ${ct.address} ${mark}`);
  }
  log.ok(`Pakai: node src/index.js info --contract ${info.address}`);
}
