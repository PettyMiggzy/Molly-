/*
   MollyPoker v2 deploy

   Constructor: (burnAddr, devAddr, mollyToken, wmon, swapRouter)

   - swapRouter can be address(0) at deploy time; set via setSwapRouter
     once the Crust Finance V3 router address is confirmed.

   Usage:
     npx hardhat run scripts/deploy.js --network monadTestnet
     npx hardhat run scripts/deploy.js --network monad
*/

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BURN_ADDR  = "0x000000000000000000000000000000000000dEaD";
const DEV_ADDR   = "0xa424c64aa051cf75749b6377bfc86f20f212cb24";

// MOLLY mainnet
const MOLLY_TOKEN_MAINNET = "0xB72e6262DAE53cAF167F0966421a0B9782977777";
// WMON mainnet
const WMON_MAINNET        = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";

// Crust Finance V3 SwapRouter — set via setSwapRouter() post-deploy.
// Leave as zero address for now; admin updates once the live address is in.
const SWAP_ROUTER = ethers.ZeroAddress;

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  let mollyAddr = MOLLY_TOKEN_MAINNET;
  let wmonAddr  = WMON_MAINNET;

  if (Number(net.chainId) === 10143) {
    // testnet: warn if mainnet token addresses won't exist
    console.warn("⚠️  testnet deploy — MOLLY/WMON addresses may not exist on testnet.");
    console.warn("    Set MOLLY_TOKEN_TESTNET + WMON_TESTNET env vars to override.");
    if (process.env.MOLLY_TOKEN_TESTNET) mollyAddr = process.env.MOLLY_TOKEN_TESTNET;
    if (process.env.WMON_TESTNET)        wmonAddr  = process.env.WMON_TESTNET;
  }

  console.log("\n┌─────────────────────────────────────────────");
  console.log("│  MollyPoker v2 deploy");
  console.log(`│  network: ${net.name} (chainId ${net.chainId})`);
  console.log(`│  deployer: ${deployer.address}`);
  console.log(`│  burn:     ${BURN_ADDR}`);
  console.log(`│  dev:      ${DEV_ADDR}`);
  console.log(`│  molly:    ${mollyAddr}`);
  console.log(`│  wmon:     ${wmonAddr}`);
  console.log(`│  router:   ${SWAP_ROUTER}  (set later via setSwapRouter)`);
  console.log("└─────────────────────────────────────────────\n");

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer balance: ${ethers.formatEther(bal)} MON\n`);
  if (bal === 0n) throw new Error("deployer has no MON — fund the wallet first");

  // Production confirmation gate
  if (Number(net.chainId) === 143) {
    console.log("⚠️  MAINNET DEPLOY ⚠️");
    console.log("    Press Ctrl+C now to abort. Deploying in 10s...\n");
    for (let i = 10; i > 0; i--) {
      process.stdout.write(`\r    deploying in ${i}s... `);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log("\n");
  }

  console.log("deploying MollyPoker...");
  const Factory = await ethers.getContractFactory("MollyPoker");
  const mp = await Factory.deploy(BURN_ADDR, DEV_ADDR, mollyAddr, wmonAddr, SWAP_ROUTER);
  await mp.waitForDeployment();
  const addr = await mp.getAddress();
  const tx = mp.deploymentTransaction();

  console.log(`\n✅ MollyPoker deployed at ${addr}`);
  console.log(`   tx: ${tx.hash}`);
  if (net.chainId === 143n) {
    console.log(`   explorer: https://monadscan.com/address/${addr}`);
  } else if (net.chainId === 10143n) {
    console.log(`   explorer: https://testnet.monadscan.com/address/${addr}`);
  }

  const record = {
    network: net.name,
    chainId: Number(net.chainId),
    deployer: deployer.address,
    burnAddr: BURN_ADDR,
    devAddr: DEV_ADDR,
    mollyToken: mollyAddr,
    wmon: wmonAddr,
    swapRouter: SWAP_ROUTER,
    timestamp: new Date().toISOString(),
    addresses: { MollyPoker: addr },
    deployTx: tx.hash,
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(
    path.join(outDir, `${net.name}-${Date.now()}.json`),
    JSON.stringify(record, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, `${net.name}-latest.json`),
    JSON.stringify(record, null, 2)
  );

  console.log("\nnext steps:");
  console.log(`  1. npx hardhat run scripts/verify.js --network ${net.name}`);
  console.log(`  2. Edit scripts/bootstrap.js with Crust router + whitelist projects`);
  console.log(`  3. npx hardhat run scripts/bootstrap.js --network ${net.name}\n`);
  console.log(`address copy line for the frontend:`);
  console.log(`  MOLLY_POKER = "${addr}"\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
