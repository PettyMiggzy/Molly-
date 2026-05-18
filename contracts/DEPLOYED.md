# DEPLOYED

## MollyStaking — Monad mainnet

| Field | Value |
|---|---|
| **Contract address** | `0xFa45c43d74382D99649ecE4CFD2823148A17C912` |
| Network | Monad mainnet (chain 143) |
| Deploy tx | `0xcc300613adc97a4b5d3b4b3614671155cc0c9aac4fdf7e517297d2264c2a8b4a` |
| Deployer / owner | `0xB9d4B73bE18914c6d64Bee65a806648370be467f` |
| Deploy date | 2026-05-18 |
| Compiler | solc 0.8.24, optimizer enabled, 200 runs, viaIR off, evm `paris` |
| Source | `contracts/MollyStaking.sol` |

## Constructor args

| Param | Value |
|---|---|
| `mollyToken` | `0xB72e6262DAE53cAF167F0966421a0B9782977777` |
| `devWallet_` | `0xa424c64aa051cf75749b6377bfc86f20f212cb24` |
| `monorailRouter_` | `0x0000000000000000000000000000000000000000` (compound disabled at deploy) |

ABI-encoded constructor args (for monadscan verification):
```
000000000000000000000000b72e6262dae53caf167f0966421a0b9782977777000000000000000000000000a424c64aa051cf75749b6377bfc86f20f212cb240000000000000000000000000000000000000000000000000000000000000000
```

## Initial config

- `dailyRateBps`: 100 (1%/day decay)
- `paused`: false
- `monorailRouter`: zero (compound disabled until manually enabled via `setMonorailRouter`)

## Explorer links

- Monadscan: https://monadscan.com/address/0xFa45c43d74382D99649ecE4CFD2823148A17C912
- Sourcify: not supported on Monad mainnet at deploy time

## Function selectors (for raw eth_call)

| Function | Selector |
|---|---|
| `poolStats()` | `0xf540a21f` |
| `userStats(address)` | `0x8a65d874` |
| `userTotalWeight(address)` | `0x19beb249` |
| `stake(uint256,uint256)` | (call directly) |
| `unstake(uint256)` | (call directly) |
| `claim(uint256)` | (call directly) |
| `fundRewards()` | (payable, just send MON) |

## Operational TODO

- [ ] Verify on Monadscan (manual UI or via `scripts/verify-only.js` once ETHERSCAN_API_KEY is set)
- [ ] Fund initial pool with $100 worth of MON via `fundRewards()`
- [ ] Dogfood: stake → claim → unstake with small amounts
- [ ] Set Monorail router once compound integration is tested on testnet
- [ ] Announce publicly
