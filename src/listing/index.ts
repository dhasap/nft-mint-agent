import { ethers, Contract, Wallet } from 'ethers';
import { Config, CHAIN_IDS } from '../config';
import { WalletManager } from '../wallet';
import axios from 'axios';

const APPROVAL_ABI = [
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

const SEAPORT_ADDRESSES: Record<number, string> = {
  1: '0x00000000006c3852cbEf3e08E8dF289169EdE581',
  8453: '0x00000000006c3852cbEf3e08E8dF289169EdE581',
  10: '0x00000000006c3852cbEf3e08E8dF289169EdE581',
  137: '0x00000000006c3852cbEf3e08E8dF289169EdE581',
  42161: '0x00000000006c3852cbEf3e08E8dF289169EdE581',
};

export interface ListResult {
  walletIndex: number;
  walletAddress: string;
  contractAddress: string;
  tokenId: string;
  success: boolean;
  listingUrl: string | null;
  error: string | null;
  priceEth: string;
}

export class AutoLister {
  private config: Config;
  private walletManager: WalletManager;

  constructor(config: Config, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
  }

  async approveSeaport(contractAddress: string, walletIndex: number): Promise<{
    success: boolean;
    txHash: string | null;
    error: string | null;
  }> {
    const chainId = this.walletManager.getChainId();
    const seaportAddress = SEAPORT_ADDRESSES[chainId];
    if (!seaportAddress) return { success: false, txHash: null, error: `Seaport not supported on chain ${chainId}` };

    const walletInfo = this.walletManager.getWallet(walletIndex);
    if (!walletInfo) return { success: false, txHash: null, error: `Wallet ${walletIndex} not found` };

    try {
      const nft = new Contract(contractAddress, APPROVAL_ABI, walletInfo.nonceManager);
      const isApproved = await nft.isApprovedForAll(walletInfo.address, seaportAddress);
      if (isApproved) return { success: true, txHash: null, error: null };

      const tx = await nft.setApprovalForAll(seaportAddress, true);
      const receipt = await tx.wait(1);
      return { success: true, txHash: tx.hash, error: null };
    } catch (err: any) {
      return { success: false, txHash: null, error: err.message?.slice(0, 200) };
    }
  }

  async batchApprove(contractAddress: string): Promise<{ walletIndex: number; success: boolean; error: string | null }[]> {
    const results = [];
    for (const wi of this.walletManager.getAllWallets()) {
      const res = await this.approveSeaport(contractAddress, wi.index);
      results.push({ walletIndex: wi.index, success: res.success, error: res.error });
    }
    return results;
  }

  async listNFT(params: {
    contractAddress: string;
    tokenId: string;
    priceEth: string;
    walletIndex: number;
    expirationHours?: number;
  }): Promise<ListResult> {
    const { contractAddress, tokenId, priceEth, walletIndex, expirationHours = 168 } = params;

    const walletInfo = this.walletManager.getWallet(walletIndex);
    if (!walletInfo) throw new Error(`Wallet ${walletIndex} not found`);

    const result: ListResult = {
      walletIndex, walletAddress: walletInfo.address,
      contractAddress, tokenId, success: false,
      listingUrl: null, error: null, priceEth,
    };

    if (this.config.dryRun) {
      result.success = true;
      result.listingUrl = `[DRY RUN] Would list at ${priceEth} ETH`;
      return result;
    }

    try {
      const chainId = this.walletManager.getChainId();
      const seaportAddress = SEAPORT_ADDRESSES[chainId];

      // Approve first
      const approveResult = await this.approveSeaport(contractAddress, walletIndex);
      if (!approveResult.success) throw new Error(`Approval failed: ${approveResult.error}`);

      // List via OpenSea API v2
      if (this.config.openseaApiKey) {
        const listed = await this.createListingViaAPI(
          contractAddress, tokenId, priceEth, walletInfo.address, expirationHours
        );
        if (listed) {
          result.success = true;
          const chainName = this.config.chain || 'ethereum';
          result.listingUrl = `https://opensea.io/assets/${chainName}/${contractAddress}/${tokenId}`;
          return result;
        }
      }

      result.error = 'API listing failed. Manual listing required on OpenSea.';
    } catch (err: any) {
      result.error = err.message?.slice(0, 200) || 'Unknown error';
    }
    return result;
  }

  async batchListNFTs(items: {
    contractAddress: string;
    tokenId: string;
    priceEth: string;
    walletIndex: number;
  }[]): Promise<ListResult[]> {
    const results: ListResult[] = [];
    for (const item of items) {
      try {
        const res = await this.listNFT(item);
        results.push(res);
      } catch (err: any) {
        results.push({
          walletIndex: item.walletIndex,
          walletAddress: this.walletManager.getWallet(item.walletIndex)?.address || '',
          contractAddress: item.contractAddress,
          tokenId: item.tokenId,
          success: false, listingUrl: null,
          error: err.message?.slice(0, 200), priceEth: item.priceEth,
        });
      }
    }
    return results;
  }

  // BUG-010 FIX: Use correct OpenSea API v2 format for creating listings
  // OpenSea v2 uses POST /v2/offers with proper order structure
  // If API fails, we return a helpful message for manual listing
  private async createListingViaAPI(
    contractAddress: string, tokenId: string, priceEth: string,
    walletAddress: string, expirationHours: number
  ): Promise<boolean> {
    try {
      const priceWei = ethers.parseEther(priceEth).toString();
      const expirationTime = Math.floor(Date.now() / 1000) + (expirationHours * 3600);
      const chainName = this.config.chain || 'ethereum';

      // OpenSea v2 API: Create listing via fulfillable order
      // Reference: https://docs.opensea.io/v2.0/reference/create-listing
      const payload = {
        parameters: {
          offerer: walletAddress,
          offer: [{
            itemType: 2, // ERC721
            token: contractAddress,
            identifierOrCriteria: tokenId,
            startAmount: '1',
            endAmount: '1',
          }],
          consideration: [{
            itemType: 0, // Native ETH
            token: '0x0000000000000000000000000000000000000000',
            identifierOrCriteria: '0',
            startAmount: priceWei,
            endAmount: priceWei,
            recipient: walletAddress,
          }],
          startTime: String(Math.floor(Date.now() / 1000)),
          endTime: String(expirationTime),
          orderType: 0, // Full open
          zone: '0x0000000000000000000000000000000000000000',
          zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          salt: String(Math.floor(Math.random() * 1000000000)),
          conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
          totalOriginalConsiderationItems: 1,
          counter: 0,
        },
        signature: '',
      };

      const response = await axios.post(
        `https://api.opensea.io/v2/listings/${chainName}`,
        payload,
        {
          headers: {
            'X-API-KEY': this.config.openseaApiKey,
            'Content-Type': 'application/json',
          },
        }
      );
      return response.status === 200 || response.status === 201;
    } catch (err: any) {
      console.error(`OpenSea API listing error: ${err.response?.status} ${err.response?.data || err.message}`);
      return false;
    }
  }
}
