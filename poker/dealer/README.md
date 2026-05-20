# MollyPoker Dealer Node

WebSocket server that runs poker hands off-chain and submits the owner-only txs
(`dealCards`, `dealCommunityCards`, `showdown`) to the deployed MollyPoker
contract.

**Phase A (current):** scaffolding — server boots, auth via wallet signature,
table state reads from chain. Game logic stubbed out.

**Phase B (next):** join_table, action handling, deck shuffle + commit-reveal.

**Phase C:** showdown evaluation via pokersolver + tx submission.

**Phase D:** reconnect, turn timers, frontend wiring.

## Prerequisites

The dealer reads the contract ABI from `../artifacts/`. Make sure you've
compiled the contract first:

```bash
cd ..   # poker/
npx hardhat compile
```

## Setup

```bash
cd dealer
npm install
cp .env.example .env
# edit .env — set MONAD_RPC, DEALER_PRIVATE_KEY (the owner key), MOLLY_POKER_ADDRESS
```

The dealer wallet **must be the contract owner** (currently
`0xB9d4B73bE18914c6d64Bee65a806648370be467f`). Anything else and `dealCards`
will revert.

It must also have MON for tx gas. Keep at least 0.5 MON in there.

## Run locally

```bash
npm start
```

You'll see boot info:

```
[2026-05-20T17:00:00Z] INFO  starting MollyPoker dealer node...
[2026-05-20T17:00:00Z] INFO  contract: 0x61bE14a4...AE99b814
[2026-05-20T17:00:01Z] INFO  chain:    monad (chainId 143)
[2026-05-20T17:00:01Z] INFO  dealer:   0xB9d4B73b...370be467f
[2026-05-20T17:00:01Z] INFO  balance:  70.25 MON
[2026-05-20T17:00:01Z] INFO  owner:    0xB9d4B73b...370be467f
[2026-05-20T17:00:01Z] INFO  ✓ dealer is owner, ready to deal
[2026-05-20T17:00:01Z] INFO  WebSocket server listening on :4001
```

## Run under PM2 (production)

```bash
cd /opt/molly/dealer    # or wherever you cloned it on the droplet
npm install --production
pm2 start src/index.js --name molly-poker-dealer
pm2 save
```

Logs:

```bash
pm2 logs molly-poker-dealer
```

## Smoke test the WebSocket

Use `wscat` (`npm install -g wscat`) or any WS client:

```bash
wscat -c ws://localhost:4001

> {"type":"list_tables"}
< {"type":"tables","tables":[]}

> {"type":"auth_request"}
< {"type":"auth_challenge","nonce":"...","message":"MollyPoker login\n..."}

# sign the message with your wallet, then:
> {"type":"auth_submit","nonce":"...","signature":"0x..."}
< {"type":"auth_ok","address":"0x..."}
```

## Protocol (current — phase A)

### Client → server

| type | payload | auth required |
|:---|:---|:---:|
| `auth_request` | — | no |
| `auth_submit` | `{ nonce, signature }` | no |
| `list_tables` | — | no |
| `table_state` | `{ tableId: number }` | no |
| `join_table` | (not implemented, phase B) | yes |
| `leave_table` | (not implemented, phase B) | yes |
| `action` | (not implemented, phase B) | yes |
| `ready` | (not implemented, phase B) | yes |

### Server → client

| type | when |
|:---|:---|
| `hello` | on connect |
| `auth_challenge` | reply to auth_request |
| `auth_ok` / `auth_fail` | reply to auth_submit |
| `tables` | reply to list_tables |
| `table_state` | reply to table_state |
| `error` | on any error |
| `player_left` | when someone disconnects from a table |
