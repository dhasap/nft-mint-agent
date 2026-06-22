// Compile MockSeaDrop.sol, deploy MockSeaDrop + MockSeaDropNFT to Base Sepolia,
// and configure an ACTIVE public drop so fast-mint.mjs can run end-to-end.
const fs = require('fs');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC = 'https://sepolia.base.org';

function compile() {
  const source = fs.readFileSync(require('path').join(__dirname, 'MockSeaDrop.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'MockSeaDrop.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }, optimizer: { enabled: true, runs: 200 } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === 'error');
  (out.errors || []).forEach((e) => console.error(e.formattedMessage));
  if (fatal.length) throw new Error('compile failed');
  const f = out.contracts['MockSeaDrop.sol'];
  return {
    seaDrop: { abi: f['MockSeaDrop'].abi, bytecode: '0x' + f['MockSeaDrop'].evm.bytecode.object },
    nft: { abi: f['MockSeaDropNFT'].abi, bytecode: '0x' + f['MockSeaDropNFT'].evm.bytecode.object },
  };
}

(async () => {
  const { privateKey } = JSON.parse(fs.readFileSync('.testnet-wallet.json', 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log('deployer:', wallet.address, '| balance', ethers.formatEther(await provider.getBalance(wallet.address)), 'ETH');

  const { seaDrop, nft } = compile();

  const sdFactory = new ethers.ContractFactory(seaDrop.abi, seaDrop.bytecode, wallet);
  const sd = await sdFactory.deploy();
  await sd.waitForDeployment();
  const sdAddr = await sd.getAddress();
  console.log('MockSeaDrop:', sdAddr);

  const nftFactory = new ethers.ContractFactory(nft.abi, nft.bytecode, wallet);
  const nftC = await nftFactory.deploy(sdAddr);
  await nftC.waitForDeployment();
  const nftAddr = await nftC.getAddress();
  console.log('MockSeaDropNFT:', nftAddr);

  const now = Math.floor(Date.now() / 1000);
  const drop = {
    mintPrice: ethers.parseEther('0.0005'),
    startTime: now - 60,
    endTime: 0,
    maxTotalMintableByWallet: 10,
    feeBps: 0,
    restrictFeeRecipients: false,
  };
  const tx = await sd.setPublicDrop(nftAddr, drop);
  await tx.wait(1);
  console.log('public drop configured (price 0.0005 ETH, active, maxPerWallet 10)');

  fs.writeFileSync('.fastmint-contracts.json', JSON.stringify({ seaDrop: sdAddr, nft: nftAddr, nftAbi: nft.abi }, null, 2));

  const pd = await sd.getPublicDrop(nftAddr);
  console.log('verify getPublicDrop -> price', ethers.formatEther(pd.mintPrice), 'startTime', pd.startTime.toString(), 'maxPerWallet', pd.maxTotalMintableByWallet.toString());
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
