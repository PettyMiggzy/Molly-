// scripts/deploy.js
// One-command deploy + sourcify verify for MollyStaking.
//
// Run with:
//   npx hardhat run scripts/deploy.js --network monad
//
// Reads DEPLOYER_KEY + RPC from .env (see .env.example).

const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

// Constructor args locked per audit — DO NOT EDIT
const MOLLY_TOKEN     = '0xB72e6262DAE53cAF167F0966421a0B9782977777';
const DEV_WALLET      = '0xa424c64aa051cf75749b6377bfc86f20f212cb24';
const MONORAIL_ROUTER = '0x0000000000000000000000000000000000000000'; // compound disabled initially

async function main() {
  const sep = '━'.repeat(70);
  console.log('');
  console.log(sep);
  console.log(' MollyStaking deploy → Monad mainnet (chain 143)');
  console.log(sep);

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const balanceWei = await hre.ethers.provider.getBalance(deployerAddr);
  const balanceMon = hre.ethers.formatEther(balanceWei);

  console.log(`  RPC:           ${hre.network.config.url}`);
  console.log(`  MOLLY token:   ${MOLLY_TOKEN}`);
  console.log(`  Dev wallet:    ${DEV_WALLET}`);
  console.log(`  Monorail:      ${MONORAIL_ROUTER}  (compound disabled at deploy)`);
  console.log(`  Deployer addr: ${deployerAddr}`);
  console.log(`  Deployer bal:  ${balanceMon} MON`);
  console.log('');

  if (Number(balanceMon) < 0.1) {
    console.error('✗ Deployer balance is < 0.1 MON. Top up before deploying.');
    process.exit(1);
  }

  // ──────── DEPLOY ────────
  console.log('▸ Compiling + deploying...');
  const Factory = await hre.ethers.getContractFactory('MollyStaking');
  const staking = await Factory.deploy(MOLLY_TOKEN, DEV_WALLET, MONORAIL_ROUTER);
  const deployTx = staking.deploymentTransaction();
  console.log(`  tx hash:  ${deployTx.hash}`);
  console.log('  waiting for confirmation...');
  await staking.waitForDeployment();
  const addr = await staking.getAddress();

  console.log('');
  console.log(`✓ Contract deployed at: ${addr}`);

  // Save the address so verify-only can pick it up later if needed
  fs.writeFileSync(
    path.join(__dirname, '..', '.deployed-address'),
    addr + '\n'
  );

  // ──────── WAIT FOR PROPAGATION ────────
  console.log('');
  console.log('▸ Waiting ~30s for chain indexers to catch up before verifying...');
  await new Promise(r => setTimeout(r, 30000));

  // ──────── VERIFY VIA SOURCIFY ────────
  console.log('');
  console.log('▸ Verifying on Sourcify...');
  try {
    await hre.run('verify:sourcify', { address: addr });
    console.log('✓ Sourcify verification complete');
  } catch (e) {
    console.log('⚠ Sourcify verification failed: ' + e.message);
    console.log('  You can retry later:');
    console.log(`    npx hardhat verify:sourcify --network monad ${addr}`);
  }

  // ──────── ALSO TRY MONADSCAN (etherscan-style) ────────
  console.log('');
  console.log('▸ Also attempting Monadscan verification...');
  try {
    await hre.run('verify:verify', {
      address: addr,
      constructorArguments: [MOLLY_TOKEN, DEV_WALLET, MONORAIL_ROUTER],
    });
    console.log('✓ Monadscan verification complete');
  } catch (e) {
    if (e.message.toLowerCase().includes('already verified')) {
      console.log('✓ Already verified (via Sourcify)');
    } else {
      console.log('⚠ Monadscan verification skipped/failed: ' + e.message.split('\n')[0]);
      console.log('  Sourcify verification is what matters — Monadscan often auto-imports it.');
    }
  }

  // ──────── DONE ────────
  console.log('');
  console.log(sep);
  console.log(' ✅ DONE');
  console.log(sep);
  console.log('');
  console.log(`  MollyStaking: ${addr}`);
  console.log(`  Monadscan:    https://monadscan.com/address/${addr}`);
  console.log(`  Sourcify:     https://sourcify.dev/#/lookup/${addr}`);
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Paste the deployed address back to Claude → wire frontend');
  console.log('    2. Test stake/unstake/claim with small amounts');
  console.log(`    3. Fund the pool with MON via fundRewards()`);
  console.log('    4. Later: setMonorailRouter(<router>) to enable compound');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('✗ DEPLOY FAILED');
  console.error(err);
  process.exit(1);
});
