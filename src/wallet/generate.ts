import { ethers } from 'ethers';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

async function generateWallets(count: number = 10): Promise<void> {
  const wallets: { index: number; address: string; privateKey: string }[] = [];
  const privateKeys: string[] = [];

  for (let i = 0; i < count; i++) {
    const randomPk = '0x' + crypto.randomBytes(32).toString('hex');
    const wallet = new ethers.Wallet(randomPk);
    wallets.push({ index: i + 1, address: wallet.address, privateKey: randomPk });
    privateKeys.push(randomPk);
    console.log(`Wallet ${i + 1}: ${wallet.address}`);
  }

  const outputPath = path.join(__dirname, '../../wallets.json');
  fs.writeFileSync(outputPath, JSON.stringify(wallets, null, 2), 'utf-8');
  console.log(`\nWallet info saved to wallets.json`);
  console.log(`\nAdd to .env WALLET_PRIVATE_KEYS:`);
  console.log(privateKeys.join(','));
}

const count = parseInt(process.argv[2] || '10', 10);
generateWallets(count).catch(console.error);
