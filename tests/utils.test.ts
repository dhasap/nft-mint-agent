import { describe, it, expect } from 'vitest';
import { isValidAddress, shortAddress, truncate, runConcurrent, withRetry } from '../src/utils';

describe('isValidAddress', () => {
  it('accepts a 40-hex 0x address', () => {
    expect(isValidAddress('0xED5AF388653567Af2F388E6224dC7C4b3241C544')).toBe(true);
  });
  it('rejects malformed addresses', () => {
    expect(isValidAddress('0x123')).toBe(false);
    expect(isValidAddress('not-an-address')).toBe(false);
  });
});

describe('shortAddress / truncate', () => {
  it('shortens an address', () => {
    expect(shortAddress('0xED5AF388653567Af2F388E6224dC7C4b3241C544')).toMatch(/^0x.*\.\.\..*$/);
  });
  it('truncates long text', () => {
    expect(truncate('abcdefghij', 5).length).toBeLessThanOrEqual(8);
  });
});

describe('runConcurrent', () => {
  it('preserves result order regardless of completion order', async () => {
    const tasks = [
      () => new Promise<number>((r) => setTimeout(() => r(1), 30)),
      () => new Promise<number>((r) => setTimeout(() => r(2), 5)),
      () => new Promise<number>((r) => setTimeout(() => r(3), 15)),
    ];
    const out = await runConcurrent(tasks, 2);
    expect(out).toEqual([1, 2, 3]);
  });

  it('limits concurrency to the configured maximum', async () => {
    let active = 0;
    let peak = 0;
    const mk = () => async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--; return 0;
    };
    await runConcurrent([mk(), mk(), mk(), mk(), mk()], 2);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('withRetry', () => {
  it('retries retryable errors then succeeds', async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('network timeout');
      return 'ok';
    }, 3, 1);
    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws immediately on non-retryable errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error('insufficient funds');
    }, 3, 1)).rejects.toThrow(/insufficient funds/);
    expect(calls).toBe(1);
  });
});
