import { ethers, Wallet, Provider, NonceManager } from 'ethers';
import { Config, CHAIN_IDS } from '../config';

export interface WalletInfo {
  index: number;
  address: string;
  wallet: Wallet;
  nonceManager: NonceManager;
}

export class WalletManager {
  private wallets: WalletInfo[] = [];
  private provider: Provider;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    const chainId = CHAIN_IDS[config.chain] || 1;
    // Disable JSON-RPC batching. Some mint-critical RPC providers return
    // "missing response for request" on batched concurrent calls, which is
    // unacceptable around drop start time.
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, chainId, { batchMaxCount: 1 });
    this.loadWallets();
  }

  private loadWallets(): void {
    for (let i = 0; i < this.config.walletPrivateKeys.length; i++) {
      try {
        const wallet = new Wallet(this.config.walletPrivateKeys[i], this.provider);
        const nonceManager = new NonceManager(wallet);
        this.wallets.push({ index: i, address: wallet.address, wallet, nonceManager });
      } catch (err: any) {
        console.error(`Failed to load wallet ${i + 1}: ${err.message}`);
      }
    }
  }

  getProvider(): Provider { return this.provider; }
  getAllWallets(): WalletInfo[] { return this.wallets; }
  // BUG-012 FIX: Use .find with .index instead of array position
  // Because if wallet loading fails, there are gaps in .index
  getWallet(index: number): WalletInfo | undefined { return this.wallets.find(w => w.index === index); }
  getWalletCount(): number { return this.wallets.length; }
  getAllAddresses(): string[] { return this.wallets.map(w => w.address); }
  getChainId(): number { return CHAIN_IDS[this.config.chain] || 1; }
  getConfig(): Config { return this.config; }

  async getBalances(): Promise<{ address: string; ethBalance: string; walletIndex: number }[]> {
    const balances = [];
    for (const wi of this.wallets) {
      const balance = await this.provider.getBalance(wi.address);
      balances.push({ address: wi.address, ethBalance: ethers.formatEther(balance), walletIndex: wi.index });
    }
    return balances;
  }

  async getFeeData() { return this.provider.getFeeData(); }
}
