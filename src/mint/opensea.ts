import { ethers, Contract } from 'ethers';
import { Config, COMMON_MINT_ABI } from '../config';
import { WalletInfo, WalletManager } from '../wallet';
import { MintResult } from './direct';
import { runConcurrent } from '../utils';
import axios from 'axios';

/**
 * SeaDrop V1 (OpenSea) ABI.
 *
 * IMPORTANT: OpenSea SeaDrop V1 on Ethereum uses:
 *   mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)
 * and PublicDrop = (uint80 mintPrice, uint48 startTime, uint48 endTime,
 *                   uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)
 *
 * Do NOT use the old 3-arg mintPublic ABI or the empty/no-code
 * 0x00005EA67... address. That causes wrong-price / no-op / revert failures.
 */
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getFeeRecipientIsAllowed(address nftContract, address feeRecipient) view returns (bool)',
];

const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';

// Known SeaDrop V1 candidates. Try all and require deployed code + successful getPublicDrop.
const SEADROP_CANDIDATES: Record<number, string[]> = {
  1: [
    '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5', // current Ethereum SeaDrop V1
    '0x00005ea67ac36d4aa7f7be4d33385971bae75dee', // legacy/placeholder; often no code, skipped
  ],
  8453: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  10: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  137: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  42161: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  4663: ['0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'],
};

