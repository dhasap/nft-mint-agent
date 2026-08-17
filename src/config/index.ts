import * as dotenv from 'dotenv';
dotenv.config();

export interface Config {
  rpcUrl: string;
  rpcWsUrl: string;
  chain: string;
  walletPrivateKeys: string[];
  maxGasPriceGwei: number;
  priorityFeeGwei: number;
  gasLimitMultiplier: number;
  defaultMintQuantity: number;
  maxMintPriceEth: number;
  openseaApiKey: string;
  dryRun: boolean;
  gasMode: string;
  customGasMultiplier: number;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) throw new Error(`Missing env: ${key}`);
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return defaultValue;
}

export function loadConfig(): Config {
  const privateKeysStr = getEnv('WALLET_PRIVATE_KEYS', '');
  const walletPrivateKeys = privateKeysStr
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);

  return {
    rpcUrl: getEnv('RPC_URL', 'https://eth-mainnet.g.alchemy.com/v2/demo'),
    rpcWsUrl: getEnv('RPC_WS_URL', ''),
    chain: getEnv('CHAIN', 'ethereum'),
    walletPrivateKeys,
    maxGasPriceGwei: getEnvNumber('MAX_GAS_PRICE_GWEI', 100),
    priorityFeeGwei: getEnvNumber('PRIORITY_FEE_GWEI', 2),
    gasLimitMultiplier: getEnvNumber('GAS_LIMIT_MULTIPLIER', 1.2),
    defaultMintQuantity: getEnvNumber('DEFAULT_MINT_QUANTITY', 1),
    maxMintPriceEth: getEnvNumber('MAX_MINT_PRICE_ETH', 0.5),
    openseaApiKey: getEnv('OPENSEA_API_KEY', ''),
    dryRun: getEnvBool('DRY_RUN', false),
    gasMode: getEnv('GAS_MODE', 'normal'),
    customGasMultiplier: getEnvNumber('CUSTOM_GAS_MULTIPLIER', 1.0),
  };
}

export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1, goerli: 5, sepolia: 11155111,
  polygon: 137, arbitrum: 42161, optimism: 10,
  base: 8453, zora: 7777777, blast: 81457, robinhood: 4663,
  // Testnets
  'base-sepolia': 84532, 'optimism-sepolia': 11155420, 'arbitrum-sepolia': 421614,
};

/**
 * BUG-005 FIX: Validate that the configured chain matches the RPC provider's actual chain ID.
 * Call this at startup or before first mint to detect misconfigurations early.
 */
export async function validateChainId(
  provider: import('ethers').Provider,
  config: Config,
): Promise<{ valid: boolean; expected: number; actual: number; error?: string }> {
  const expected = CHAIN_IDS[config.chain] || 1;
  try {
    const network = await provider.getNetwork();
    const actual = Number(network.chainId);
    if (actual !== expected) {
      return {
        valid: false,
        expected,
        actual,
        error: `Chain mismatch: config says "${config.chain}" (chainId ${expected}) but RPC reports chainId ${actual}. Check CHAIN or RPC_URL in .env.`,
      };
    }
    return { valid: true, expected, actual };
  } catch (err: any) {
    return {
      valid: false,
      expected,
      actual: 0,
      error: `Failed to query RPC for chainId: ${err.message?.slice(0, 200)}`,
    };
  }
}

export const OPENSEA_COLLECTION_REGEX = /opensea\.io\/collection\/([a-zA-Z0-9_-]+)/;
export const OPENSEA_ASSET_REGEX = /opensea\.io\/assets\/([a-zA-Z0-9_-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)/;
// No /g flag - avoids stateful lastIndex footgun
// Use new RegExp(CONTRACT_ADDRESS_PATTERN, 'g') when you need global matching
export const CONTRACT_ADDRESS_PATTERN = '0x[a-fA-F0-9]{40}';
export const CONTRACT_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/;

// BUG-013 NOTE: Zora chain (chainId 7777777) uses a different protocol.
// Zora NFTs are minted via Zora's own contracts, not Seadrop.
// The seadropAddress mapping does NOT include Zora; direct contract
// detection will attempt standard mint functions instead.
// If Zora minting fails, users may need to mint via zora.co directly.

export const MINT_FUNCTION_SIGNATURES = [
  'mint(uint256)',
  'mint(address,uint256)',
  'mint(uint256,address)',
  'claim(uint256)',
  'claim(address,uint256)',
  'publicMint(uint256)',
  'mintTo(address,uint256)',
  'safeMint(address)',
  'safeMint(address,uint256)',
  'mintNFT(uint256)',
  'mintBatch(uint256)',
  'freeMint(uint256)',
  'freeMint(address,uint256)',
  'presaleMint(uint256,bytes)',
  'allowlistMint(uint256,bytes)',
];

export const COMMON_MINT_ABI = [
  'function mint(uint256 quantity) payable',
  'function mint(address to, uint256 quantity) payable',
  'function mint(uint256 quantity, address to) payable',
  'function claim(uint256 quantity) payable',
  'function claim(address to, uint256 quantity) payable',
  'function publicMint(uint256 quantity) payable',
  'function mintTo(address to, uint256 quantity) payable',
  'function safeMint(address to) payable',
  'function safeMint(address to, uint256 quantity) payable',
  'function mintNFT(uint256 quantity) payable',
  'function mintBatch(uint256 quantity) payable',
  'function freeMint(uint256 quantity) payable',
  'function freeMint(address to, uint256 quantity) payable',
  'function presaleMint(uint256 quantity, bytes proof) payable',
  'function allowlistMint(uint256 quantity, bytes proof) payable',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function mintRate() view returns (uint256)',
  'function maxPerWallet() view returns (uint256)',
  'function maxMintAmountPerTx() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];
