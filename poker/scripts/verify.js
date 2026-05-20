/*
   Verify MollyPoker on monadscan.

   Usage:
     npx hardhat run scripts/verify.js --network monadTestnet
     npx hardhat run scripts/verify.js --network monad
*/

const { run, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = network.name;
  const file = path.join(__dirname, "..", "deployments", `${net}-latest.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record at ${file}`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));

  const address = rec.addresses.MollyPoker;
  const args = [rec.burnAddr, rec.devAddr, rec.mollyToken, rec.wmon, rec.swapRouter];

  console.log(`\nverifying MollyPoker @ ${address} on ${net}...\n`);

  try {
    await run("verify:verify", { address, constructorArguments: args });
    console.log("✅ verified");
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already verified")) {
      console.log("↺ already verified");
    } else {
      console.error("❌ verification failed:", e.message);
      throw e;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
