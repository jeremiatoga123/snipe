import { ethers } from 'ethers';
import { log, c, fmtEth } from './util.js';

export const SEADROP_CANONICAL = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

export const SEADROP_ABI = new ethers.Interface([
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function getCreatorPayoutAddress(address) view returns (address)',
  'function getSigners(address) view returns (address[])',
  'function getAllowListMerkleRoot(address) view returns (bytes32)',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
]);

const MINT_STATS = new ethers.Interface([
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
]);

export function looksLikeSeaDrop(scanCode) {
  const sel = ethers.id('mintSeaDrop(address,uint256)').slice(2, 10);
  return scanCode.includes(sel);
}

export async function readSeaDrop(provider, nft, seadropAddress = SEADROP_CANONICAL) {
  const call = async (fn, args = [nft]) => {
    const res = await provider.call({ to: seadropAddress, data: SEADROP_ABI.encodeFunctionData(fn, args) });
    return SEADROP_ABI.decodeFunctionResult(fn, res);
  };

  const code = await provider.getCode(seadropAddress);
  if (!code || code === '0x') return null;

  const out = { address: seadropAddress, nft };
  try {
    const [d] = await call('getPublicDrop');
    out.publicDrop = {
      mintPrice: BigInt(d.mintPrice),
      startTime: Number(d.startTime),
      endTime: Number(d.endTime),
      maxTotalMintableByWallet: Number(d.maxTotalMintableByWallet),
      feeBps: Number(d.feeBps),
      restrictFeeRecipients: Boolean(d.restrictFeeRecipients),
    };
  } catch { return null; }

  try { out.feeRecipients = (await call('getAllowedFeeRecipients'))[0]; } catch { out.feeRecipients = []; }
  try { out.creatorPayout = (await call('getCreatorPayoutAddress'))[0]; } catch {}
  try { out.signers = (await call('getSigners'))[0]; } catch { out.signers = []; }
  try { out.allowListRoot = (await call('getAllowListMerkleRoot'))[0]; } catch {}

  return out;
}

export async function readMintStats(provider, nft, minter) {
  try {
    const res = await provider.call({
      to: nft,
      data: MINT_STATS.encodeFunctionData('getMintStats', [minter]),
    });
    const r = MINT_STATS.decodeFunctionResult('getMintStats', res);
    return {
      minterNumMinted: BigInt(r.minterNumMinted),
      currentTotalSupply: BigInt(r.currentTotalSupply),
      maxSupply: BigInt(r.maxSupply),
    };
  } catch { return null; }
}

export function publicDropStatus(sd, now = Math.floor(Date.now() / 1000)) {
  const d = sd?.publicDrop;
  if (!d) return { open: false, reason: 'tidak ada konfigurasi public drop' };
  if (d.startTime === 0 && d.endTime === 0) return { open: false, reason: 'public drop tidak diaktifkan (mint via mintSigned/allowlist)' };
  if (now < d.startTime) return { open: false, reason: `belum mulai (mulai ${new Date(d.startTime * 1000).toISOString()})`, startsIn: d.startTime - now };
  if (now > d.endTime) return { open: false, reason: `sudah berakhir (${new Date(d.endTime * 1000).toISOString()})` };
  return { open: true, reason: 'public drop AKTIF' };
}

const SEADROP_ERRORS = new ethers.Interface([
  'error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total,uint256 maxSupply)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total,uint256 maxAllowed)',
  'error IncorrectPayment(uint256 got,uint256 want)',
  'error InvalidSignature(address recoveredSigner)',
  'error SignerNotPresent(address signer,address nftContract)',
  'error FeeRecipientNotAllowed(address got)',
  'error CreatorPayoutAddressCannotBeZeroAddress()',
]);

