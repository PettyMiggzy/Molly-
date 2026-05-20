/*
   MollyPoker — post-deploy bootstrap

   Reads the latest deployment record and runs admin setup:
     1. setSwapRouter(<crust v3 router>)   [skip if SWAP_ROUTER === ZeroAddress]
     2. setWhitelistedCreator(<addr>, true) for each project in WHITELIST
     3. setPoolFee(<token>, <fee>) for each token in POOL_FEES

   Edit the constants below before running. Idempotent — safe to re-run.

   Usage:
     npx hardhat run scripts/bootstrap.js --network monad
*/

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─── EDIT THESE BEFORE RUNNING ────────────────────────────────────────

// Crust Finance V3 SwapRouter on Monad mainnet — set to ethers.ZeroAddress
// to skip (non-MOLLY tables will raw-transfer rake to dev until you set it).
const SWAP_ROUTER = ethers.ZeroAddress;

// Project addresses allowed to call createTable (besides the owner).
// Format: { name, address }. Owner is auto-whitelisted by the modifier.
const WHITELIST = [
  // { name: "CHOG team",   address: "0x..." },
  // { name: "RENE team",   address: "0x..." },
  // { name: "MONWOLF team", address: "0x..." },
];

// Per-token V3 pool fee tiers (only matters once swapRouter is set).
// Valid: 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%). Default = 10000.
const POOL_FEES = [
  // { token: "0xaCA86430cCCEdbedB35910fC8A5AFEF07dA37777" /* RENE  */, fee: 10000 },
  // { token: "0x148a3a811979e5BF8366FC279B2d67742Fe17777" /* PHUCK */, fee: 10000 },
];

// ─── END EDITS ────────────────────────────────────────────────────────

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const file = path.join(__dirname, "..", "deployments", `${net.name}-latest.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record at ${file}`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));

  const addr = rec.addresses.MollyPoker;
  console.log(`\n┌─────────────────────────────────────────────`);
  console.log(`│  MollyPoker bootstrap`);
  console.log(`│  network:  ${net.name} (chainId ${net.chainId})`);
  console.log(`│  signer:   ${signer.address}`);
  console.log(`│  contract: ${addr}`);
  console.log(`└─────────────────────────────────────────────\n`);

  const mp = await ethers.getContractAt("MollyPoker", addr);

  // Sanity: signer must be the owner
  const owner = await mp.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not owner (${owner})`);
  }

  // 1. setSwapRouter
  if (SWAP_ROUTER !== ethers.ZeroAddress) {
    const current = await mp.swapRouter();
    if (current.toLowerCase() === SWAP_ROUTER.toLowerCase()) {
      console.log(`↺ swapRouter already ${SWAP_ROUTER}`);
    } else {
      console.log(`→ setSwapRouter(${SWAP_ROUTER})...`);
      const tx = await mp.setSwapRouter(SWAP_ROUTER);
      await tx.wait();
      console.log(`  ✓ tx ${tx.hash}`);
    }
  } else {
    console.log(`↺ SWAP_ROUTER is ZeroAddress — skipping (set later via setSwapRouter)`);
  }

  // 2. Whitelist creators
  for (const entry of WHITELIST) {
    const already = await mp.whitelistedCreator(entry.address);
    if (already) {
      console.log(`↺ ${entry.name} (${entry.address}) already whitelisted`);
      continue;
    }
    console.log(`→ setWhitelistedCreator(${entry.name}, true)...`);
    const tx = await mp.setWhitelistedCreator(entry.address, true);
    await tx.wait();
    console.log(`  ✓ tx ${tx.hash}`);
  }

  // 3. Pool fees
  for (const entry of POOL_FEES) {
    const current = await mp.poolFee(entry.token);
    if (Number(current) === entry.fee) {
      console.log(`↺ poolFee[${entry.token}] already ${entry.fee}`);
      continue;
    }
    console.log(`→ setPoolFee(${entry.token}, ${entry.fee})...`);
    const tx = await mp.setPoolFee(entry.token, entry.fee);
    await tx.wait();
    console.log(`  ✓ tx ${tx.hash}`);
  }

  console.log(`\n✅ bootstrap complete\n`);

  // Print current state for sanity
  console.log(`current state:`);
  console.log(`  owner:               ${await mp.owner()}`);
  console.log(`  swapRouter:          ${await mp.swapRouter()}`);
  console.log(`  mollyHoldRequired:   ${ethers.formatEther(await mp.mollyHoldRequired())} MOLLY`);
  console.log(`  totalTables:         ${await mp.totalTables()}`);
  console.log(``);
}

main().catch((e) => { console.error(e); process.exit(1); });
