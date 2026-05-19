# Molly Poker

Semi-decentralized Texas Hold'em on Monad. Forked from
[`dxganta/poker-solidity`](https://github.com/dxganta/poker-solidity) (MIT) with
**Molly economics** + a simplified architecture.

## Pot split (locked)

| share | recipient   |
| ---:  | :---        |
| 70%   | winner      |
| 20%   | burn (`0xdead`) |
| 10%   | dev wallet  |

Hardcoded in `MollyPoker.sol` as `WINNER_BPS / BURN_BPS / DEV_BPS`. The 20%
that hits `0xdead` is a real ERC20 `transfer`, so MOLLY is genuinely deflated
every hand. The 10% goes to `0xa424...cb24` (same wallet as MollyStaking
penalty rake).

## Architecture: trusted dealer, on-chain money

The dealer node = a backend service we run (the deployer wallet for v1).
Players never see other players' hole cards mid-hand. Flow:

```
                                        ┌─────────────────┐
              (player)                   │  dealer node    │
                  │                      │  (off-chain)    │
                  │  buyIn(table, amt)   │                 │
                  ├─────────────────────►│                 │
                  │                      │                 │
                  │   ◄── dealCards(hashes)                │
                  │   (raw cards revealed via private chan)│
                  │                      │                 │
                  │  playHand(call|raise|check|fold)       │
                  ├─────────────────────►│                 │
                  │                      │                 │
                  │   ◄── dealCommunityCards(flop/turn/river)
                  │                      │                 │
                  │   ◄── showdown(keys, cards, WINNER)    │
                  │       (commit-reveal + 70/20/10 split) │
                  │                      └─────────────────┘
                  ▼
              (winner)
```

The contract enforces the money flow:
- Who's at the table, what tokens they staked, what they bet
- Commit-reveal verification of hole cards (the dealer commits hashes at
  `dealCards`, reveals the keys at `showdown`)
- The 70/20/10 pot split on every hand

The dealer is trusted for:
- Honest randomness (card dealing)
- Honest reveal at showdown
- Picking the correct winner from the revealed cards

The first two were already trust requirements. We added the third — but the
contract emits a **`CardsRevealed`** event with every player's hole cards +
the community cards. Anyone can plug that into an open-source 7-card
evaluator and verify the winner was chosen correctly. If the dealer cheats,
it's visible in the next block.

## Why not on-chain evaluation?

The upstream fork shipped an on-chain 7-card evaluator via ~600KB of lookup
tables (DpTables + 3 flush + 17 noflush contracts = 21 contracts total).

Two problems:
1. 16 of the 22 lookup contracts exceed EIP-170's 24KB code-size cap. The
   chain rejects the deploy.
2. Even if you split each into 2-3 sub-contracts (~40 contracts total), every
   showdown burns serious gas to run a deterministic computation that anyone
   with a JS hand evaluator can verify off-chain in microseconds.

So we dropped the on-chain evaluator. Same trust radius, ~95% less code.

## Layout

```
contracts/
└── MollyPoker.sol          single contract, 13KB runtime, 46% under cap
                            (was 600KB across 21 contracts in the fork)
test/
└── MollyPoker.test.js      16 tests, all passing
scripts/
├── deploy.js               deploys MollyPoker(burn, dev)
└── verify.js               verifies on monadscan via Etherscan V2
```

## Deploy

```bash
cd poker
npm install
cp .env.example .env
# fill in PRIVATE_KEY + ETHERSCAN_API_KEY

# testnet first
npm run deploy:testnet
npm run verify:testnet

# once tested, mainnet
npm run deploy:mainnet
npm run verify:mainnet
```

Deployer is the standard Molly deployer wallet (`0xB9d4B7...e467f`).
Verification key is from `etherscan.io` (NOT bscscan or monadscan) — Monad
uses Etherscan V2 unified API.

The script writes a deployment record to `deployments/<network>-latest.json`
with the contract address. Read from it in the dealer node / frontend.

## Key changes from upstream

1. **70/20/10 pot split** in `_distributePot()` — `safeTransfer` for burn +
   dev portions, credits the winner's chip balance for the remainder
2. **Off-chain evaluator** — `showdown(_keys, _cards, winner)` accepts the
   dealer's declared winner. Contract verifies the commit-reveal and that
   the winner is in the showdown round
3. **`CardsRevealed` event** — full audit log of every hole card + community
   card for community verification
4. **Fixed `dealCards` bug** — upstream version accessed `round.chips[i]`
   without first sizing the array, which reverts every time. Now properly
   pushes 0s before assigning blinds
5. **SafeERC20** — handles tokens that don't return bool (USDT-style)
6. **ReentrancyGuard** on all token-moving functions
7. **`emergencyRefund`** — owner-only escape hatch if the dealer node
   crashes mid-hand. Doesn't run if the table is in showdown
8. **Solidity 0.8.24** (was 0.8.9) with all math checked
9. **`ActionTaken` event** — every call/raise/check/fold emits an event
   with the amount, so the frontend can render live action history

## v1 scope

- Heads-up only (2 players). Contract supports up to 9.
- Player chooses a table to join, plays a sequence of hands.
- `withdrawChips` between hands.
- No tournaments. No multi-table. No sit-and-go. No re-entry rules.

## License

MIT (same as upstream).
