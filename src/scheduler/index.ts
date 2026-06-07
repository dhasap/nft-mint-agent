/**
 * Mint Scheduler - Auto-mint at a scheduled time
 *
 * Reads on-chain mint schedules (Seadrop startTime/endTime)
 * and schedules minting jobs to execute at the right time.
 *
 * BUG-001 FIX: Jobs are now persisted to disk in ./data/scheduled_jobs.json
 * On startup, pending jobs are re-scheduled; expired jobs are marked "missed".
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
import * as fs from 'fs';
import * as path from 'path';
import { Config, COMMON_MINT_ABI } from '../config';
import { WalletManager } from '../wallet';
import { MintResult } from '../mint/direct';
import { DirectMinter } from '../mint/direct';
import { OpenSeaMinter } from '../mint/opensea';
import { shortAddress } from '../utils';

// SeaDrop ABI for reading schedule.
// Current OpenSea SeaDrop V1 uses this tuple layout (uint48 start/end, maxTotalMintableByWallet).
const SEADROP_SCHEDULE_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getFeeRecipientIsAllowed(address nftContract, address feeRecipient) view returns (bool)',
];

// Do not trust a single hardcoded SeaDrop address. Newer mainnet OpenSea drops
// use 0x00005EA00..., while older docs/scripts used 0x00005EA67... (often no code).
const SEADROP_CANDIDATES: Record<number, string[]> = {
  1: [
    '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    '0x00005ea67ac36d4aa7f7be4d33385971bae75dee',
  ],
  8453: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  10: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  137: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
  42161: ['0x00005ea67ac36d4aa7f7be4d33385971bae75dee'],
};

async function resolveSeaDropAddress(provider: ethers.Provider, chainId: number, nftContract: string): Promise<string | null> {
  const candidates = SEADROP_CANDIDATES[chainId] || [];
  for (const candidate of candidates) {
    try {
      const code = await provider.getCode(candidate);
      if (!code || code === '0x') continue;
      const seadrop = new Contract(candidate, SEADROP_SCHEDULE_ABI, provider);
      await seadrop.getPublicDrop(nftContract);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

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
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'missed';
  results?: MintResult[];
  error?: string;
}

// Persistence file path
const PERSISTENCE_DIR = path.join(process.cwd(), 'data');
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'scheduled_jobs.json');

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
    // BUG-001 FIX: Load persisted jobs on startup
    this.loadPersistedJobs();
  }

  /**
   * BUG-001 FIX: Persist all jobs to disk
   */
  private persistJobs(): void {
    try {
      if (!fs.existsSync(PERSISTENCE_DIR)) {
        fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
      }
      const serializable: any[] = [];
      for (const job of this.jobs.values()) {
        // Strip non-serializable fields (results may contain BigInt via receipt)
        serializable.push({
          ...job,
          results: job.results ? job.results.map(r => ({
            ...r,
            gasUsed: r.gasUsed ?? null,
          })) : undefined,
        });
      }
      fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(serializable, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[MintScheduler] Failed to persist jobs: ${err.message}`);
    }
  }

  /**
   * BUG-001 FIX: Load persisted jobs from disk and re-schedule pending ones
   */
  private loadPersistedJobs(): void {
    try {
      if (!fs.existsSync(PERSISTENCE_FILE)) return;
      const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
      const saved: ScheduledMintJob[] = JSON.parse(raw);
      const now = Date.now();

      for (const job of saved) {
        this.jobs.set(job.id, job);
        // Track the counter to avoid ID collisions
        const counterMatch = job.id.match(/mint_\d+_(\d+)/);
        if (counterMatch) {
          const c = parseInt(counterMatch[1], 10);
          if (c > this.jobCounter) this.jobCounter = c;
        }

        if (job.status === 'pending') {
          const delay = job.scheduledTime - now;
          if (delay <= 0) {
            // Expired while we were down — mark as missed
            job.status = 'missed';
            job.error = 'Scheduled time passed while agent was offline';
            console.log(`[MintScheduler] Job ${job.id} missed (expired while offline)`);
          } else {
            // Re-schedule
            const timer = setTimeout(() => {
              this.executeJob(job.id);
            }, delay);
            this.timers.set(job.id, timer);
            console.log(`[MintScheduler] Re-scheduled job ${job.id} — fires in ${Math.round(delay / 1000)}s`);
          }
        }
      }
      this.persistJobs(); // write back with any missed updates
    } catch (err: any) {
      console.error(`[MintScheduler] Failed to load persisted jobs: ${err.message}`);
    }
  }

  /**
   * Read on-chain mint schedule from Seadrop contract
   */
  async getMintSchedule(contractAddress: string): Promise<MintScheduleInfo> {
    const chainId = this.walletManager.getChainId();
    const provider = this.walletManager.getProvider();
    const seadropAddress = await resolveSeaDropAddress(provider, chainId, contractAddress);
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
            mintPrice: publicDrop.mintPrice !== undefined ? ethers.formatEther(publicDrop.mintPrice) : null,
            startTime: startTime > 0 ? startTime : null,
            endTime: endTime > 0 ? endTime : null,
            startTimeISO: startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
            endTimeISO: endTime > 0 ? new Date(endTime * 1000).toISOString() : null,
            maxPerWallet: Number(publicDrop.maxTotalMintableByWallet) || null,
            maxSupply: null,
            isActive: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now),
            isPast: endTime > 0 && endTime <= now,
            isFuture: startTime > 0 && startTime > now,
            status: startTime > 0 && startTime <= now && (endTime === 0 || endTime > now) ? 'active'
              : startTime > 0 && startTime > now ? 'upcoming'
              : endTime > 0 && endTime <= now ? 'ended'
              : 'unknown',
          });
        } catch {}

        // This schedule reader intentionally only reads PublicDrop for current SeaDrop V1.
        // Allowlist/signed/token-gated stages are backend/proof dependent and should not be
        // scheduled as blind public mints. Use browser/OpenSea flow for those.
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

    // BUG-001 FIX: Persist after every change
    this.persistJobs();

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
    // BUG-001 FIX: Persist after cancellation
    this.persistJobs();
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
    this.persistJobs();

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

    // BUG-001 FIX: Persist after execution
    this.persistJobs();
  }
}
