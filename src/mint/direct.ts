import { ethers, Contract } from 'ethers';
import { Config, COMMON_MINT_ABI, MINT_FUNCTION_SIGNATURES } from '../config';
import { WalletInfo, WalletManager } from '../wallet';
import { runConcurrent } from '../utils';

export interface MintResult {
  walletIndex: number;
  walletAddress: string;
  success: boolean;
  txHash: string | null;
  tokenId: string | null;          // First token ID (for backward compat)
  tokenIds: string[];              // BUG-005 FIX: All token IDs minted
  error: string | null;
  gasUsed: string | null;
  mintPrice: string;
  contractAddress: string;
}

export interface ContractInfo {
  name: string | null;
  symbol: string | null;
  mintPrice: string | null;
  maxSupply: string | null;
  totalSupply: string | null;
  maxPerWallet: string | null;
  functionSignature: string | null;
  isMintable: boolean;
}

export class DirectMinter {
  private config: Config;
  private walletManager: WalletManager;

  constructor(config: Config, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
  }

  async detectContract(contractAddress: string): Promise<ContractInfo> {
    const provider = this.walletManager.getProvider();
    const contract = new Contract(contractAddress, COMMON_MINT_ABI, provider);

    const info: ContractInfo = {
      name: null, symbol: null, mintPrice: null,
      maxSupply: null, totalSupply: null, maxPerWallet: null,
      functionSignature: null, isMintable: false,
    };

    try { info.name = await contract.name(); } catch {}
    try { info.symbol = await contract.symbol(); } catch {}
    try { info.maxSupply = (await contract.maxSupply()).toString(); } catch {}
    try { info.totalSupply = (await contract.totalSupply()).toString(); } catch {}
    try { info.mintPrice = ethers.formatEther(await contract.mintPrice()); } catch {}
    try { info.mintPrice = ethers.formatEther(await contract.price()); } catch {}
    try { info.mintPrice = ethers.formatEther(await contract.mintRate()); } catch {}
    try { info.maxPerWallet = (await contract.maxPerWallet()).toString(); } catch {}
    try { info.maxPerWallet = (await contract.maxMintAmountPerTx()).toString(); } catch {}

    // Detect mint function
    for (const sig of MINT_FUNCTION_SIGNATURES) {
      try {
        const testWallet = this.walletManager.getAllWallets()[0];
        if (!testWallet) break;
        const testContract = new Contract(contractAddress, [`function ${sig} payable`], testWallet.nonceManager);
        const funcName = sig.split('(')[0];
        let args: any[];
        if (sig.includes('address') && sig.includes('uint256')) {
          args = sig.startsWith('address') ? [testWallet.address, 1] : [1, testWallet.address];
        } else if (sig.includes('bytes')) {
          args = [1, '0x'];
        } else if (sig.includes('address')) {
          args = [testWallet.address];
        } else {
          args = [1];
        }
        await testContract[funcName].staticCall(...args, { value: 0 });
        info.functionSignature = sig;
        info.isMintable = true;
        break;
      } catch (err: any) {
        const msg = err.message?.toLowerCase() || '';
        if (msg.includes('insufficient') || msg.includes('not active') || msg.includes('sale') ||
            msg.includes('exceed') || msg.includes('allowlist') || msg.includes('whitelist') ||
            msg.includes('presale') || msg.includes('not started') || msg.includes('ended') ||
            msg.includes('wrong')) {
          info.functionSignature = sig;
          info.isMintable = true;
          break;
        }
      }
    }

    return info;
  }

