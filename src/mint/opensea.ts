import { ethers, Contract } from 'ethers';
import { Config, COMMON_MINT_ABI } from '../config';
import { WalletInfo, WalletManager } from '../wallet';
import { MintResult } from './direct';
import PQueue from 'p-queue';
import axios from 'axios';

// BUG-007 FIX: Corrected ABI types from actual Seadrop contract
// getPublicDrop returns a struct with proper uint256/uint64 types, not uint8
const SEADROP_ABI = [
  'function mintPublic(address feeRecipient, address minter, uint256 quantity) payable',
  'function mintAllowed(address feeRecipient, address minter, uint256 quantity, bytes[] proof) payable',
  'function mintSigned(address feeRecipient, address minter, uint256 quantity, bytes signature) payable',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint24 feeBps, uint64 startTime, uint64 endTime, uint16 maxTotalMintSupplyByWallet, uint32 maxTokenSupplyForStage, uint8 dropStageIndex, uint80 feeRecipient))',
  'function getDropStageInfo(address nftContract, uint8 dropStageIndex) view returns (tuple(uint80 mintPrice, uint24 feeBps, uint64 startTime, uint64 endTime, uint16 maxTotalMintSupplyByWallet, uint32 maxTokenSupplyForStage, uint8 dropStageIndex, uint80 feeRecipient))',
];

const SEADROP_ADDRESSES: Record<number, string> = {
  1: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  8453: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  10: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  137: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  42161: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
};

export class OpenSeaMinter {
  private config: Config;
  private walletManager: WalletManager;

  constructor(config: Config, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
  }

  async resolveContractFromSlug(slug: string): Promise<string | null> {
    try {
      const response = await axios.get(`https://api.opensea.io/api/v2/collection/${slug}`, {
        headers: this.config.openseaApiKey ? { 'X-API-KEY': this.config.openseaApiKey } : {},
      });
      const data = response.data;
      if (data?.collection?.primary_asset_contracts?.length > 0) {
        return data.collection.primary_asset_contracts[0].address;
      }
      if (data?.address) return data.address;
    } catch (err: any) {
      console.error(`Failed to resolve slug "${slug}": ${err.message}`);
    }
    return null;
  }

  async getSeadropInfo(contractAddress: string): Promise<{
    isSeadrop: boolean;
    mintPrice: string | null;
    feeRecipient: string | null;
  }> {
    const chainId = this.walletManager.getChainId();
    const provider = this.walletManager.getProvider();
    const seadropAddress = SEADROP_ADDRESSES[chainId];
    const result = { isSeadrop: false, mintPrice: null as string | null, feeRecipient: null as string | null };

    if (seadropAddress) {
      try {
        const seadrop = new Contract(seadropAddress, SEADROP_ABI, provider);
        const dropInfo = await seadrop.getPublicDrop(contractAddress);
        result.isSeadrop = true;
        if (dropInfo.mintPrice) result.mintPrice = ethers.formatEther(dropInfo.mintPrice);
        // BUG-004 FIX: Read feeRecipient from drop info instead of hardcoding
        if (dropInfo.feeRecipient) result.feeRecipient = dropInfo.feeRecipient;
      } catch {}
    }

    // Try contract directly for price
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
    const price = mintPrice || seadropInfo.mintPrice || '0';

    let wallets: WalletInfo[];
    if (walletsToUse?.length) {
      wallets = walletsToUse.map(i => this.walletManager.getWallet(i)).filter((w): w is WalletInfo => !!w);
    } else {
      wallets = this.walletManager.getAllWallets();
    }
    if (!wallets.length) throw new Error('No wallets available');

    if (seadropInfo.isSeadrop) {
      return this.mintViaSeadrop(resolvedAddress, price, quantity, wallets, concurrent, seadropInfo.feeRecipient);
    }

    // Fallback to direct
    const { DirectMinter } = await import('./direct');
    const directMinter = new DirectMinter(this.config, this.walletManager);
    return directMinter.mint({ contractAddress: resolvedAddress, quantity, mintPrice: price, walletsToUse, concurrent });
  }

  private async mintViaSeadrop(
    contractAddress: string, mintPrice: string, quantity: number, wallets: WalletInfo[], concurrent: number, feeRecipientFromDrop: string | null
  ): Promise<MintResult[]> {
    const chainId = this.walletManager.getChainId();
    const seadropAddress = SEADROP_ADDRESSES[chainId];
    if (!seadropAddress) throw new Error(`Seadrop not supported on chain ${chainId}`);

    const queue = new PQueue({ concurrency: concurrent });
    const results: MintResult[] = [];
    // BUG-004 FIX: Use feeRecipient from getSeadropInfo, fallback to OpenSea's known address
    const feeRecipient = feeRecipientFromDrop || '0x0000a26b00c1F0DF003000390027140000fAa719';

    const promises = wallets.map((wi) => queue.add(async () => {
      const result: MintResult = {
        walletIndex: wi.index, walletAddress: wi.address,
        success: false, txHash: null, tokenId: null, tokenIds: [],
        error: null, gasUsed: null, mintPrice, contractAddress,
      };

      try {
        const seadrop = new Contract(seadropAddress, SEADROP_ABI, wi.nonceManager);
        const value = ethers.parseEther(mintPrice) * BigInt(quantity);
        const maxFeePerGas = ethers.parseUnits(this.config.maxGasPriceGwei.toString(), 'gwei');
        const maxPriorityFeePerGas = ethers.parseUnits(this.config.priorityFeeGwei.toString(), 'gwei');

        if (this.config.dryRun) {
          result.success = true; result.txHash = '0x_dry_run'; return result;
        }

        let tx;
        try {
          tx = await seadrop.mintPublic(feeRecipient, wi.address, quantity, {
            value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: BigInt(300000 * quantity),
          });
        } catch {
          // Fallback to direct contract
          const nft = new Contract(contractAddress, COMMON_MINT_ABI, wi.nonceManager);
          const attempts = [
            () => nft.mint(quantity, { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: BigInt(300000 * quantity) }),
            () => nft.mint(wi.address, quantity, { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: BigInt(300000 * quantity) }),
            () => nft.claim(quantity, { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: BigInt(300000 * quantity) }),
          ];
          let ok = false;
          for (const fn of attempts) {
            try { tx = await fn(); ok = true; break; } catch {}
          }
          if (!ok) throw new Error('No working mint function found');
        }

        result.txHash = tx.hash;
        const receipt = await tx.wait(1);
        if (receipt && receipt.status === 1) {
          result.success = true;
          result.gasUsed = receipt.gasUsed.toString();
          // BUG-005 FIX: Extract ALL token IDs, handle ERC721 & ERC1155
          const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
          const erc1155TransferSingleTopic = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
            if (log.topics[0] === erc721TransferTopic && log.topics.length >= 4) {
              result.tokenIds.push(BigInt(log.topics[3]).toString());
            } else if (log.topics[0] === erc1155TransferSingleTopic && log.topics.length >= 4) {
              result.tokenIds.push(BigInt(log.topics[3]).toString());
            }
          }
          if (result.tokenIds.length > 0) result.tokenId = result.tokenIds[0];
        } else {
          result.error = 'Transaction reverted';
        }
      } catch (err: any) {
        result.error = err.message?.slice(0, 200) || 'Unknown error';
      }
      return result;
    }));

    const mintResults = await Promise.all(promises);
    const validResults = mintResults.filter((r): r is MintResult => r !== undefined);
    results.push(...validResults);
    return results;
  }
}
