# MollyPoker Dealer Node

WebSocket server that runs poker hands off-chain and submits the owner-only txs
(`dealCards`, `dealCommunityCards`, `showdown`) to the deployed MollyPoker
contract.

## Status

| phase | status | what it adds |
|:---|:---|:---|
| A | ✅ shipped | scaffolding, auth, chain reads, boot gate |
| B | ✅ shipped | deck + commit-reveal + table state machine + game flow handlers |
| C | pending | persistence, frontend wiring, nginx/wss, dealer-wallet migration |
| D | pending | turn timers, reconnection polish, AFK kick, observability |

## Architecture

The dealer is an **orchestrator** — not a relayer. Players submit their own
`playHand` txs from the frontend (call/raise/check/fold). The dealer's
owner-only job is dealCards / dealCommunityCards / showdown — the txs that
involve secret card information.

Flow per hand:

1. Players `buyIn(tableId, amount)` from the frontend → chain emits `NewBuyIn`
2. Players connect WS, send `{type: "auth_request"}` → sign challenge → `auth_ok`
3. Players send `{type: "join_table", tableId}` to register their WS with the dealer
4. When ≥2 seated AND all seated players have sent `{type: "ready"}`, dealer:
   - Shuffles a deck (Fisher-Yates + crypto.randomBytes)
   - Generates per-player 256-bit keys
   - Hashes each card with `keccak256(abi.encodePacked(key, card))`
   - Submits `dealCards(hashes, tableId)`
   - Pushes each player's hole cards to ONLY their WS connection (private)
5. Players send `playHand` txs from frontend → chain emits `ActionTaken`/`RoundOver`
6. On `RoundOver(0)`, dealer submits `dealCommunityCards(tableId, 1, flop)`. Repeat for turn/river.
7. On `ShowdownStarted`, dealer:
   - Reads round 3 from chain (knows who folded)
   - Evaluates each live hand with pokersolver
   - Submits `showdown(tableId, keys, cards, winner)` (which reveals + verifies hashes)
8. `PotDistributed` event closes the hand; runner resets for the next one.

## Prerequisites

```bash
cd ..   # poker/
npx hardhat compile     # produces the ABI dealer loads
```

## Setup

```bash
cd dealer
npm install
cp .env.example .env
# edit .env — set MONAD_RPC, DEALER_PRIVATE_KEY (must be contract owner), MOLLY_POKER_ADDRESS
```

The dealer wallet **must be the contract owner** (currently
`0xB9d4B73bE18914c6d64Bee65a806648370be467f`). Anything else and `dealCards`
will revert.

Keep at least 0.5 MON in the dealer wallet for tx gas.

## Run

Local:
```bash
npm start
```

PM2:
```bash
pm2 start src/index.js --name molly-poker-dealer
pm2 save
```

Default port 4001 (3001 = monpad-server, 3002 = molly-pfp).

## Protocol

### Client → server

| type | payload | auth | rate-limit |
|:---|:---|:---:|:---:|
| `auth_request` | — | no | general |
| `auth_submit` | `{ nonce, signature }` | no | general |
| `list_tables` | — | no | general |
| `table_state` | `{ tableId }` | no | general |
| `join_table` | `{ tableId }` | yes | general |
| `leave_table` | — | yes | general |
| `ready` | — | yes | action (higher) |
| `action` | `{}` (informational only) | yes | action (higher) |

### Server → client (broadcast events)

| type | when |
|:---|:---|
| `hello` | on connect |
| `auth_challenge` | reply to auth_request |
| `auth_ok` / `auth_fail` | reply to auth_submit |
| `tables` | reply to list_tables |
| `table_state` | reply to table_state |
| `joined_table` / `left_table` | reply to join_table / leave_table |
| `ready_ack` / `action_ack` | reply to ready / action |
| `ready_update` | broadcast when any seated player signals ready |
| `buy_in` / `left_table` (broadcast) | chain events |
| `cards_dealt` | dealCards tx mined |
| `your_cards` | **private — only sent to that player's WS** |
| `action_taken` | ActionTaken event broadcast |
| `round_over` | RoundOver event broadcast |
| `community_cards` | CommunityCardsDealt event |
| `showdown_started` | ShowdownStarted event |
| `hand_complete` | PotDistributed event |
| `emergency_refund` | EmergencyRefund event |
| `deal_failed` / `showdown_failed` | dealer tx reverted |
| `error` | per-message errors |

## Rate limits

- **General queries**: 10 messages / 10 sec per connection
- **Action messages** (`ready`, `action`): 60 / 10 sec per connection (higher — poker needs sub-second betting)
- **Connection cap**: 20 connections per IP
- **Message size**: 16 KB max

## Security notes

- v1: dealer key = deployer key = contract owner. **Migrate before mass adoption** — create dedicated dealer wallet, fund with ops MON only, `transferOwnership` to it.
- Auth: SIWE-style. Nonce bound to issuing WS session (no replay across connections).
- Private cards delivered only to the seated player's connection(s). Other players see only hashes until showdown.
- `setSwapRouter` / `setWhitelistedCreator` / etc. remain owner-callable — the dealer holds those keys until v2 splits roles.