  async mint(params: {
    contractAddress: string;
    mintFunction?: string;
    quantity: number;
    mintPrice: string;
    maxGasPriceGwei?: number;
    gasLimit?: number;
    walletsToUse?: number[];
    concurrent?: number;
  }): Promise<MintResult[]> {
    const {
      contractAddress, mintFunction, quantity = this.config.defaultMintQuantity,
      mintPrice = '0', maxGasPriceGwei = this.config.maxGasPriceGwei,
      gasLimit, walletsToUse, concurrent = 3,
    } = params;

    let wallets: WalletInfo[];
    if (walletsToUse?.length) {
      wallets = walletsToUse.map(i => this.walletManager.getWallet(i)).filter((w): w is WalletInfo => !!w);
    } else {
      wallets = this.walletManager.getAllWallets();
    }
    if (!wallets.length) throw new Error('No wallets available');

    // Auto-detect function if not provided
    let funcSignature = mintFunction;
    if (!funcSignature) {
      const info = await this.detectContract(contractAddress);
      funcSignature = info.functionSignature || 'mint(uint256)';
    }

    const abi = [`function ${funcSignature} payable`, ...COMMON_MINT_ABI];
    const funcName = funcSignature.split('(')[0];

    const tasks = wallets.map((wi) => async (): Promise<MintResult> => {
      const result: MintResult = {
        walletIndex: wi.index, walletAddress: wi.address,
        success: false, txHash: null, tokenId: null, tokenIds: [],
        error: null, gasUsed: null, mintPrice, contractAddress,
      };

      try {
        const contract = new Contract(contractAddress, abi, wi.nonceManager);
        const value = ethers.parseEther(mintPrice) * BigInt(quantity);

        let args: any[];
        if (funcSignature!.includes('address') && funcSignature!.includes('uint256')) {
          args = funcSignature!.startsWith('address') ? [wi.address, quantity] : [quantity, wi.address];
        } else if (funcSignature!.includes('bytes')) {
          args = [quantity, '0x'];
        } else if (funcSignature!.includes('address')) {
          args = [wi.address];
        } else {
          args = [quantity];
        }

        const maxFeePerGas = ethers.parseUnits(Math.min(maxGasPriceGwei, this.config.maxGasPriceGwei).toString(), 'gwei');
        const maxPriorityFeePerGas = ethers.parseUnits(this.config.priorityFeeGwei.toString(), 'gwei');

        let estimatedGas: bigint;
        if (gasLimit) {
          estimatedGas = BigInt(gasLimit);
        } else {
          try {
            estimatedGas = await contract[funcName].estimateGas(...args, { value });
            estimatedGas = BigInt(Math.ceil(Number(estimatedGas) * this.config.gasLimitMultiplier));
          } catch {
            estimatedGas = BigInt(300000 * quantity);
          }
        }

        if (this.config.dryRun) {
          result.success = true;
          result.txHash = '0x_dry_run';
          return result;
        }

        const tx = await contract[funcName](...args, {
          value, maxFeePerGas, maxPriorityFeePerGas, gasLimit: estimatedGas,
        });
        result.txHash = tx.hash;

        const receipt = await tx.wait(1);
        if (receipt && receipt.status === 1) {
          result.success = true;
          result.gasUsed = receipt.gasUsed.toString();
          // Extract ALL token IDs, handle ERC721 & ERC1155
          const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
          const erc1155TransferSingleTopic = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
          const erc1155TransferBatchTopic = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
            if (log.topics[0] === erc721TransferTopic && log.topics.length >= 4) {
              // ERC721 Transfer: topics[3] = tokenId
              const tid = BigInt(log.topics[3]).toString();
              result.tokenIds.push(tid);
            } else if (log.topics[0] === erc1155TransferSingleTopic) {
              // ERC1155 TransferSingle: id & value are in data (abi-encoded uint256, uint256)
              try {
                const iface = new ethers.Interface(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)']);
                const decoded = iface.parseLog({ topics: log.topics as string[], data: log.data });
                if (decoded?.args?.id !== undefined) {
                  result.tokenIds.push(decoded.args.id.toString());
                }
              } catch {}
            } else if (log.topics[0] === erc1155TransferBatchTopic) {
              // ERC1155 TransferBatch: ids[] & values[] are in data
              try {
                const iface = new ethers.Interface(['event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)']);
                const decoded = iface.parseLog({ topics: log.topics as string[], data: log.data });
                if (decoded?.args?.ids) {
                  for (const id of decoded.args.ids) {
                    result.tokenIds.push(id.toString());
                  }
                }
              } catch {}
            }
          }
          // Set first tokenId for backward compat
          if (result.tokenIds.length > 0) {
            result.tokenId = result.tokenIds[0];
          }
        } else {
          result.error = 'Transaction reverted';
        }
      } catch (err: any) {
        result.error = err.message?.slice(0, 200) || 'Unknown error';
      }
      return result;
    });

    return runConcurrent(tasks, concurrent);
  }
}
