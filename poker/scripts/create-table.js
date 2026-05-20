/*
 * Create a new MollyPoker table on Monad mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/create-table.js --network monad
 *
 * Args via env vars (so you don't have to edit the file):
 *   BUY_IN       buy-in amount in TOKENS (auto-converted using token's decimals)
 *   BIG_BLIND    big blind in TOKENS
 *   MAX_PLAYERS  2..9
 *   TOKEN        token contract address (defaults to MOLLY)
 *
 * Example (low-stakes MOLLY heads-up):
 *   PowerShell:
 *     $env:BUY_IN="100000"; $env:BIG_BLIND="1000"; $env:MAX_PLAYERS="2"
 *     npx hardhat run scripts/create-table.js --network monad
 *
 *   Bash:
 *     BUY_IN=100000 BIG_BLIND=1000 MAX_PLAYERS=2 \
 *       npx hardhat run scripts/create-table.js --network monad
 *
 * MOLLY tables route 70% winner / 20% burn / 10% dev. Non-MOLLY tables
 * route 70% winner / 30% dev (rake auto-swapped to dev). Any token must
 * have a Uniswap V3 pool vs WMON at a standard fee tier (the contract's
 * graduation guard), or createTable will revert.
 */
const hre = require("hardhat");

const MOLLY_POKER = "0x3af41a15b41c998C0937310cF1bc45113e5f23fd";
const MOLLY_TOKEN = "0xB72e6262DAE53cAF167F0966421a0B9782977777";

async function main() {
  const buyInStr     = process.env.BUY_IN     ?? "100000";
  const bigBlindStr  = process.env.BIG_BLIND  ?? "1000";
  const maxPlayers   = Number(process.env.MAX_PLAYERS ?? "2");
  const tokenAddr    = process.env.TOKEN ?? MOLLY_TOKEN;

  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 9) {
    throw new Error(`MAX_PLAYERS must be 2..9, got: ${process.env.MAX_PLAYERS}`);
  }

  const [signer] = await hre.ethers.getSigners();
  console.log(`signer: ${signer.address}`);
  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`balance: ${hre.ethers.formatEther(balance)} MON`);

  // Resolve token decimals
  const erc20 = new hre.ethers.Contract(
    tokenAddr,
    ["function decimals() view returns (uint8)", "function symbol() view returns (string)"],
    signer
  );
  const decimals = Number(await erc20.decimals());
  const symbol   = await erc20.symbol();

  const buyIn    = hre.ethers.parseUnits(buyInStr,    decimals);
  const bigBlind = hre.ethers.parseUnits(bigBlindStr, decimals);

  if (buyIn <= 0n)       throw new Error("BUY_IN must be > 0");
  if (bigBlind <= 0n)    throw new Error("BIG_BLIND must be > 0");
  if (bigBlind > buyIn)  throw new Error("BIG_BLIND cannot exceed BUY_IN");

  console.log("");
  console.log("─── new table config ───");
  console.log(`token:        ${tokenAddr} (${symbol})`);
  console.log(`buy-in:       ${buyInStr} ${symbol}  (${buyIn} raw)`);
  console.log(`big blind:    ${bigBlindStr} ${symbol}  (${bigBlind} raw)`);
  console.log(`max players:  ${maxPlayers}`);
  console.log("");

  // Read totalTables before so we know which tableId this becomes
  const poker = await hre.ethers.getContractAt("MollyPoker", MOLLY_POKER, signer);
  const totalBefore = Number(await poker.totalTables());
  console.log(`current totalTables: ${totalBefore} — this will be table #${totalBefore}`);
  console.log("");

  console.log("submitting createTable tx...");
  const tx = await poker.createTable(buyIn, maxPlayers, bigBlind, tokenAddr);
  console.log(`tx hash: ${tx.hash}`);
  console.log("waiting for confirmation...");
  const rcpt = await tx.wait();
  console.log(`✓ confirmed in block ${rcpt.blockNumber} (gas used: ${rcpt.gasUsed})`);
  console.log("");

  const totalAfter = Number(await poker.totalTables());
  console.log(`new totalTables: ${totalAfter}`);
  console.log(`table #${totalAfter - 1} is now live`);
  console.log("");
  console.log("explorer:");
  console.log(`  https://monadscan.com/tx/${tx.hash}`);
}

main().catch((e) => {
  console.error("✗ create-table failed:");
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
