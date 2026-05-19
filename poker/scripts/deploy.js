/*
   MollyPoker deploy — single contract now

   Forked-but-simplified architecture. The on-chain Evaluator7 +
   600KB of lookup tables from the upstream repo are gone — those
   contracts exceeded the 24KB EVM size limit anyway. The dealer
   node computes the winner off-chain and submits it to showdown();
   the contract verifies the commit-reveal of hole cards and logs
   the full reveal as an event for community verification.

   Usage:
     npx hardhat run scripts/deploy.js --network monadTestnet
     npx hardhat run scripts/deploy.js --network monad
*/

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BURN_ADDR = "0x000000000000000000000000000000000000dEaD";
// Molly dev wallet — same wallet used by MollyStaking penalty rake
const DEV_ADDR  = "0xa424c64aa051cf75749b6377bfc86f20f212cb24";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log("\n┌─────────────────────────────────────────────");
  console.log("│  MollyPoker deploy");
  console.log(`│  network: ${net.name} (chainId ${net.chainId})`);
  console.log(`│  deployer: ${deployer.address}`);
  console.log(`│  burn addr: ${BURN_ADDR}`);
  console.log(`│  dev addr:  ${DEV_ADDR}`);
  console.log("└─────────────────────────────────────────────\n");

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer balance: ${ethers.formatEther(bal)} MON\n`);
  if (bal === 0n) {
    throw new Error("deployer has no MON — fund the wallet first");
  }

  console.log("deploying MollyPoker...");
  const Factory = await ethers.getContractFactory("MollyPoker");
  const mp = await Factory.deploy(BURN_ADDR, DEV_ADDR);
  await mp.waitForDeployment();
  const addr = await mp.getAddress();
  const tx = mp.deploymentTransaction();

  console.log(`\n✅ MollyPoker deployed at ${addr}`);
  console.log(`   tx: ${tx.hash}`);

  const record = {
    network: net.name,
    chainId: Number(net.chainId),
    deployer: deployer.address,
    burnAddr: BURN_ADDR,
    devAddr: DEV_ADDR,
    timestamp: new Date().toISOString(),
    addresses: {
      MollyPoker: addr,
    },
    deployTx: tx.hash,
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outFile = path.join(outDir, `${net.name}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  fs.writeFileSync(
    path.join(outDir, `${net.name}-latest.json`),
    JSON.stringify(record, null, 2)
  );

  console.log(`\nsaved record: ${outFile}`);
  console.log(`\nverify with:\n  npx hardhat run scripts/verify.js --network ${net.name}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
