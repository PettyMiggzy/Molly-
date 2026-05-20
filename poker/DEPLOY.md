# MollyPoker — Mainnet Deploy Walkthrough

5-pass audit clean. 32/32 tests passing. 23.68 KB runtime.

## What you'll have after this

- MollyPoker live on Monad mainnet (chainId 143)
- Verified on monadscan.com
- Owner = the deployer wallet
- Owner-only setup: `setSwapRouter`, `setWhitelistedCreator`, `setPoolFee`
- Anyone holding ≥ 100K MOLLY can `buyIn` to MOLLY tables
- **No hands can start** until the dealer node is built (next milestone)

## Pre-flight

### 1. Funds
Deployer needs MON for gas. Deploy txn is ~3-5M gas. At ~50 gwei that's roughly 0.15-0.25 MON. Top up before you start.

```bash
# Check balance
cast balance 0xB9d4B73bE18914c6d64Bee65a806648370be467f --rpc-url https://rpc.monad.xyz
```

### 2. Environment

In `poker/.env`:
```
PRIVATE_KEY=<deployer private key — NO 0x prefix>
MONAD_RPC=https://attentive-magical-sanctuary.monad-mainnet.quiknode.pro/<your-key>/
ETHERSCAN_API_KEY=<your monadscan / etherscan-v2 key>
```

Make sure `.env` is gitignored (it is).

### 3. Final sanity check

```bash
cd poker
npm install
npx hardhat compile     # should say 17 files, 0 errors
npx hardhat test        # should say 32 passing
```

## Deploy

```bash
npx hardhat run scripts/deploy.js --network monad
```

The script will:
- Print all constructor args + deployer balance
- **Show a 10-second mainnet countdown — Ctrl+C to abort**
- Deploy MollyPoker
- Save the address + record to `deployments/monad-latest.json`
- Print "next steps"

Expected output ends with:
```
✅ MollyPoker deployed at 0x...
   tx: 0x...
   explorer: https://monadscan.com/address/0x...

address copy line for the frontend:
  MOLLY_POKER = "0x..."
```

## Verify on monadscan

```bash
npx hardhat run scripts/verify.js --network monad
```

This reads `deployments/monad-latest.json` and submits the constructor args to monadscan. Output: `✅ verified` (or `↺ already verified` if you re-run).

## Bootstrap (admin setup)

Open `scripts/bootstrap.js` and edit the three constants near the top:

```javascript
// Set when Crust V3 router address on Monad is confirmed:
const SWAP_ROUTER = "0x...";   // or ethers.ZeroAddress to defer

// Add project teams that can create tables:
const WHITELIST = [
  { name: "CHOG team",    address: "0x..." },
  { name: "RENE team",    address: "0x..." },
  { name: "MONWOLF team", address: "0x..." },
];

// Per-token V3 fee tiers (only matters once swapRouter is set):
const POOL_FEES = [
  { token: "0xaCA86430cCCEdbedB35910fC8A5AFEF07dA37777" /* RENE */, fee: 10000 },
];
```

Then run:

```bash
npx hardhat run scripts/bootstrap.js --network monad
```

This is idempotent — safe to re-run if you add more projects later. It only sends txns for state that differs from your config.

## Post-deploy checklist

- [ ] Contract address pasted into frontend (`/poker.html` or a config file)
- [ ] Address pinned in the dealer-node config
- [ ] Anyone needed has the owner address noted for emergency contact
- [ ] X / Telegram announcement drafted (after dealer node is live — currently no gameplay is possible)
- [ ] Backroom page on mollyonmonad.xyz updated to show real table list (currently FREE PLAY vs Mongrod only)

## What CAN'T happen yet

Once deployed, the contract is live but idle. **No real hands until the dealer node ships.** What players CAN do:

- `buyIn` to a MOLLY table → chips deducted from their wallet, sit in contract
- `leaveTable` → chips returned (table state always Inactive)
- `withdrawChips` partial → withdraw any amount up to their stack
- `cashOutBusted` → if a player somehow has < BB chips, anyone can clear them out

What players CANNOT do until the dealer is live:

- Play hands (`dealCards` is owner-only)
- Show down
- Win pots

So even if someone gets impatient and buys in early, they can always leave. **Funds are not at risk between deploy and dealer-node launch.** They're just locked into the contract until withdrawn.

## Rollback

There is no upgrade path. If a critical bug is found post-deploy, the play is:

1. `emergencyRefund(tableId)` for each table to unwind seated players
2. Announce migration to a new deploy
3. Frontend points at new address

There's no `pause`, `selfdestruct`, or proxy. The contract is what it is. Pass-5 audit verdict was "deploy-ready" — risk of post-deploy bug is low but not zero.
