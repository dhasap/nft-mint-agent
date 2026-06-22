// Compile TestMintNFT.sol and deploy to Base Sepolia using the testnet burner wallet.
const fs = require('fs');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC = 'https://sepolia.base.org';

function compile() {
  const source = fs.readFileSync(require('path').join(__dirname, 'TestMintNFT.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'TestMintNFT.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }, optimizer: { enabled: true, runs: 200 } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  if (out.errors) {
    const fatal = out.errors.filter((e) => e.severity === 'error');
    out.errors.forEach((e) => console.error(e.formattedMessage));
    if (fatal.length) throw new Error('Solidity compile failed');
  }
  const c = out.contracts['TestMintNFT.sol']['TestMintNFT'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

(async () => {
  const { address, privateKey } = JSON.parse(fs.readFileSync('.testnet-wallet.json', 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  const wallet = new ethers.Wallet(privateKey, provider);
  const bal = await provider.getBalance(address);
  console.log(`Deployer: ${address} | chainId ${net.chainId} | balance ${ethers.formatEther(bal)} ETH`);

  const { abi, bytecode } = compile();
  console.log('Compiled. Deploying...');
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  const tx = contract.deploymentTransaction();
  console.log('Deploy tx:', tx.hash);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log('DEPLOYED_CONTRACT=' + addr);

  // Persist deployment info for later steps.
  fs.writeFileSync('.testnet-contract.json', JSON.stringify({ address: addr, deployTx: tx.hash, chainId: Number(net.chainId), abi }, null, 2));

  // Sanity read
  const name = await contract.name();
  const price = await contract.mintPrice();
  console.log(`name=${name} mintPrice=${ethers.formatEther(price)} ETH totalSupply=${await contract.totalSupply()}`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