export async function probePublicMint(provider, sd, from) {
  const d = sd.publicDrop;
  if (!d) return { status: 'no_public_drop', snipeable: false };

  const stats = await readMintStats(provider, sd.nft, from);
  if (stats && stats.maxSupply > 0n && stats.currentTotalSupply >= stats.maxSupply) {
    return {
      status: 'sold_out',
      snipeable: false,
      reason: `sudah habis: ${stats.currentTotalSupply}/${stats.maxSupply}`,
      supply: stats.currentTotalSupply,
      maxSupply: stats.maxSupply,
    };
  }

  const feeRecipient = sd.feeRecipients?.[0] ?? ethers.ZeroAddress;
  const data = SEADROP_ABI.encodeFunctionData('mintPublic', [
    sd.nft, feeRecipient, ethers.ZeroAddress, 1n,
  ]);
  const tx = { from, to: sd.address, data, value: '0x' + d.mintPrice.toString(16) };
  const fakeBalance = (d.mintPrice * 4n) + ethers.parseEther('1');
  const overrides = { [from]: { balance: '0x' + fakeBalance.toString(16) } };

  let raw = null;
  try {
    await provider.send('eth_call', [tx, 'latest', overrides]);
    return { status: 'mintable_now', snipeable: true, reason: 'mintPublic lolos simulasi' };
  } catch (e) {
    raw = e?.data ?? e?.info?.error?.data ?? null;
    if (!raw) {
      try {
        await provider.call(tx);
        return { status: 'mintable_now', snipeable: true, reason: 'mintPublic lolos simulasi' };
      } catch (e2) {
        raw = e2?.data ?? e2?.info?.error?.data ?? null;
      }
    }
  }

  if (typeof raw === 'string' && raw.length >= 10) {
    try {
      const parsed = SEADROP_ERRORS.parseError(raw);
      if (parsed.name === 'NotActive') {
        const [now, start, end] = parsed.args.map(Number);
        return {
          status: now < start ? 'not_open_yet' : 'window_ended',
          snipeable: now < start,
          reason: `NotActive: sekarang ${now}, jendela ${start}-${end}`,
          startsInSec: now < start ? start - now : null,
        };
      }
      if (parsed.name === 'InvalidSignature' || parsed.name === 'SignerNotPresent') {
        return { status: 'signature_required', snipeable: false, reason: parsed.name };
      }
      return { status: 'reverts', snipeable: false, reason: `${parsed.name}(${parsed.args.map(String).join(', ')})` };
    } catch {
      return { status: 'reverts', snipeable: false, reason: `custom error ${raw.slice(0, 10)}` };
    }
  }
  return { status: 'unknown', snipeable: null, reason: 'simulasi tidak mengembalikan data revert' };
}

export function buildSeaDropPlan(sd, { minter, quantity }) {
  const d = sd.publicDrop;
  const feeRecipient = sd.feeRecipients?.[0] ?? ethers.ZeroAddress;
  if (d.restrictFeeRecipients && !sd.feeRecipients?.length) {
    throw new Error('SeaDrop membatasi feeRecipient tapi daftar allowed-nya kosong.');
  }
  const q = BigInt(quantity);
  return {
    to: sd.address,
    data: SEADROP_ABI.encodeFunctionData('mintPublic', [sd.nft, feeRecipient, ethers.ZeroAddress, q]),
    value: d.mintPrice * q,
    how: `SeaDrop mintPublic qty ${q} @ ${ethers.formatEther(d.mintPrice)} /item`,
  };
}

export function printSeaDrop(sd, chain, stats) {
  const sym = chain.currency;
  const d = sd.publicDrop;
  const st = publicDropStatus(sd);
  log.plain(`   ${c.cyan}OpenSea SeaDrop${c.reset} @ ${sd.address}`);
  log.plain(`     status      : ${st.open ? c.green + st.reason : c.yellow + st.reason}${c.reset}`);
  log.plain(`     harga/item  : ${fmtEth(d.mintPrice, sym)}`);
  log.plain(`     window      : ${d.startTime ? new Date(d.startTime * 1000).toISOString() : '-'} s/d ${d.endTime ? new Date(d.endTime * 1000).toISOString() : '-'}`);
  log.plain(`     limit/wallet: ${d.maxTotalMintableByWallet}`);
  log.plain(`     fee         : ${d.feeBps / 100}% -> ${sd.feeRecipients?.[0] ?? '-'}`);
  if (sd.creatorPayout) log.plain(`     kreator     : ${sd.creatorPayout}`);
  if (stats) {
    log.plain(`     supply      : ${stats.currentTotalSupply} / ${stats.maxSupply}`);
    log.plain(`     kamu sudah  : ${stats.minterNumMinted} mint`);
  }
  if (sd.allowListRoot && sd.allowListRoot !== ethers.ZeroHash) {
    log.plain(`     ${c.yellow}allowlist aktif (butuh merkle proof untuk mintAllowList)${c.reset}`);
  }
  if (sd.signers?.length) {
    log.plain(`     ${c.dim}signer mintSigned: ${sd.signers.join(', ')}${c.reset}`);
  }
}
