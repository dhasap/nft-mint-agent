import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  generateBrowserMintScripts,
  generateProxyRelayScript,
} from '../src/browser/inject';
import { validateTxRequest } from '../src/browser/proxy-server';
import { WalletManager } from '../src/wallet';
import type { Config } from '../src/config';

const MINT_CONTRACT = '0x1111111111111111111111111111111111111111';
const EVIL = '0x2222222222222222222222222222222222222222';

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

describe('proxy relay script — no private key in the browser', () => {
  const config = makeConfig();
  const wm = new WalletManager(config);
  const proxy = { wsUrl: 'wss://abc.trycloudflare.com', token: 'secret-token-123' };

  it('proxy-mode browser_mint scripts contain NO private key', () => {
    const scripts = generateBrowserMintScripts(config, wm, {
      url: 'https://example.com/mint',
      signing: 'proxy',
      proxy,
    });
    const single = scripts.walletScripts[0].injectScript;
    const wmKey = wm.getAllWallets()[0].wallet.privateKey;
    expect(single).not.toContain(wmKey);
    expect(single).not.toContain('ethers.Wallet(');
    expect(single).toContain(proxy.wsUrl);
    expect(single).toContain('__ADDR');
    expect(scripts.warnings.join(' ')).toMatch(/NEVER ENTER THE BROWSER/i);
  });

  it('embedded mode still embeds the key (legacy fallback unchanged)', () => {
    const scripts = generateBrowserMintScripts(config, wm, { url: 'https://example.com/mint' });
    const wmKey = wm.getAllWallets()[0].wallet.privateKey;
    expect(scripts.walletScripts[0].injectScript).toContain(wmKey);
  });

  it('relay script has no raw key literal at all', () => {
    const relay = generateProxyRelayScript({
      wsUrl: proxy.wsUrl, token: proxy.token,
      address: wm.getAllWallets()[0].address,
      chainId: 1, chainIdHex: '0x1',
    });
    expect(relay).not.toMatch(/0x[a-fA-F0-9]{64}/);
    expect(relay).toContain('token=secret-token-123');
    expect(relay).toContain('__signQ');
    expect(relay).toContain('__bridgeCall');
  });
});

describe('signing proxy — server-side tx validation', () => {
  const args = { chainId: 1, maxValueWei: ethers.parseEther('0.5'), allowedTo: [] as string[], walletAddress: '0x' + 'a'.repeat(40) };

  it('blocks setApprovalForAll (drain vector)', () => {
    const r = validateTxRequest({ to: MINT_CONTRACT, data: '0xa22cb465' + '00'.repeat(32), value: '0x0' }, args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BLOCKED dangerous call/);
  });

  it('blocks approve / transferFrom', () => {
    for (const sel of ['0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde']) {
      const r = validateTxRequest({ to: MINT_CONTRACT, data: sel + '00'.repeat(32) }, args);
      expect(r.ok).toBe(false);
    }
  });

  it('blocks value above the cap (hex & decimal)', () => {
    expect(validateTxRequest({ to: MINT_CONTRACT, data: '0x', value: '0x' + ethers.parseEther('1').toString(16) }, args).ok).toBe(false);
    expect(validateTxRequest({ to: MINT_CONTRACT, data: '0x', value: '1000000000000000000' }, args).ok).toBe(false);
  });

  it('allows a mint call within the cap', () => {
    const r = validateTxRequest({ to: MINT_CONTRACT, data: '0xa0712d68' + '00'.repeat(32), value: '0x' + ethers.parseEther('0.05').toString(16) }, args);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.to.toLowerCase()).toBe(MINT_CONTRACT); expect(r.value).toBe(ethers.parseEther('0.05')); }
  });

  it('enforces the contract allowlist when set', () => {
    const r = validateTxRequest({ to: EVIL, data: '0xa0712d68' + '00'.repeat(32), value: '0x0' }, { ...args, allowedTo: [MINT_CONTRACT] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in the allowed mint-contract list/);
  });

  it('rejects from-mismatch (relay wallet vs tx.from)', () => {
    const r = validateTxRequest({ from: EVIL, to: MINT_CONTRACT, data: '0x', value: '0x0' }, args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/from mismatch/);
  });
});