interface SeaDropInfo {
  isSeadrop: boolean;
  seadropAddress: string | null;
  mintPrice: string | null;
  mintPriceWei: bigint | null;
  feeRecipient: string | null;
  startTime: number | null;
  endTime: number | null;
  maxTotalMintableByWallet: number | null;
  restrictFeeRecipients: boolean | null;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export class OpenSeaMinter {
  private config: Config;
  private walletManager: WalletManager;

  constructor(config: Config, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
  }

  async resolveContractFromSlug(slug: string): Promise<string | null> {
    try {
      // OpenSea's current public endpoint is plural: /collections/<slug>.
      const response = await axios.get(`https://api.opensea.io/api/v2/collections/${slug}`, {
        headers: this.config.openseaApiKey ? { 'X-API-KEY': this.config.openseaApiKey } : {},
      });
      const data = response.data;
      if (data?.contracts?.length > 0) return data.contracts[0].address;
      if (data?.collection?.primary_asset_contracts?.length > 0) {
        return data.collection.primary_asset_contracts[0].address;
      }
      if (data?.address) return data.address;
    } catch (err: any) {
      console.error(`Failed to resolve slug "${slug}": ${err.message}`);
    }
    return null;
  }

  private async resolveSeaDropAddress(contractAddress: string): Promise<string | null> {
    const chainId = this.walletManager.getChainId();
    const provider = this.walletManager.getProvider();
    const candidates = SEADROP_CANDIDATES[chainId] || [];

    for (const candidate of candidates) {
      try {
        const code = await provider.getCode(candidate);
        if (!code || code === '0x') continue;
        const seadrop = new Contract(candidate, SEADROP_ABI, provider);
        await seadrop.getPublicDrop(contractAddress);
        return candidate;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  async getSeadropInfo(contractAddress: string): Promise<SeaDropInfo> {
    const provider = this.walletManager.getProvider();
    const result: SeaDropInfo = {
      isSeadrop: false,
      seadropAddress: null,
      mintPrice: null,
      mintPriceWei: null,
      feeRecipient: null,
      startTime: null,
      endTime: null,
      maxTotalMintableByWallet: null,
      restrictFeeRecipients: null,
    };

    const seadropAddress = await this.resolveSeaDropAddress(contractAddress);
    if (!seadropAddress) return result;

    try {
      const seadrop = new Contract(seadropAddress, SEADROP_ABI, provider);
      const publicDrop = await seadrop.getPublicDrop(contractAddress);
      const mintPriceWei = BigInt(publicDrop.mintPrice);
      const restrictFeeRecipients = Boolean(publicDrop.restrictFeeRecipients);

      let feeRecipient = OPENSEA_FEE_RECIPIENT;
      try {
        const recipients: string[] = await seadrop.getAllowedFeeRecipients(contractAddress);
        if (recipients.length > 0) feeRecipient = recipients[0];
      } catch {}

      if (restrictFeeRecipients) {
        const isAllowed = await seadrop.getFeeRecipientIsAllowed(contractAddress, feeRecipient).catch(() => false);
        if (!isAllowed) {
          const recipients: string[] = await seadrop.getAllowedFeeRecipients(contractAddress).catch(() => []);
          if (recipients.length === 0) throw new Error('SeaDrop restricts fee recipients but no allowed recipient was found');
          feeRecipient = recipients[0];
        }
      }

      result.isSeadrop = true;
      result.seadropAddress = seadropAddress;
      result.mintPriceWei = mintPriceWei;
      result.mintPrice = ethers.formatEther(mintPriceWei);
      result.feeRecipient = feeRecipient;
      result.startTime = Number(publicDrop.startTime) || null;
      result.endTime = Number(publicDrop.endTime) || null;
      result.maxTotalMintableByWallet = Number(publicDrop.maxTotalMintableByWallet) || null;
      result.restrictFeeRecipients = restrictFeeRecipients;
    } catch {}

    // Try contract directly for price if SeaDrop price was unavailable.
    if (!result.mintPrice) {
      try {
        const nft = new Contract(contractAddress, COMMON_MINT_ABI, provider);
        try { result.mintPrice = ethers.formatEther(await nft.mintPrice()); } catch {}
        try { result.mintPrice = ethers.formatEther(await nft.price()); } catch {}
      } catch {}
    }
    return result;
  }

  async mint(params: {
    contractAddress: string;
    openseaSlug?: string;
    quantity: number;
    mintPrice?: string;
    walletsToUse?: number[];
    concurrent?: number;
  }): Promise<MintResult[]> {
    const { contractAddress, openseaSlug, quantity = 1, mintPrice, walletsToUse, concurrent = 3 } = params;

    let resolvedAddress = contractAddress;
    if (!resolvedAddress && openseaSlug) {
      resolvedAddress = (await this.resolveContractFromSlug(openseaSlug)) || '';
    }
    if (!resolvedAddress) throw new Error('Could not resolve contract address');

    const seadropInfo = await this.getSeadropInfo(resolvedAddress);

    let wallets: WalletInfo[];
    if (walletsToUse?.length) {
      wallets = walletsToUse.map(i => this.walletManager.getWallet(i)).filter((w): w is WalletInfo => !!w);
    } else {
      wallets = this.walletManager.getAllWallets();
    }
    if (!wallets.length) throw new Error('No wallets available');

    if (seadropInfo.isSeadrop) {
      // For SeaDrop, ALWAYS trust live on-chain price over OpenSea UI / user-provided stale price.
      const price = seadropInfo.mintPrice || mintPrice || '0';
      if (parseFloat(price) > this.config.maxMintPriceEth) {
        throw new Error(`Live SeaDrop mint price (${price} ETH) exceeds MAX_MINT_PRICE_ETH (${this.config.maxMintPriceEth} ETH)`);
      }
      if (!seadropInfo.seadropAddress || !seadropInfo.feeRecipient) {
        throw new Error('SeaDrop detected but address/feeRecipient could not be resolved');
      }
      return this.mintViaSeadrop(
        resolvedAddress,
        price,
        quantity,
        wallets,
        concurrent,
        seadropInfo.seadropAddress,
        seadropInfo.feeRecipient,
      );
    }

    // Fallback to direct
    const { DirectMinter } = await import('./direct');
    const directMinter = new DirectMinter(this.config, this.walletManager);
    return directMinter.mint({ contractAddress: resolvedAddress, quantity, mintPrice: mintPrice || '0', walletsToUse, concurrent });
  }

  private async getEip1559GasOverrides(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const provider = this.walletManager.getProvider();
    const [feeData, block] = await Promise.all([
      provider.getFeeData(),
      provider.getBlock('latest').catch(() => null),
    ]);

    const baseFee = block?.baseFeePerGas || feeData.gasPrice || ethers.parseUnits('20', 'gwei');
    const configuredPriority = ethers.parseUnits(this.config.priorityFeeGwei.toString(), 'gwei');
    let priority = feeData.maxPriorityFeePerGas || configuredPriority;
    if (priority < configuredPriority) priority = configuredPriority;

    const cap = ethers.parseUnits(this.config.maxGasPriceGwei.toString(), 'gwei');
    const maxFee = minBigint(baseFee * BigInt(2) + priority, cap);
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: minBigint(priority, cap) };
  }

  private async mintViaSeadrop(
    contractAddress: string,
    fallbackMintPrice: string,
    quantity: number,
    wallets: WalletInfo[],
    concurrent: number,
    seadropAddress: string,
    feeRecipient: string,
  ): Promise<MintResult[]> {
    const provider = this.walletManager.getProvider();

    const tasks = wallets.map((wi) => async (): Promise<MintResult> => {
      const result: MintResult = {
        walletIndex: wi.index, walletAddress: wi.address,
        success: false, txHash: null, tokenId: null, tokenIds: [],
        error: null, gasUsed: null, mintPrice: fallbackMintPrice, contractAddress,
      };

      try {
        const seadrop = new Contract(seadropAddress, SEADROP_ABI, wi.nonceManager);
        const readOnlySeadrop = new Contract(seadropAddress, SEADROP_ABI, provider);

        // Re-read live drop immediately before sending. Creators can update price/max at the last minute.
        const liveDrop = await readOnlySeadrop.getPublicDrop(contractAddress);
        const livePriceWei = BigInt(liveDrop.mintPrice);
        const livePriceEth = ethers.formatEther(livePriceWei);
        if (parseFloat(livePriceEth) > this.config.maxMintPriceEth) {
          throw new Error(`Live SeaDrop mint price (${livePriceEth} ETH) exceeds MAX_MINT_PRICE_ETH (${this.config.maxMintPriceEth} ETH)`);
        }
        result.mintPrice = livePriceEth;

        const maxPerWallet = Number(liveDrop.maxTotalMintableByWallet) || null;
        if (maxPerWallet !== null && quantity > maxPerWallet) {
          throw new Error(`Requested quantity ${quantity} exceeds live SeaDrop maxPerWallet ${maxPerWallet}`);
        }

        const value = livePriceWei * BigInt(quantity);
        const { maxFeePerGas, maxPriorityFeePerGas } = await this.getEip1559GasOverrides();

        let gasLimit = BigInt(300000 * quantity);
        try {
          const estimated = await seadrop.mintPublic.estimateGas(
            contractAddress,
            feeRecipient,
            ethers.ZeroAddress,
            quantity,
            { value },
          );
          gasLimit = BigInt(Math.ceil(Number(estimated) * this.config.gasLimitMultiplier));
        } catch {
          // Fallback; competitive mints should use fast-mint.mjs to avoid live estimate delay entirely.
        }

        if (this.config.dryRun) {
          result.success = true; result.txHash = '0x_dry_run'; return result;
        }

        const tx = await seadrop.mintPublic(
          contractAddress,
          feeRecipient,
          ethers.ZeroAddress,
          quantity,
          { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit },
        );

        result.txHash = tx.hash;
        const receipt = await tx.wait(1);
        if (receipt && receipt.status === 1) {
          result.success = true;
          result.gasUsed = receipt.gasUsed.toString();
          const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
          const erc1155TransferSingleTopic = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
          const erc1155TransferBatchTopic = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
            if (log.topics[0] === erc721TransferTopic && log.topics.length >= 4) {
              result.tokenIds.push(BigInt(log.topics[3]).toString());
            } else if (log.topics[0] === erc1155TransferSingleTopic) {
              try {
                const iface = new ethers.Interface(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)']);
                const decoded = iface.parseLog({ topics: log.topics as string[], data: log.data });
                if (decoded?.args?.id !== undefined) result.tokenIds.push(decoded.args.id.toString());
              } catch {}
            } else if (log.topics[0] === erc1155TransferBatchTopic) {
              try {
                const iface = new ethers.Interface(['event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)']);
                const decoded = iface.parseLog({ topics: log.topics as string[], data: log.data });
                if (decoded?.args?.ids) {
                  for (const id of decoded.args.ids) result.tokenIds.push(id.toString());
                }
              } catch {}
            }
          }
          if (result.tokenIds.length > 0) result.tokenId = result.tokenIds[0];
        } else {
          result.error = 'Transaction reverted';
        }
      } catch (err: any) {
        result.error = err.shortMessage?.slice(0, 200) || err.message?.slice(0, 200) || 'Unknown error';
      }
      return result;
    });

    return runConcurrent(tasks, concurrent);
  }
}
