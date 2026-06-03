import { ethers } from 'ethers';

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function shortTxHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function truncate(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Simple concurrency limiter (replaces p-queue which is ESM-only in v8+)
 * Runs tasks with at most `concurrency` running at the same time.
 */
export async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number = 3,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      if (i < tasks.length) {
        results[i] = await tasks[i]();
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * BUG-007 FIX: Retry logic with exponential backoff for RPC calls.
 *
 * Distinguishes retryable errors (timeout, rate limit, 429, network errors)
 * from non-retryable errors (insufficient funds, reverted transactions, etc.)
 */
const RETRYABLE_PATTERNS = [
  'timeout',
  'timed out',
  'rate limit',
  '429',
  'too many requests',
  'server error',
  '500',
  '502',
  '503',
  '504',
  'network error',
  'econnrefused',
  'econnreset',
  'socket hang up',
  'request failed',
  'connection refused',
  'nonce too low', // can retry with new nonce
];

const NON_RETRYABLE_PATTERNS = [
  'insufficient funds',
  'insufficient balance',
  'execution reverted',
  'transaction reverted',
  'nonce has already been used',
  'invalid nonce',
  'underflow',
  'overflow',
  'invalid opcode',
  'require(false)',
];

function isRetryableError(err: any): boolean {
  const msg = (err.message || err.reason || '').toLowerCase();
  const code = (err.code || '').toLowerCase();

  // Check non-retryable first (more specific)
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return false;
  }

  // Check retryable patterns
  for (const pattern of RETRYABLE_PATTERNS) {
    if (msg.includes(pattern)) return true;
  }

  // Also check error code
  if (code === 'timeout' || code === 'network_error' || code === 'server_error') return true;

  // Default: not retryable
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt === maxRetries) break;
      if (!isRetryableError(err)) {
        // Non-retryable — throw immediately
        throw err;
      }
      // Exponential backoff: 1s, 2s, 4s, ...
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}
