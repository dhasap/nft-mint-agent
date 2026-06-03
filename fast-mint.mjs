#!/usr/bin/env node
/**
 * Fast Auto-Mint Script — skip agent layer, direct TX submission
 * Usage: node fast-mint.mjs <target_utc_iso> <quantity> [stage_name]
 * Example: node fast-mint.mjs 2026-05-22T16:30:00Z 1 FCFS
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// === CONFIG ===
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEYS.split(',')[0]; // wallet alpha
const CONTRACT = '0xbb2480d65788b15b2f24db8df6a57ea2aff5f106'; // SeaDrop
const NFT_CONTRACT = '0xaccaa4c23d02de593cd86125fb2c0911cc6e4b94'; // UniPix
const MAX_GAS_GWEI = process.env.MAX_GAS_PRICE_GWEI || '100';
const PRIORITY_FEE = process.env.PRIORITY_FEE_GWEI || '2';

const targetTime = new Date(process.argv[2]).getTime();
const quantity = parseInt(process.argv[3] || '1');
const stageName = process.argv[4] || 'unknown';

if (!targetTime || isNaN(targetTime)) {
  console.error('Usage: node fast-mint.mjs <target_utc_iso> <quantity> [stage_name]');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Minimal ABI for mint(uint256)
const ABI = ['function mint(uint256 quantity) payable'];
const contract = new ethers.Contract(CONTRACT, ABI, wallet);

console.log(`[${new Date().toISOString()}] Fast-mint ready`);
console.log(`  Wallet: ${wallet.address}`);
console.log(`  Contract: ${CONTRACT}`);
console.log(`  Stage: ${stageName}`);
console.log(`  Quantity: ${quantity}`);
console.log(`  Target: ${new Date(targetTime).toISOString()}`);
console.log(`  Current: ${new Date().toISOString()}`);

// === PRE-FETCH nonce + gas ===
const [nonce, feeData] = await Promise.all([
  provider.getTransactionCount(wallet.address, 'pending'),
  provider.getFeeData()
]);

const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits(MAX_GAS_GWEI, 'gwei');
const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits(PRIORITY_FEE, 'gwei');

console.log(`  Nonce: ${nonce}`);
console.log(`  MaxFee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} Gwei`);
console.log(`  PriorityFee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} Gwei`);

// === WAIT until 2 seconds before target ===
const leadTime = 2000; // submit 2 sec early (TX propagation delay)
const now = Date.now();
const waitMs = targetTime - now - leadTime;

if (waitMs > 0) {
  console.log(`[${new Date().toISOString()}] Waiting ${Math.round(waitMs/1000)}s until target...`);
  await new Promise(r => setTimeout(r, waitMs));
}

// === SUBMIT with retries ===
const MAX_RETRIES = 3;
let lastError = null;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n[${new Date().toISOString()}] 🚀 Attempt ${attempt}/${MAX_RETRIES} — SUBMITTING...`);
  
  try {
    // Estimate gas
    let gasLimit;
    try {
      gasLimit = await contract.mint.estimateGas(quantity, { value: 0 });
      gasLimit = BigInt(Math.ceil(Number(gasLimit) * 1.2)); // 1.2x buffer
    } catch (e) {
      console.log(`  ⚠️ Gas estimate failed: ${e.message?.substring(0, 100)}`);
      gasLimit = BigInt(300000); // fallback
    }

    console.log(`  Gas limit: ${gasLimit}`);

    const tx = await contract.mint(quantity, {
      value: 0,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
    });

    console.log(`  ✅ TX submitted: ${tx.hash}`);
    console.log(`  ⏳ Waiting for confirmation...`);

    const receipt = await tx.wait(1);
    
    if (receipt && receipt.status === 1) {
      console.log(`\n  🎉 SUCCESS! Block: ${receipt.blockNumber}`);
      console.log(`  Gas used: ${receipt.gasUsed}`);
      console.log(`  TX: https://etherscan.io/tx/${tx.hash}`);
      
      // Extract token IDs
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      for (const log of receipt.logs) {
        if (log.topics[0] === transferTopic && log.topics.length >= 4) {
          const tokenId = BigInt(log.topics[3]);
          console.log(`  🖼️ Token ID: ${tokenId}`);
        }
      }
      process.exit(0);
    } else {
      console.log(`  ❌ TX reverted!`);
      lastError = 'Transaction reverted';
    }
  } catch (e) {
    const errMsg = e.message || String(e);
    console.log(`  ❌ Error: ${errMsg.substring(0, 200)}`);
    lastError = errMsg;

    // If stage not active yet, wait and retry
    if (errMsg.includes('execution reverted') || errMsg.includes('not started')) {
      console.log(`  Stage might not be active yet, retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    
    // If insufficient funds, no point retrying
    if (errMsg.includes('insufficient funds')) {
      console.log(`  ❌ INSUFFICIENT FUNDS — stopping.`);
      break;
    }

    // For other errors, wait and retry
    await new Promise(r => setTimeout(r, 500));
  }
}

console.log(`\n❌ FAILED after ${MAX_RETRIES} attempts. Last error: ${lastError?.substring(0, 200)}`);
process.exit(1);
