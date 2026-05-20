# Molly Poker (v2)

Semi-decentralized Texas Hold'em on Monad. **MOLLY is the universal
access pass to a multi-project poker network.**

## Economics

| concept | rule |
| :--- | :--- |
| **Entry** | hold ≥ 100K MOLLY in your wallet to buy in at ANY table |
| **Buy-in token** | each table runs in ONE token (set per-table) |
| **Match creators** | whitelisted projects + admin can create tables |

## Pot split

The rake routing differs based on the table's token:

**MOLLY tables** (`table.token == MOLLY`):
- 70% → winner (chips in MOLLY)
- 20% → 0xdead (burn)
- 10% → dev wallet (MOLLY)

**Non-MOLLY tables** (CHOG, RENE, PHUCK, etc):
- 70% → winner (chips in the table's token — they can withdraw original OR auto-swap to WMON)
- 30% → **auto-swapped to WMON via Crust V3 router → dev wallet**

Admin burns the WMON rake manually later (so the burn ends up in the project's token).

## Withdrawals (the "claim button")

Winners pay their own gas to claim:
- `withdrawChips(amount, tableId)` — returns the table's token
- `withdrawAsWMON(amount, tableId, minWmonOut)` — swaps chips to WMON in the same tx (non-MOLLY tables only)

## Architecture

Trusted-dealer model:
- Dealer node (off-chain) generates random cards, commits hashes on-chain via `dealCards`
- Players play via `playHand` (Call/Raise/Check/Fold) — they pay their own gas
- Dealer reveals cards + declares winner via `showdown(tableId, keys, cards, winner, swapMinOut)`
- Contract verifies commit-reveal, validates winner is in showdown round, emits `CardsRevealed` event (community audit log), distributes pot

For non-MOLLY tables, the dealer passes `swapMinOut` (calculated off-chain from the Crust pool) for slippage protection. If the swap fails, the contract falls back to sending raw tokens to the dev wallet (with `RakeSwapFailed` event).

## Deploy

```bash
cd poker
npm install
cp .env.example .env  # PRIVATE_KEY + ETHERSCAN_API_KEY

# 1. Deploy
npm run deploy:testnet   # or deploy:mainnet
npm run verify:testnet   # or verify:mainnet

# 2. Post-deploy setup (via hardhat console or a script)
#    - setSwapRouter(<Crust V3 SwapRouter address>)
#    - setWhitelistedCreator(<each project wallet>, true)
#    - setPoolFee(<each project token>, 10000)   # 1% V3 tier, default
```

Constructor args (already wired in `scripts/deploy.js`):
- `burnAddr`: `0x000…dEaD`
- `devAddr`: `0xa424…cb24` (same as MollyStaking penalty rake)
- `mollyToken`: `0xB72e6262DAE53cAF167F0966421a0B9782977777`
- `wmon`: `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`
- `swapRouter`: `address(0)` initially — set via `setSwapRouter()` once Crust V3 router address is known

## Admin functions

| function | purpose |
| :--- | :--- |
| `setWhitelistedCreator(addr, bool)` | approve/revoke a project's ability to create tables |
| `setMollyHoldRequired(uint)` | tune the entry gate (default 100K) |
| `setSwapRouter(addr)` | point at the Crust V3 router |
| `setPoolFee(token, fee)` | per-token V3 pool fee tier (100/500/3000/10000 BPS) |
| `emergencyRefund(tableId, [players])` | last-resort chip refund if dealer crashes |

## Trust model

Same as v1: the dealer is trusted to deal cards fairly and reveal them honestly. The `CardsRevealed` event logs all hole + community cards so anyone can independently verify the declared winner with an off-chain hand evaluator.

The dealer is ALSO trusted to:
- Pass a reasonable `swapMinOut` for the rake auto-swap (protects against sandwiches)
- Not collude with one side

If the dealer ever cheats, it's visible in the next block's event log.

## Tests

21 passing in 4s. Covers:
- Constructor sanity, BPS math
- Whitelist gate on createTable
- 100K MOLLY hold check on buyIn
- Withdrawals
- Admin setters
- emergencyRefund

## License

MIT (forked from `dxganta/poker-solidity`).
