/**
 * Mint Scheduler - Auto-mint at a scheduled time
 *
 * Reads on-chain mint schedules (Seadrop startTime/endTime)
 * and schedules minting jobs to execute at the right time.
 *
 * For WL/presale mints: OpenSea handles Merkle proof server-side.
 * When user clicks "Mint" on OpenSea website, the frontend calls
 * OpenSea's API which generates the per-wallet proof. Our agent
 * cannot replicate this without OpenSea's cooperation.
 *
 * However, for Seadrop contracts, we can try:
 * 1. mintAllowed() with empty proof (will fail for WL mints)
 * 2. mintPublic() (works when public mint is live)
 * 3. mintSigned() (needs server signature from OpenSea)
 *
 * Bottom line: scheduled auto-mint works best for PUBLIC mint.
 * For WL mint, user should still mint manually on OpenSea.
 */

import { ethers, Contract } from 'ethers';
import { Config, COMMON_MINT_ABI } from '../config';
import { WalletManager } from '../wallet';
import { MintResult } from '../mint/direct';
import { DirectMinter } from '../mint/direct';
import { OpenSeaMinter } from '../mint/opensea';
import { shortAddress } from '../utils';

// Seadrop ABI for reading schedule
const SEADROP_SCHEDULE_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint24 feeBps, uint64 startTime, uint64 endTime, uint16 maxTotalMintSupplyByWallet, uint32 maxTokenSupplyForStage, uint8 dropStageIndex, address feeRecipient))',
  'function getAllowListDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint24 feeBps, uint64 startTime, uint64 endTime, uint16 maxTotalMintSupplyByWallet, uint32 maxTokenSupplyForStage, uint8 dropStageIndex, address feeRecipient))',
  'function getDropStageInfo(address nftContract, uint8 dropStageIndex) view returns (tuple(uint80 mintPrice, uint24 feeBps, uint64 startTime, uint64 endTime, uint16 maxTotalMintSupplyByWallet, uint32 maxTokenSupplyForStage, uint8 dropStageIndex, address feeRecipient))',
];

const SEADROP_ADDRESSES: Record<number, string> = {
  1: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  8453: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  10: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  137: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
  42161: '0x00005EA67Ac36D4AA7f7bE4D33385971BAe75DEe',
};

// Schedule info read from on-chain
export interface MintScheduleInfo {
  contractAddress: string;
  isSeadrop: boolean;
  stages: MintStage[];
}

export interface MintStage {
  stageName: string;         // "public" | "allowlist" | "stage_0" etc
  mintPrice: string | null;  // ETH
  startTime: number | null;  // Unix timestamp (seconds)
  endTime: number | null;    // Unix timestamp (seconds)
  startTimeISO: string | null;
  endTimeISO: string | null;
  maxPerWallet: number | null;
  maxSupply: number | null;
  isActive: boolean;         // currentTime is within start-end
  isPast: boolean;           // endTime has passed
  isFuture: boolean;         // startTime hasn't arrived yet
  status: 'active' | 'upcoming' | 'ended' | 'unknown';
}

// Scheduled mint job
export interface ScheduledMintJob {
  id: string;
  contractAddress: string;
  mintPriceEth: string;
  quantityPerWallet: number;
  walletIndices: number[];
  concurrent: number;
  mintFunction?: string;
  scheduledTime: number;     // Unix ms when to execute
  scheduledTimeISO: string;
  createdAt: number;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  results?: MintResult[];
  error?: string;
}

export class MintScheduler {
  private config: Config;
  private walletManager: WalletManager;
  private directMinter: DirectMinter;
  private openSeaMinter: OpenSeaMinter;
  private jobs: Map<string, ScheduledMintJob> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private jobCounter = 0;

  constructor(config: Config, walletManager: WalletManager) {
    this.config = config;
    this.walletManager = walletManager;
    this.directMinter = new DirectMinter(config, walletManager);
    this.openSeaMinter = new OpenSeaMinter(config, walletManager);
  }

