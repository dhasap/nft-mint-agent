import { ethers } from 'ethers';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate burner wallets.
 *
 * SECURITY:
 *  - Private keys are NEVER printed to stdout (terminal scrollback, shell
 *    history, and CI logs are a common leak vector). Only addresses are shown.
 *  - The output file is written with 0600 (owner read/write only).
 *  - If a password is supplied (argv[3] or WALLET_ENCRYPT_PASSWORD), an
 *    encrypted JSON keystore is written instead of plaintext keys.
 *
 * Usage:
 *   ts-node src/wallet/generate.ts [count] [password?]
 */
async function generateWallets(count: number = 10, password?: string): Promise<void> {
  const addresses: { index: number; address: string }[] = [];
  const privateKeys: string[] = [];
  const encrypted: { index: number; address: string; keystore: string }[] = [];

  for (let i = 0; i < count; i++) {
    // crypto.randomBytes is a CSPRNG — do not replace with Math.random.
    const randomPk = '0x' + crypto.randomBytes(32).toString('hex');
    const wallet = new ethers.Wallet(randomPk);
    addresses.push({ index: i + 1, address: wallet.address });
    if (password) {
      encrypted.push({ index: i + 1, address: wallet.address, keystore: await wallet.encrypt(password) });
    } else {
      privateKeys.push(randomPk);
    }
    console.log(`Wallet ${i + 1}: ${wallet.address}`);
  }

  const writeSecure = (file: string, data: string) => {
    fs.writeFileSync(file, data, { encoding: 'utf-8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
  };

  if (password) {
    const outputPath = path.join(__dirname, '../../wallets.encrypted.json');
    writeSecure(outputPath, JSON.stringify(encrypted, null, 2));
    console.log(`\n🔐 Encrypted keystores saved to ${outputPath} (mode 0600).`);
    console.log('Decrypt at runtime with ethers Wallet.fromEncryptedJson(...) and your password.');
  } else {
    const outputPath = path.join(__dirname, '../../wallets.json');
    const payload = addresses.map((a, idx) => ({ ...a, privateKey: privateKeys[idx] }));
    writeSecure(outputPath, JSON.stringify(payload, null, 2));
    console.log(`\n⚠️  Private keys saved to ${outputPath} (mode 0600, gitignored).`);
    console.log('   Keys were NOT printed to the console. Read the file to copy them into your .env');
    console.log('   (WALLET_PRIVATE_KEYS=key1,key2,...) and delete the file afterwards.');
    console.log('   Tip: re-run with a password to store an encrypted keystore instead:');
    console.log('        ts-node src/wallet/generate.ts ' + count + ' "<password>"');
  }
}

const count = parseInt(process.argv[2] || '10', 10);
const password = process.argv[3] || process.env.WALLET_ENCRYPT_PASSWORD || undefined;
generateWallets(count, password).catch(console.error);
