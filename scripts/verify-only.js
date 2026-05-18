// scripts/verify-only.js
// Standalone verify for an already-deployed MollyStaking contract.
//
// Run with:
//   npx hardhat run scripts/verify-only.js --network monad
//
// Reads the address from .deployed-address, or set VERIFY_ADDRESS in .env

const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

const MOLLY_TOKEN     = '0xB72e6262DAE53cAF167F0966421a0B9782977777';
const DEV_WALLET      = '0xa424c64aa051cf75749b6377bfc86f20f212cb24';
const MONORAIL_ROUTER = '0x0000000000000000000000000000000000000000';

async function main() {
  let addr = process.env.VERIFY_ADDRESS;
  if (!addr) {
    const p = path.join(__dirname, '..', '.deployed-address');
    if (fs.existsSync(p)) addr = fs.readFileSync(p, 'utf8').trim();
  }
  if (!addr) {
    console.error('✗ No address to verify. Set VERIFY_ADDRESS in .env or deploy first.');
    process.exit(1);
  }

  console.log(`▸ Verifying ${addr}...`);

  console.log('  → Sourcify');
  try {
    await hre.run('verify:sourcify', { address: addr });
    console.log('  ✓ Sourcify done');
  } catch (e) {
    console.log('  ⚠ Sourcify: ' + e.message.split('\n')[0]);
  }

  console.log('  → Monadscan');
  try {
    await hre.run('verify:verify', {
      address: addr,
      constructorArguments: [MOLLY_TOKEN, DEV_WALLET, MONORAIL_ROUTER],
    });
    console.log('  ✓ Monadscan done');
  } catch (e) {
    if (e.message.toLowerCase().includes('already verified')) {
      console.log('  ✓ Already verified');
    } else {
      console.log('  ⚠ Monadscan: ' + e.message.split('\n')[0]);
    }
  }

  console.log('');
  console.log(`  Monadscan: https://monadscan.com/address/${addr}`);
  console.log(`  Sourcify:  https://sourcify.dev/#/lookup/${addr}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
