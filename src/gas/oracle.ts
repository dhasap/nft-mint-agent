/**
 * Gas Oracle Module
 *
 * Fetches and manages gas pricing with support for different modes:
 * - eco: 0.8x multiplier (slower but cheaper)
 * - normal: 1x multiplier (default)
 * - aggressive: 1.5x multiplier (faster, higher priority)
 * - custom: user-defined via CUSTOM_GAS_MULTIPLIER env var
 *
 * Caps gas price at MAX_GAS_PRICE_GWEI from config.
 */

import { ethers, Provider } from 'ethers';

export type GasMode = 'eco' | 'normal' | 'aggressive' | 'custom';

export interface GasData {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasPrice: bigint | null;
  mode: GasMode;
  baseFeePerGas: bigint | null;
}

const MODE_MULTIPLIERS: Record<Exclude<GasMode, 'custom'>, number> = {
  eco: 0.8,
  normal: 1.0,
  aggressive: 1.5,
};

const MAX_GAS_PRICE_GWEI_DEFAULT = 100;

export class GasOracle {
  private provider: Provider;
  private mode: GasMode;
  private customMultiplier: number;
  private maxGasPriceGwei: number;

  constructor(
    provider: Provider,
    mode: GasMode = 'normal',
    maxGasPriceGwei: number = MAX_GAS_PRICE_GWEI_DEFAULT,
    customMultiplier: number = 1.0,
  ) {
    this.provider = provider;
    this.mode = mode;
    this.maxGasPriceGwei = maxGasPriceGwei;
    this.customMultiplier = customMultiplier;
  }

  /**
   * Get the multiplier for the current gas mode
   */
  private getMultiplier(): number {
    if (this.mode === 'custom') {
      return this.customMultiplier;
    }
    return MODE_MULTIPLIERS[this.mode];
  }

  /**
   * Cap a gas value at MAX_GAS_PRICE_GWEI
   */
  private capGas(value: bigint): bigint {
    const maxWei = ethers.parseUnits(this.maxGasPriceGwei.toString(), 'gwei');
    return value > maxWei ? maxWei : value;
  }

  /**
   * Fetch current gas data from the provider and apply mode multiplier
   */
  async getGasData(): Promise<GasData> {
    const feeData = await this.provider.getFeeData();
    const multiplier = this.getMultiplier();

    const baseFeePerGas = feeData.gasPrice ?? ethers.parseUnits('20', 'gwei');
    const rawPriorityFee = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('2', 'gwei');
    const rawMaxFee = feeData.maxFeePerGas ?? baseFeePerGas * BigInt(2);

    // Apply mode multiplier
    const scaledPriorityFee = BigInt(Math.ceil(Number(rawPriorityFee) * multiplier));
    const scaledMaxFee = BigInt(Math.ceil(Number(rawMaxFee) * multiplier));

    return {
      maxFeePerGas: this.capGas(scaledMaxFee),
      maxPriorityFeePerGas: this.capGas(scaledPriorityFee),
      gasPrice: feeData.gasPrice ? this.capGas(BigInt(Math.ceil(Number(feeData.gasPrice) * multiplier))) : null,
      mode: this.mode,
      baseFeePerGas: feeData.gasPrice ?? null,
    };
  }

  /**
   * Convenience: get gas overrides ready for a transaction
   */
  async getGasOverrides(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
    const data = await this.getGasData();
    return {
      maxFeePerGas: data.maxFeePerGas,
      maxPriorityFeePerGas: data.maxPriorityFeePerGas,
    };
  }

  /**
   * Get a human-readable summary
   */
  async getSummary(): Promise<string> {
    const data = await this.getGasData();
    const maxFee = ethers.formatUnits(data.maxFeePerGas, 'gwei');
    const priority = ethers.formatUnits(data.maxPriorityFeePerGas, 'gwei');
    return `Mode: ${data.mode} | MaxFee: ${maxFee} gwei | PriorityFee: ${priority} gwei | Cap: ${this.maxGasPriceGwei} gwei`;
  }
}

/**
 * Resolve a GasMode string from env/config value
 */
export function resolveGasMode(value?: string): GasMode {
  const v = (value || 'normal').toLowerCase().trim();
  if (v === 'eco' || v === 'normal' || v === 'aggressive' || v === 'custom') {
    return v;
  }
  return 'normal';
}
