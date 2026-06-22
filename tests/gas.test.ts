import { describe, it, expect } from 'vitest';
import { gasParamsFrom, bumpGas, defaultGasLimit, shouldFireOnBlock } from '../lib/fastmint-gas.mjs';
import { ethers } from 'ethers';

const gwei = (n: string | number) => ethers.parseUnits(String(n), 'gwei');

describe('gasParamsFrom', () => {
  const base = gwei(15);
  const feeData = { gasPrice: base, maxPriorityFeePerGas: gwei(1) };

  it('aggressive mode uses a high (>=5 gwei) priority tip', () => {
    const g = gasParamsFrom(base, feeData, { gasMode: 'aggressive' });
    expect(g.mode).toBe('aggressive');
    expect(g.maxPriorityFeePerGas).toBeGreaterThanOrEqual(gwei(5));
    // 4x base + tip = 60 + 5 = 65 gwei
    expect(g.maxFeePerGas).toBe(gwei(65));
  });

  it('respects the maxFee cap', () => {
    const g = gasParamsFrom(gwei(100), feeData, { gasMode: 'aggressive', maxFeeGwei: '120' });
    expect(g.maxFeePerGas).toBeLessThanOrEqual(gwei(120));
  });

  it('priority never exceeds maxFee and is never <= 0', () => {
    const g = gasParamsFrom(gwei(1), { gasPrice: gwei(1) }, { gasMode: 'eco', maxFeeGwei: '2' });
    expect(g.maxPriorityFeePerGas).toBeGreaterThan(0n);
    expect(g.maxPriorityFeePerGas).toBeLessThanOrEqual(g.maxFeePerGas);
  });
});

describe('bumpGas (replace-by-fee)', () => {
  it('raises both maxFee and priority by >=10% (valid EIP-1559 replacement)', () => {
    const prev = { maxFeePerGas: gwei(50), maxPriorityFeePerGas: gwei(5) };
    const cap = gwei(1000);
    const next = bumpGas(prev, 1.18, cap);
    expect(Number(next.maxFeePerGas) / Number(prev.maxFeePerGas)).toBeGreaterThanOrEqual(1.1);
    expect(Number(next.maxPriorityFeePerGas) / Number(prev.maxPriorityFeePerGas)).toBeGreaterThanOrEqual(1.1);
  });

  it('never exceeds the cap', () => {
    const prev = { maxFeePerGas: gwei(95), maxPriorityFeePerGas: gwei(5) };
    const cap = gwei(100);
    const next = bumpGas(prev, 1.5, cap);
    expect(next.maxFeePerGas).toBeLessThanOrEqual(cap);
    expect(next.maxPriorityFeePerGas).toBeLessThanOrEqual(next.maxFeePerGas);
  });
});

describe('defaultGasLimit', () => {
  it('returns the base when it exceeds the scaled estimate', () => {
    expect(defaultGasLimit(1, 650000n)).toBe(650000n);
  });
  it('scales up for large quantities', () => {
    // 280000 + 20*60000 = 1,480,000 > base
    expect(defaultGasLimit(20, 650000n)).toBe(1480000n);
  });
});

describe('shouldFireOnBlock', () => {
  it('fires only when the block timestamp reaches the start time', () => {
    expect(shouldFireOnBlock(1000, 1000)).toBe(true);
    expect(shouldFireOnBlock(1001, 1000)).toBe(true);
    expect(shouldFireOnBlock(999, 1000)).toBe(false);
  });
});
