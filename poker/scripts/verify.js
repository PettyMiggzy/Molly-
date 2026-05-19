/*
   Verify MollyPoker on monadscan via Etherscan V2.

   Usage:
     npx hardhat run scripts/verify.js --network monadTestnet
     npx hardhat run scripts/verify.js --network monad
*/

const { run, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const BURN_ADDR = "0x000000000000000000000000000000000000dEaD";
const DEV_ADDR  = "0xa424c64aa051cf75749b6377bfc86f20f212cb24";

async function main() {
  const net = network.name;
  const file = path.join(__dirname, "..", "deployments", `${net}-latest.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no deployment record at ${file} — deploy first`);
  }
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const address = rec.addresses.MollyPoker;

  console.log(`\nverifying MollyPoker @ ${address} on ${net}...\n`);

  try {
    await run("verify:verify", {
      address,
      constructorArguments: [BURN_ADDR, DEV_ADDR],
    });
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
