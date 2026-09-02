export const CHAINS = {
  robinhood: {
    name: 'Robinhood Chain',
    chainId: 4663,
    rpc: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: 'https://robinhoodchain.blockscout.com',
    explorerApi: 'https://robinhoodchain.blockscout.com/api',
    currency: 'ETH',
    alchemy: "robinhood-mainnet",
    sequencer: 'https://sequencer.mainnet.chain.robinhood.com',
  },
  'robinhood-testnet': {
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpc: ['https://rpc.testnet.chain.robinhood.com'],
    explorer: '',
    explorerApi: '',
    currency: 'ETH',
  },
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    rpc: ['https://eth.llamarpc.com'],
    explorer: 'https://etherscan.io',
    explorerApi: 'https://api.etherscan.io/api',
    currency: 'ETH',
    alchemy: "eth-mainnet",
  },
  base: {
    name: 'Base',
    chainId: 8453,
    rpc: ['https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    explorerApi: 'https://api.basescan.org/api',
    currency: 'ETH',
    alchemy: "base-mainnet",
  },
  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    rpc: ['https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    explorerApi: 'https://api.arbiscan.io/api',
    currency: 'ETH',
    alchemy: "arb-mainnet",
  },
  optimism: {
    name: 'OP Mainnet', chainId: 10,
    rpc: ['https://mainnet.optimism.io'],
    explorer: 'https://optimistic.etherscan.io', explorerApi: '',
    currency: 'ETH', alchemy: 'opt-mainnet',
  },
  polygon: {
    name: 'Polygon', chainId: 137,
    rpc: ['https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com', explorerApi: '',
    currency: 'POL', alchemy: 'polygon-mainnet',
  },
  zora: {
    name: 'Zora', chainId: 7777777,
    rpc: ['https://rpc.zora.energy'],
    explorer: 'https://explorer.zora.energy', explorerApi: '',
    currency: 'ETH', alchemy: 'zora-mainnet',
  },
};

export function alchemyKeyFrom(url) {
  const m = String(url || '').match(/^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]+)/i);
  return m ? { network: m[1], key: m[2] } : null;
}

export function alchemyUrlFor(chainKey, key) {
  const sub = CHAINS[chainKey]?.alchemy;
  return sub ? `https://${sub}.g.alchemy.com/v2/${key}` : null;
}

export function resolveChain(cfg) {
  const base = CHAINS[cfg.chain] || CHAINS.robinhood;
  const supplied = [].concat(cfg.rpc || []).filter(Boolean);

  const kept = [];
  const unusable = [];
  let derived = null;
  for (const u of supplied) {
    const a = alchemyKeyFrom(u);
    if (!a) {
      if (cfg.chain === undefined || cfg.chain === 'robinhood') kept.push(u);
      else unusable.push(u);
      continue;
    }
    if (base.alchemy && a.network.toLowerCase() === base.alchemy.toLowerCase()) kept.push(u);
    else if (base.alchemy && !derived) derived = alchemyUrlFor(cfg.chain, a.key);
  }

  const rpc = [...kept, ...(derived ? [derived] : []), ...base.rpc].filter(Boolean);
  return {
    ...base,
    ...(cfg.chainId ? { chainId: cfg.chainId } : {}),
    rpc: [...new Set(rpc)],
    rpcDerivedFromAlchemyKey: Boolean(derived),
    rpcIgnoredForThisChain: unusable,
  };
}
