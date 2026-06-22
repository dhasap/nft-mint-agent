import { describe, it, expect } from 'vitest';
import {
  CHAIN_IDS,
  OPENSEA_COLLECTION_REGEX,
  CONTRACT_ADDRESS_REGEX,
  MINT_FUNCTION_SIGNATURES,
} from '../src/config';
import { resolveGasMode } from '../src/gas/oracle';

describe('config', () => {
  it('maps the supported chains to the right ids', () => {
    expect(CHAIN_IDS.ethereum).toBe(1);
    expect(CHAIN_IDS.base).toBe(8453);
    expect(CHAIN_IDS.polygon).toBe(137);
    expect(CHAIN_IDS.arbitrum).toBe(42161);
  });

  it('extracts an OpenSea collection slug', () => {
    expect('https://opensea.io/collection/cool-cats'.match(OPENSEA_COLLECTION_REGEX)?.[1]).toBe('cool-cats');
  });

  it('matches a 40-hex contract address', () => {
    expect(CONTRACT_ADDRESS_REGEX.test('0xED5AF388653567Af2F388E6224dC7C4b3241C544')).toBe(true);
  });

  it('includes common mint function signatures', () => {
    expect(MINT_FUNCTION_SIGNATURES).toContain('mint(uint256)');
    expect(MINT_FUNCTION_SIGNATURES.length).toBeGreaterThan(5);
  });
});

describe('resolveGasMode', () => {
  it('accepts known modes', () => {
    expect(resolveGasMode('aggressive')).toBe('aggressive');
    expect(resolveGasMode('ECO')).toBe('eco');
  });
  it('falls back to normal for unknown/empty', () => {
    expect(resolveGasMode('turbo')).toBe('normal');
    expect(resolveGasMode(undefined)).toBe('normal');
  });
});
