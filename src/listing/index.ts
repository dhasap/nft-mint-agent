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
  cancelUrl?: string | null;
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

      // BUG FIX: honor DRY_RUN here too. approveSeaport is reachable directly
      // (and via the approve_seaport tool), so it must not broadcast a real
      // setApprovalForAll tx when the user asked for a simulation.
      if (this.config.dryRun) {
        return { success: true, txHash: '0x_dry_run', error: null };
      }

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

    const chainName = this.config.chain || 'ethereum';
    const manualUrl = `https://opensea.io/assets/${chainName}/${contractAddress}/${tokenId}`;

    const result: ListResult = {
      walletIndex, walletAddress: walletInfo.address,
      contractAddress, tokenId, success: false,
      listingUrl: null, error: null, priceEth,
      cancelUrl: null,
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

      // BUG-002 FIX: Implement EIP-712 signing for Seaport orders
      // List via OpenSea API v2 with proper EIP-712 signed order
      if (this.config.openseaApiKey) {
        const listed = await this.createSignedListingViaAPI(
          contractAddress, tokenId, priceEth, walletInfo, expirationHours, chainId
        );
        if (listed) {
          result.success = true;
          result.listingUrl = `https://opensea.io/assets/${chainName}/${contractAddress}/${tokenId}`;
          result.cancelUrl = `https://opensea.io/account/listings`;
          return result;
        }
      }

      // Fallback: provide manual URL
      result.error = 'API listing failed (no API key or signing error). Manual listing required on OpenSea.';
      result.listingUrl = manualUrl;
      result.cancelUrl = manualUrl;
    } catch (err: any) {
      result.error = err.message?.slice(0, 200) || 'Unknown error';
      result.listingUrl = manualUrl;
      result.cancelUrl = manualUrl;
    }
    return result;
  }

  /**
   * BUG-002 FIX: Create a signed Seaport listing via OpenSea API v2.
   * Signs the order with EIP-712 before posting.
   */
  private async createSignedListingViaAPI(
    contractAddress: string,
    tokenId: string,
    priceEth: string,
    walletInfo: { address: string; wallet: Wallet },
    expirationHours: number,
    chainId: number,
  ): Promise<boolean> {
    try {
      const priceWei = ethers.parseEther(priceEth).toString();
      const expirationTime = Math.floor(Date.now() / 1000) + (expirationHours * 3600);
      const startTime = Math.floor(Date.now() / 1000);
      const chainName = this.config.chain || 'ethereum';

      // Build Seaport order parameters
      const orderParameters = {
        offerer: walletInfo.address,
        zone: '0x0000000000000000000000000000000000000000',
        orderType: 0, // FULL_OPEN
        startTime: String(startTime),
        endTime: String(expirationTime),
        zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        salt: String(Math.floor(Math.random() * 1e18)),
        conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
        offer: [{
          itemType: 2, // ERC721
          token: contractAddress,
          identifierOrCriteria: tokenId,
          startAmount: '1',
          endAmount: '1',
        }],
        consideration: [{
          itemType: 0, // NATIVE (ETH)
          token: '0x0000000000000000000000000000000000000000',
          identifierOrCriteria: '0',
          startAmount: priceWei,
          endAmount: priceWei,
          recipient: walletInfo.address,
        }],
        totalOriginalConsiderationItems: 1,
        counter: 0,
      };

      // EIP-712 domain for Seaport
      const seaportAddress = SEAPORT_ADDRESSES[chainId];
      const domain = {
        name: 'Seaport',
        version: '1.6',
        chainId: chainId,
        verifyingContract: seaportAddress,
      };

      // EIP-712 types for OrderComponents
      const types = {
        OrderComponents: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offer', type: 'OfferItem[]' },
          { name: 'consideration', type: 'ConsiderationItem[]' },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'totalOriginalConsiderationItems', type: 'uint256' },
        ],
        OfferItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
        ],
        ConsiderationItem: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifierOrCriteria', type: 'uint256' },
          { name: 'startAmount', type: 'uint256' },
          { name: 'endAmount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      };

      // Sign the order with EIP-712
      const signature = await walletInfo.wallet.signTypedData(domain, types, orderParameters);

      // Post the signed order to OpenSea API
      const payload = {
        parameters: orderParameters,
        signature: signature,
      };

      const response = await axios.post(
        `https://api.opensea.io/v2/listings/fulfillment`,
        payload,
        {
          headers: {
            'X-API-KEY': this.config.openseaApiKey,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      return response.status === 200 || response.status === 201;
    } catch (err: any) {
      console.error(`OpenSea API listing error: ${err.response?.status} ${JSON.stringify(err.response?.data) || err.message}`);
      return false;
    }
  }

  // BUG-012 FIX: batch_list_nfts now does dry-run validation before executing
  async batchListNFTs(items: {
    contractAddress: string;
    tokenId: string;
    priceEth: string;
    walletIndex: number;
  }[]): Promise<ListResult[]> {
    // Pre-validation: check all items have valid wallets
    const validationErrors: ListResult[] = [];
    for (const item of items) {
      const walletInfo = this.walletManager.getWallet(item.walletIndex);
      if (!walletInfo) {
        const chainName = this.config.chain || 'ethereum';
        validationErrors.push({
          walletIndex: item.walletIndex,
          walletAddress: '',
          contractAddress: item.contractAddress,
          tokenId: item.tokenId,
          success: false,
          listingUrl: null,
          error: `Wallet ${item.walletIndex} not found. Cancel and retry with valid wallet index.`,
          priceEth: item.priceEth,
          cancelUrl: `https://opensea.io/assets/${chainName}/${item.contractAddress}/${item.tokenId}`,
        });
      }
    }

    if (validationErrors.length > 0) {
      return validationErrors;
    }

    const results: ListResult[] = [];
    for (const item of items) {
      try {
        const res = await this.listNFT(item);
        results.push(res);
      } catch (err: any) {
        const chainName = this.config.chain || 'ethereum';
        results.push({
          walletIndex: item.walletIndex,
          walletAddress: this.walletManager.getWallet(item.walletIndex)?.address || '',
          contractAddress: item.contractAddress,
          tokenId: item.tokenId,
          success: false, listingUrl: null,
          error: err.message?.slice(0, 200), priceEth: item.priceEth,
          cancelUrl: `https://opensea.io/assets/${chainName}/${item.contractAddress}/${item.tokenId}`,
        });
      }
    }
    return results;
  }
}
