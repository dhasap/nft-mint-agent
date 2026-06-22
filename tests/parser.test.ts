import { describe, it, expect } from 'vitest';
import { parseMintLink } from '../src/mint/parser';

describe('parseMintLink', () => {
  it('detects an OpenSea collection slug', () => {
    const r = parseMintLink('https://opensea.io/collection/azuki');
    expect(r.type).toBe('opensea_seadrop');
    expect(r.openseaSlug).toBe('azuki');
    expect(r.confidence).toBe('high');
  });

  it('detects an OpenSea asset (chain + contract + tokenId)', () => {
    const r = parseMintLink('https://opensea.io/assets/ethereum/0xED5AF388653567Af2F388E6224dC7C4b3241C544/1234');
    expect(r.type).toBe('opensea_seadrop');
    expect(r.contractAddress).toBe('0xED5AF388653567Af2F388E6224dC7C4b3241C544');
    expect(r.tokenId).toBe('1234');
  });

  it('detects a raw contract address as a direct contract', () => {
    const addr = '0xED5AF388653567Af2F388E6224dC7C4b3241C544';
    const r = parseMintLink(addr);
    expect(r.type).toBe('direct_contract');
    expect(r.contractAddress).toBe(addr);
    expect(r.confidence).toBe('high');
  });

  it('maps block-explorer URLs to the right chain', () => {
    const r = parseMintLink('https://basescan.org/address/0xED5AF388653567Af2F388E6224dC7C4b3241C544');
    expect(r.type).toBe('direct_contract');
    expect(r.chain).toBe('base');
  });

  it('strips query/fragment before matching (BUG-018)', () => {
    const r = parseMintLink('https://opensea.io/collection/azuki?tab=mints#top');
    expect(r.openseaSlug).toBe('azuki');
  });

  it('returns unknown for unrecognized input', () => {
    const r = parseMintLink('https://example.com/just-a-page');
    expect(r.type).toBe('unknown');
    expect(r.contractAddress).toBeNull();
  });
});
