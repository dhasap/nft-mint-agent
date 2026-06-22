import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  buildTxGuardJs,
  DANGEROUS_SELECTORS,
  ETHERS_CDN_URL,
  ETHERS_SRI,
  generateBrowserMintScripts,
} from '../src/browser/inject';
import { WalletManager } from '../src/wallet';
import { DirectMinter } from '../src/mint/direct';
import type { Config } from '../src/config';

// Compile the in-page guard snippet into callable functions so we test the
// EXACT logic that gets injected into the browser, not a re-implementation.
function loadGuard(maxEth: string, allowedTo: string[], allowTyped: boolean) {
  const snippet = buildTxGuardJs(ethers.parseEther(maxEth), allowedTo, allowTyped);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${snippet}\nreturn { __assertSafeTx, __assertTypedDataAllowed };`);
  return factory() as {
    __assertSafeTx: (tx: any) => any;
    __assertTypedDataAllowed: () => void;
  };
}

const MINT_CONTRACT = '0x1111111111111111111111111111111111111111';
const EVIL_CONTRACT = '0x2222222222222222222222222222222222222222';
// mint(uint256) selector — a benign mint call.
const MINT_SELECTOR = '0xa0712d68';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: 'http://127.0.0.1:8545',
    rpcWsUrl: '',
    chain: 'ethereum',
    walletPrivateKeys: [ethers.Wallet.createRandom().privateKey],
    maxGasPriceGwei: 100,
    priorityFeeGwei: 2,
    gasLimitMultiplier: 1.2,
    defaultMintQuantity: 1,
    maxMintPriceEth: 0.5,
    openseaApiKey: '',
    dryRun: true,
    gasMode: 'normal',
    customGasMultiplier: 1,
    ...overrides,
  };
}

describe('injected provider — transaction guard', () => {
  it('allows a normal mint to an allowed contract within the value cap', () => {
    const g = loadGuard('0.5', [MINT_CONTRACT], false);
    expect(() =>
      g.__assertSafeTx({ to: MINT_CONTRACT, data: MINT_SELECTOR + '01', value: ethers.parseEther('0.1') }),
    ).not.toThrow();
  });

  it('blocks setApprovalForAll (wallet-drain vector)', () => {
    const g = loadGuard('0.5', [], false);
    expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: '0xa22cb465deadbeef' })).toThrow(/BLOCKED/);
  });

  it('blocks ERC20/ERC721 approve', () => {
    const g = loadGuard('0.5', [], false);
    expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: '0x095ea7b3deadbeef' })).toThrow(/BLOCKED/);
  });

  it('blocks transferFrom / safeTransferFrom', () => {
    const g = loadGuard('0.5', [], false);
    expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: '0x23b872dd' })).toThrow(/BLOCKED/);
    expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: '0x42842e0e' })).toThrow(/BLOCKED/);
  });

  it('blocks transactions whose value exceeds the cap', () => {
    const g = loadGuard('0.5', [], false);
    expect(() =>
      g.__assertSafeTx({ to: MINT_CONTRACT, data: MINT_SELECTOR, value: ethers.parseEther('0.6') }),
    ).toThrow(/exceeds the configured cap/);
  });

  it('accepts value as a 0x hex string and still enforces the cap', () => {
    const g = loadGuard('0.5', [], false);
    const overCap = '0x' + ethers.parseEther('1').toString(16);
    expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: MINT_SELECTOR, value: overCap })).toThrow(/exceeds/);
  });

  it('blocks destinations outside the allowlist when one is set', () => {
    const g = loadGuard('0.5', [MINT_CONTRACT], false);
    expect(() => g.__assertSafeTx({ to: EVIL_CONTRACT, data: MINT_SELECTOR })).toThrow(/not in the allowed/);
  });

  it('allows any destination when no allowlist is set (selector blocklist still applies)', () => {
    const g = loadGuard('0.5', [], false);
    expect(() => g.__assertSafeTx({ to: EVIL_CONTRACT, data: MINT_SELECTOR })).not.toThrow();
    expect(() => g.__assertSafeTx({ to: EVIL_CONTRACT, data: '0xa22cb465' })).toThrow(/BLOCKED/);
  });

  it('disables typed-data signing by default and allows it only when opted in', () => {
    expect(() => loadGuard('0.5', [], false).__assertTypedDataAllowed()).toThrow(/disabled/);
    expect(() => loadGuard('0.5', [], true).__assertTypedDataAllowed()).not.toThrow();
  });

  it('covers every documented dangerous selector', () => {
    const g = loadGuard('0.5', [], false);
    for (const selector of Object.keys(DANGEROUS_SELECTORS)) {
      expect(() => g.__assertSafeTx({ to: MINT_CONTRACT, data: selector })).toThrow(/BLOCKED/);
    }
  });
});

describe('injected provider — script generation', () => {
  const config = makeConfig();
  const wm = new WalletManager(config);
  const scripts = generateBrowserMintScripts(config, wm, { url: 'https://example.com/mint' });
  const single = scripts.walletScripts[0].injectScript;

  it('loads ethers from a pinned CDN with Subresource Integrity, not the old unpinned CDN', () => {
    expect(single).toContain(ETHERS_CDN_URL);
    expect(single).toContain(ETHERS_SRI);
    expect(single).not.toContain('cdn.ethers.io');
    expect(scripts.multiWalletScript).toContain(ETHERS_SRI);
  });

  it('embeds the safety guard and calls it before sending transactions', () => {
    expect(single).toContain('__assertSafeTx');
    expect(scripts.multiWalletScript).toContain('__assertSafeTx');
    expect(single).toContain('__assertTypedDataAllowed');
  });

  it('keeps typed-data signing disabled by default in generated scripts', () => {
    expect(single).toContain('__ALLOW_TYPED_DATA = false');
  });
});

describe('DirectMinter — MAX_MINT_PRICE_ETH enforcement (defense-in-depth)', () => {
  it('refuses to mint when the per-unit price exceeds the cap, before any network call', async () => {
    const config = makeConfig({ maxMintPriceEth: 0.5 });
    const wm = new WalletManager(config);
    const minter = new DirectMinter(config, wm);

    const results = await minter.mint({
      contractAddress: MINT_CONTRACT,
      mintFunction: 'mint(uint256)', // explicit → skips on-chain detection
      quantity: 1,
      mintPrice: '1.0', // above the 0.5 cap
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/exceeds MAX_MINT_PRICE_ETH/);
    expect(results[0].txHash).toBeNull();
  });
});

describe('fast-mint CLI — price cap regression guard', () => {
  it('still contains the MAX_MINT_PRICE_ETH guard in the source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'fast-mint.mjs'), 'utf-8');
    expect(src).toContain('maxPriceWei');
    expect(src).toContain('livePrice > maxPriceWei');
    expect(src).toMatch(/MAX_MINT_PRICE_ETH/);
  });
});
