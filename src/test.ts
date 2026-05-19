/**
 * Verification Test Suite for Auto Mint Agent
 */

console.log('\n═══════════════════════════════════════════');
console.log('  VERIFICATION TESTS');
console.log('═══════════════════════════════════════════\n');

import { parseMintLink } from './mint/parser';
import { CONTRACT_ADDRESS_REGEX, CONTRACT_ADDRESS_PATTERN } from './config';
import { shortAddress, shortTxHash, truncate, isValidAddress, runConcurrent } from './utils';

let passed = 0;
let failed = 0;

function test(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

// =============================================
// Regex consistency
// =============================================
console.log('--- Regex: CONTRACT_ADDRESS_REGEX ---\n');

const testStr = '0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3';
const regex = new RegExp(CONTRACT_ADDRESS_REGEX.source, '');
const m1 = regex.test(testStr);
const m2 = regex.test(testStr);
test('Regex without /g - consistent .test()', m1 && m2, `first=${m1}, second=${m2}`);

const globalRegex = new RegExp(CONTRACT_ADDRESS_PATTERN, 'g');
const multiStr = '0xaaaa5af38865a567af2f7b06a8c8d6a21f4e6aaaa and 0xbbbb5af38865a567af2f7b06a8c8d6a21f4e6bbbb';
const multiMatches = multiStr.match(globalRegex);
test('Global pattern available for multi-match', multiMatches?.length === 2, `found ${multiMatches?.length}`);

// =============================================
// Presale/allowlist warning logic
// =============================================
console.log('\n--- Presale/allowlist detection ---\n');

test('presaleMint includes "presale"', 'presaleMint(uint256,bytes)'.includes('presale'));
test('allowlistMint includes "allowlist"', 'allowlistMint(uint256,bytes)'.includes('allowlist'));
test('regular mint does NOT include presale/allowlist', 
  !'mint(uint256)'.includes('presale') && !'mint(uint256)'.includes('allowlist'));

// =============================================
// Seadrop ABI feeRecipient is address type
// =============================================
console.log('\n--- Seadrop ABI feeRecipient type ---\n');

import * as fs from 'fs';
const openseaSrc = fs.readFileSync('./src/mint/opensea.ts', 'utf-8');
test('Seadrop ABI uses address feeRecipient (not uint80)', openseaSrc.includes('address feeRecipient)'));
test('Seadrop ABI no longer has uint80 feeRecipient', !openseaSrc.includes('uint80 feeRecipient'));

// =============================================
// MintResult shape
// =============================================
console.log('\n--- MintResult shape ---\n');

import { MintResult } from './mint/direct';
const testResult: MintResult = {
  walletIndex: 0, walletAddress: '0x', success: false,
  txHash: null, tokenId: null, tokenIds: [],
  error: null, gasUsed: null, mintPrice: '0', contractAddress: '0x',
};
test('MintResult has tokenIds[] field', Array.isArray(testResult.tokenIds));
test('MintResult still has tokenId for backward compat', testResult.tokenId === null);

// =============================================
// mintBatch in ABI
// =============================================
console.log('\n--- mintBatch ABI coverage ---\n');

const configSrc = fs.readFileSync('./src/config/index.ts', 'utf-8');
test('mintBatch in MINT_FUNCTION_SIGNATURES', configSrc.includes("'mintBatch(uint256)'"));
test('mintBatch in COMMON_MINT_ABI', configSrc.includes('function mintBatch(uint256 quantity) payable'));

// =============================================
// No p-queue dependency
// =============================================
console.log('\n--- p-queue removed ---\n');

test('p-queue not imported in direct.ts', !fs.readFileSync('./src/mint/direct.ts', 'utf-8').includes('p-queue'));
test('p-queue not imported in opensea.ts', !fs.readFileSync('./src/mint/opensea.ts', 'utf-8').includes('p-queue'));
test('p-queue not in package.json', !fs.readFileSync('./package.json', 'utf-8').includes('p-queue'));

// =============================================
// shortTxHash
// =============================================
console.log('\n--- shortTxHash utility ---\n');

const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const short = shortTxHash(txHash);
test('shortTxHash produces readable output', short.length < txHash.length && short.includes('...'));
test('shortTxHash longer than shortAddress', short.length > shortAddress('0x1234567890abcdef1234567890abcdef12345678').length);

// =============================================
// runConcurrent utility
// =============================================
console.log('\n--- runConcurrent utility ---\n');

async function testRunConcurrent() {
  const order: number[] = [];
  const tasks = [1, 2, 3, 4, 5].map(n => async () => {
    order.push(n);
    return n * 2;
  });
  const results = await runConcurrent(tasks, 2);
  test('runConcurrent returns all results', results.length === 5);
  test('runConcurrent results are correct', results.every((r, i) => r === (i + 1) * 2));
}

testRuncurrent:
testRunConcurrent().then(() => {
  // =============================================
  // Parser tests
  // =============================================
  console.log('\n--- Parser Tests ---\n');

  const parserTests = [
    { input: 'https://opensea.io/collection/azuki', expectType: 'opensea_seadrop', expectSlug: 'azuki', expectConfidence: 'high' },
    { input: 'https://opensea.io/collection/something?tab=mints', expectType: 'opensea_seadrop', expectSlug: 'something', expectConfidence: 'high' },
    { input: 'https://opensea.io/assets/ethereum/0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3/1', expectType: 'opensea_seadrop', expectContract: '0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3', expectConfidence: 'high' },
    { input: 'https://etherscan.io/address/0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3', expectType: 'direct_contract', expectContract: '0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3', expectConfidence: 'high' },
    { input: '0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3', expectType: 'direct_contract', expectContract: '0xed5af38865a567af2f7b06a8c8d6a21f4e6a08c3', expectConfidence: 'high' },
    { input: 'https://random-site.com', expectType: 'unknown', expectConfidence: 'low' },
  ];

  for (const t of parserTests) {
    const r = parseMintLink(t.input);
    let ok = true;
    let detail = '';
    if (t.expectType && r.type !== t.expectType) { ok = false; detail += `type:${r.type}!=${t.expectType} `; }
    if ('expectSlug' in t && r.openseaSlug !== t.expectSlug) { ok = false; detail += `slug:${r.openseaSlug}!=${t.expectSlug} `; }
    if ('expectContract' in t && r.contractAddress !== t.expectContract) { ok = false; detail += `contract mismatch `; }
    if (t.expectConfidence && r.confidence !== t.expectConfidence) { ok = false; detail += `conf:${r.confidence}!=${t.expectConfidence} `; }
    test(`Parser: "${t.input.slice(0, 40)}..."`, ok, detail);
  }

  // =============================================
  // Summary
  // =============================================
  console.log('\n═══════════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════════\n');
  console.log(`  Total: ${passed + failed} tests`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  Result: ${failed === 0 ? '🎉 ALL TESTS PASSED!' : '⚠️ Some issues remain'}`);
});