  /**
   * Read on-chain mint schedule from Seadrop contract
   */
  async getMintSchedule(contractAddress: string): Promise<MintScheduleInfo> {
    const chainId = this.walletManager.getChainId();
    const provider = this.walletManager.getProvider();
    const seadropAddress = SEADROP_ADDRESSES[chainId];
    const now = Math.floor(Date.now() / 1000);

    const info: MintScheduleInfo = {
      contractAddress,
      isSeadrop: false,
      stages: [],
    };

    // Try reading from Seadrop
    if (seadropAddress) {
      try {
        const seadrop = new Contract(seadropAddress, SEADROP_SCHEDULE_ABI, provider);

        // Public drop
        try {
          const publicDrop = await seadrop.getPublicDrop(contractAddress);
          info.isSeadrop = true;
          const startTime = Number(publicDrop.startTime);
          const endTime = Number(publicDrop.endTime);
          info.stages.push({
            stageName: 'public',
            mintPrice: publicDrop.mintPrice ? ethers.formatEther(publicDrop.mintPrice) : null,
            startTime: startTime > 0 ? startTime : null,
            endTime: endTime > 0 ? endTime : null,
            startTimeISO: startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
            endTimeISO: endTime > 0 ? new Date(endTime * 1000).toISOString() : null,
            maxPerWallet: Number(publicDrop.maxTotalMintSupplyByWallet) || null,
            maxSupply: Number(publicDrop.maxTokenSupplyForStage) || null,
            isActive: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now),
            isPast: endTime > 0 && endTime <= now,
            isFuture: startTime > 0 && startTime > now,
            status: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now) ? 'active'
              : startTime > 0 && startTime > now ? 'upcoming'
              : endTime > 0 && endTime <= now ? 'ended'
              : 'unknown',
          });
        } catch {}

        // Allowlist drop
        try {
          const allowDrop = await seadrop.getAllowListDrop(contractAddress);
          info.isSeadrop = true;
          const startTime = Number(allowDrop.startTime);
          const endTime = Number(allowDrop.endTime);
          info.stages.push({
            stageName: 'allowlist',
            mintPrice: allowDrop.mintPrice ? ethers.formatEther(allowDrop.mintPrice) : null,
            startTime: startTime > 0 ? startTime : null,
            endTime: endTime > 0 ? endTime : null,
            startTimeISO: startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
            endTimeISO: endTime > 0 ? new Date(endTime * 1000).toISOString() : null,
            maxPerWallet: Number(allowDrop.maxTotalMintSupplyByWallet) || null,
            maxSupply: Number(allowDrop.maxTokenSupplyForStage) || null,
            isActive: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now),
            isPast: endTime > 0 && endTime <= now,
            isFuture: startTime > 0 && startTime > now,
            status: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now) ? 'active'
              : startTime > 0 && startTime > now ? 'upcoming'
              : endTime > 0 && endTime <= now ? 'ended'
              : 'unknown',
          });
        } catch {}

        // Try stage indices 0-2
        for (let i = 0; i < 3; i++) {
          try {
            const stageInfo = await seadrop.getDropStageInfo(contractAddress, i);
            const startTime = Number(stageInfo.startTime);
            const endTime = Number(stageInfo.endTime);
            // Skip if same as public drop (same startTime)
            if (info.stages.some(s => s.startTime === startTime && s.stageName === 'public')) continue;
            info.isSeadrop = true;
            info.stages.push({
              stageName: `stage_${i}`,
              mintPrice: stageInfo.mintPrice ? ethers.formatEther(stageInfo.mintPrice) : null,
              startTime: startTime > 0 ? startTime : null,
              endTime: endTime > 0 ? endTime : null,
              startTimeISO: startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
              endTimeISO: endTime > 0 ? new Date(endTime * 1000).toISOString() : null,
              maxPerWallet: Number(stageInfo.maxTotalMintSupplyByWallet) || null,
              maxSupply: Number(stageInfo.maxTokenSupplyForStage) || null,
              isActive: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now),
              isPast: endTime > 0 && endTime <= now,
              isFuture: startTime > 0 && startTime > now,
              status: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now) ? 'active'
                : startTime > 0 && startTime > now ? 'upcoming'
                : endTime > 0 && endTime <= now ? 'ended'
                : 'unknown',
            });
          } catch {}
        }
      } catch {}
    }

    // If not Seadrop, try reading schedule from contract directly
    if (!info.isSeadrop) {
      try {
        const nft = new Contract(contractAddress, COMMON_MINT_ABI, this.walletManager.getProvider());
        const stages: MintStage[] = [];

        // Try common schedule functions
        try {
          const saleStartTime = Number(await nft.saleStartTime?.());
          if (saleStartTime > 0) {
            stages.push({
              stageName: 'sale',
              mintPrice: null,
              startTime: saleStartTime,
              endTime: null,
              startTimeISO: new Date(saleStartTime * 1000).toISOString(),
              endTimeISO: null,
              maxPerWallet: null, maxSupply: null,
              isActive: saleStartTime <= now,
              isPast: false,
              isFuture: saleStartTime > now,
              status: saleStartTime <= now ? 'active' : 'upcoming',
            });
          }
        } catch {}

        try {
          const mintStart = Number(await nft.mintStart?.());
          if (mintStart > 0) {
            stages.push({
              stageName: 'mint',
              mintPrice: null,
              startTime: mintStart,
              endTime: null,
              startTimeISO: new Date(mintStart * 1000).toISOString(),
              endTimeISO: null,
              maxPerWallet: null, maxSupply: null,
              isActive: mintStart <= now,
              isPast: false,
              isFuture: mintStart > now,
              status: mintStart <= now ? 'active' : 'upcoming',
            });
          }
        } catch {}

        if (stages.length > 0) {
          info.stages = stages;
        }
      } catch {}
    }

    return info;
  }

  /**
   * Schedule a mint job at a specific time
   */
  scheduleMint(params: {
    contractAddress: string;
    mintPriceEth: string;
    quantityPerWallet: number;
    walletIndices?: number[];
    concurrent?: number;
    mintFunction?: string;
    scheduledTimeMs: number;   // Unix ms when to execute
  }): ScheduledMintJob {
    const id = `mint_${Date.now()}_${++this.jobCounter}`;
    const now = Date.now();
    const delay = params.scheduledTimeMs - now;

    const job: ScheduledMintJob = {
      id,
      contractAddress: params.contractAddress,
      mintPriceEth: params.mintPriceEth,
      quantityPerWallet: params.quantityPerWallet,
      walletIndices: params.walletIndices || [],
      concurrent: params.concurrent || 3,
      mintFunction: params.mintFunction,
      scheduledTime: params.scheduledTimeMs,
      scheduledTimeISO: new Date(params.scheduledTimeMs).toISOString(),
      createdAt: now,
      status: 'pending',
    };

    this.jobs.set(id, job);

    if (delay <= 0) {
      // Execute immediately
      this.executeJob(id);
    } else {
      // Schedule for later
      const timer = setTimeout(() => {
        this.executeJob(id);
      }, delay);
      this.timers.set(id, timer);
    }

    return job;
  }

  /**
   * Cancel a scheduled mint job
   */
  cancelScheduledMint(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'pending') return false;

    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }

    job.status = 'cancelled';
    return true;
  }

  /**
   * Get all scheduled jobs
   */
  getScheduledMints(): ScheduledMintJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get a specific job
   */
  getScheduledMint(jobId: string): ScheduledMintJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Execute a scheduled mint job
   */
  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'pending') return;

    job.status = 'executing';
    this.timers.delete(jobId);

    try {
      const contractInfo = await this.directMinter.detectContract(job.contractAddress);

      let results: MintResult[];
      if (contractInfo.isMintable || job.mintFunction) {
        results = await this.directMinter.mint({
          contractAddress: job.contractAddress,
          mintPrice: job.mintPriceEth,
          quantity: job.quantityPerWallet,
          walletsToUse: job.walletIndices.length > 0 ? job.walletIndices : undefined,
          concurrent: job.concurrent,
          mintFunction: job.mintFunction || contractInfo.functionSignature || undefined,
        });
      } else {
        results = await this.openSeaMinter.mint({
          contractAddress: job.contractAddress,
          mintPrice: job.mintPriceEth,
          quantity: job.quantityPerWallet,
          walletsToUse: job.walletIndices.length > 0 ? job.walletIndices : undefined,
          concurrent: job.concurrent,
        });
      }

      job.results = results;
      job.status = results.some(r => r.success) ? 'completed' : 'failed';
    } catch (err: any) {
      job.error = err.message?.slice(0, 300) || 'Unknown error';
      job.status = 'failed';
    }
  }
}
