
export const MINT_SIGS = [
  { sig: 'mint(uint256)', kind: 'qty' },
  { sig: 'mint(address,uint256)', kind: 'to_qty' },
  { sig: 'mint(uint256,address)', kind: 'qty_to' },
  { sig: 'mint()', kind: 'none' },
  { sig: 'mint(address)', kind: 'to' },
  { sig: 'publicMint(uint256)', kind: 'qty' },
  { sig: 'publicMint(address,uint256)', kind: 'to_qty' },
  { sig: 'publicMint()', kind: 'none' },
  { sig: 'mintPublic(uint256)', kind: 'qty' },
  { sig: 'publicSaleMint(uint256)', kind: 'qty' },
  { sig: 'mintNFT(uint256)', kind: 'qty' },
  { sig: 'mintTo(address,uint256)', kind: 'to_qty' },
  { sig: 'safeMint(address,uint256)', kind: 'to_qty' },
  { sig: 'safeMint(address)', kind: 'to' },
  { sig: 'purchase(uint256)', kind: 'qty' },
  { sig: 'buy(uint256)', kind: 'qty' },
  { sig: 'claim(uint256)', kind: 'qty' },
  { sig: 'claim(address,uint256)', kind: 'to_qty' },
  { sig: 'freeMint(uint256)', kind: 'qty' },
  { sig: 'whitelistMint(uint256)', kind: 'qty' },
  { sig: 'presaleMint(uint256)', kind: 'qty' },
  { sig: 'batchMint(uint256)', kind: 'qty' },
  { sig: 'mintBatch(uint256)', kind: 'qty' },
  { sig: 'mint(uint256,uint256)', kind: 'id_qty' },
  { sig: 'mint(address,uint256,uint256)', kind: 'to_id_qty' },
  { sig: 'claim(uint256,uint256)', kind: 'id_qty' },
  {
    sig: 'claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)',
    kind: 'tw_claim',
  },
  { sig: 'mintPublic(address,address,address,uint256)', kind: 'seadrop' },
];

export const PRICE_SIGS = [
  'mintPrice()',
  'price()',
  'cost()',
  'PRICE()',
  'MINT_PRICE()',
  'publicPrice()',
  'publicMintPrice()',
  'PUBLIC_PRICE()',
  'PUBLIC_MINT_PRICE()',
  'salePrice()',
  'tokenPrice()',
  'getPrice()',
  'getMintPrice()',
  'unitPrice()',
];

export const SUPPLY_SIGS = ['totalSupply()', 'totalMinted()', 'minted()', 'currentTokenId()'];

export const MAXSUPPLY_SIGS = [
  'maxSupply()',
  'MAX_SUPPLY()',
  'maxTotalSupply()',
  'MAX_TOTAL_SUPPLY()',
  'collectionSize()',
  'COLLECTION_SIZE()',
  'maxTokens()',
];

export const MAXPERWALLET_SIGS = [
  'maxPerWallet()',
  'MAX_PER_WALLET()',
  'maxMintPerWallet()',
  'maxPerTx()',
  'MAX_PER_TX()',
  'maxMintAmount()',
  'maxMintPerTx()',
];

export const SALE_BOOL_SIGS = [
  'saleIsActive()',
  'saleActive()',
  'publicSaleActive()',
  'isPublicMintEnabled()',
  'publicMintEnabled()',
  'mintActive()',
  'mintEnabled()',
  'isActive()',
  'live()',
];

export const PAUSED_BOOL_SIGS = ['paused()', 'isPaused()', 'mintPaused()'];

export const META_SIGS = ['name()', 'symbol()', 'owner()'];
