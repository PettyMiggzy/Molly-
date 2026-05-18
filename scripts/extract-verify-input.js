// scripts/extract-verify-input.js
// Pulls the EXACT standard JSON input that Hardhat fed to solc when it
// compiled MollyStaking.sol — same bytes, same compiler settings, same
// metadata hash that's embedded in the deployed bytecode.
//
// Use the output file to verify on monadscan with:
//   Compiler Type = Solidity (Standard-Json-Input)
//
// Run: node scripts/extract-verify-input.js

const fs = require('fs');
const path = require('path');

const buildInfoDir = path.join(__dirname, '..', 'artifacts', 'build-info');
if (!fs.existsSync(buildInfoDir)) {
  console.error('✗ No artifacts/build-info found. Run `npx hardhat compile` first.');
  process.exit(1);
}

const files = fs.readdirSync(buildInfoDir).filter(f => f.endsWith('.json'));
if (files.length === 0) {
  console.error('✗ No build-info JSON files found.');
  process.exit(1);
}

// Find the build-info that contains MollyStaking
let target = null;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(buildInfoDir, f), 'utf8'));
  const sources = Object.keys(data.input?.sources || {});
  if (sources.some(s => s.includes('MollyStaking'))) {
    target = { file: f, data };
    break;
  }
}

if (!target) {
  console.error('✗ Could not find a build-info containing MollyStaking.sol');
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'monadscan-verify-input.json');
fs.writeFileSync(outPath, JSON.stringify(target.data.input, null, 2));

console.log('━'.repeat(70));
console.log(' ✓ EXTRACTED STANDARD JSON INPUT');
console.log('━'.repeat(70));
console.log('');
console.log(`  Source build-info: artifacts/build-info/${target.file}`);
console.log(`  Output file:       monadscan-verify-input.json`);
console.log(`  Compiler version:  ${target.data.solcLongVersion}`);
console.log('');
console.log('━'.repeat(70));
console.log(' NEXT STEPS');
console.log('━'.repeat(70));
console.log('');
console.log('  1. Go to https://monadscan.com/verifyContract');
console.log(`     For address: 0xFa45c43d74382D99649ecE4CFD2823148A17C912`);
console.log('');
console.log('  2. Compiler Type:  Solidity (Standard-Json-Input)');
console.log(`     Compiler Version: v${target.data.solcLongVersion}`);
console.log('     License:         MIT');
console.log('');
console.log('  3. Upload the file: monadscan-verify-input.json');
console.log('     (same folder you ran this script from)');
console.log('');
console.log('  4. Constructor args ABI-encoded (paste in the box):');
console.log('     000000000000000000000000b72e6262dae53caf167f0966421a0b9782977777000000000000000000000000a424c64aa051cf75749b6377bfc86f20f212cb240000000000000000000000000000000000000000000000000000000000000000');
console.log('');
console.log('  5. Solve captcha → Submit');
console.log('');
console.log('  This bypasses all formatting issues — the JSON is exactly what');
console.log('  Hardhat fed to solc, byte-for-byte. Metadata hash matches.');
console.log('');
