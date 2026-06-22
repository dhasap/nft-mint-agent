/**
 * Pure, side-effect-free gas helpers shared by fast-mint.mjs.
 * Extracted so they can be unit-tested without running the broadcaster.
 */
import { ethers } from 'ethers';

const min = (a, b) => (a < b ? a : b);

/**
 * Compute EIP-1559 gas params from the latest base fee + provider fee data.
 * Priority (tip) defaults are mode-scaled and higher than naive defaults so the
 * transaction is ordered near the front of the block on competitive drops.
 */
export function gasParamsFrom(baseFee, feeData, opts = {}) {
  const capGwei = opts.maxFeeGwei || process.env.MAX_GAS_PRICE_GWEI || '100';
  const mode = String(opts.gasMode || process.env.GAS_MODE || 'aggressive').toLowerCase();
  const defaultPriorityByMode = { eco: '1', normal: '2', aggressive: '5', custom: process.env.CUSTOM_PRIORITY_GWEI || '5' };
  const priorityGwei = opts.priorityGwei || process.env.PRIORITY_FEE_GWEI || defaultPriorityByMode[mode] || '5';
  const cap = ethers.parseUnits(String(capGwei), 'gwei');
  const priorityBase = ethers.parseUnits(String(priorityGwei), 'gwei');
  const mult = mode === 'eco' ? 1.25 : mode === 'normal' ? 2 : mode === 'custom'
    ? Number(process.env.CUSTOM_GAS_MULTIPLIER || '3') : 4;
  const rawBase = baseFee || feeData.gasPrice || ethers.parseUnits('20', 'gwei');
  let priority = feeData.maxPriorityFeePerGas || priorityBase;
  if (priority < priorityBase) priority = priorityBase;
  let maxFee = BigInt(Math.ceil(Number(rawBase) * mult)) + priority;
  maxFee = min(maxFee, cap);
  priority = min(priority, maxFee > rawBase ? maxFee - rawBase : maxFee);
  if (priority <= 0n) priority = 1n;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, mode, cap };
}

/**
 * Replace-by-fee gas bump. EIP-1559 nodes require BOTH maxFee and priority to
 * rise by >=10%; the default factor (1.18 = +18%) satisfies that with margin.
 */
export function bumpGas(prev, factor, cap) {
  const f = (x) => BigInt(Math.ceil(Number(x) * factor));
  let maxFee = min(f(prev.maxFeePerGas), cap);
  let priority = min(f(prev.maxPriorityFeePerGas), maxFee);
  if (priority <= 0n) priority = 1n;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

/** Conservative upfront gas limit; unused gas is refunded on-chain. */
export function defaultGasLimit(qty, base = 650000n) {
  const scaled = 280000n + BigInt(qty) * 60000n;
  return base > scaled ? base : scaled;
}

/** Decide whether a drop is active given a block timestamp (seconds) vs start (seconds). */
export function shouldFireOnBlock(blockTimestampSec, startSec) {
  return Number(blockTimestampSec) >= Number(startSec);
}
