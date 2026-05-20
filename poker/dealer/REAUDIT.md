# MollyPoker Dealer — Re-audit Package (Post Code Claude Pass 1)

Thanks for the deep audit. Worked through every finding. Summary below; details inline in commit `fix(dealer+frontend): address Code Claude audit`.

## Findings status

### False positives / packaging issues (no code change)
- **C1 — tables.js missing**: file IS in repo at `src/tables.js` (56 lines). The audit package you received was flat — `src/` got stripped. **Confirmed via repo browse**: https://github.com/PettyMiggzy/Molly-/blob/main/poker/dealer/src/tables.js. This package is now in `src/`-structured layout — please re-verify.
- **C2 — getRound state BigInt**: contract returns `bool state` (verified via artifact JSON), not uint8. My getTable() also already converts `t.state` via `Number()` (chain.js:86). Tested `JSON.stringify` on a realistic table_state payload — serializes cleanly with no BigInt anywhere.

### Real fixes shipped

| ID | Fix |
|:---|:---|
| **C3** | Persist-before-tx with `_pendingTx` marker; restart reconciles against chain state (getTable + getCommunityCards). Applied to both dealCards and dealCommunityCards. |
| **C4** | Subscription registry (`_subs` Set). 30s heartbeat via getBlockNumber. 2 consecutive fails → destroy + rebuild eventProvider + replay all subs. |
| **C5** | Tie detection. When `Hand.winners(...).length > 1`, call `emergencyRefund(tableId)` instead of awarding pot. Broadcast `tie_refund` event with tied addresses + hand description. **No more silent fund transfer on ties.** |
| **C6** | URL parser strips path entirely. Verified with `SUPER-SECRET-KEY-XYZ` test URL: logs show `wss://...quiknode.pro (path hidden)`, no key. |
| **H1** | Frontend ABI now matches actual contract — `getRound returns (bool state, uint256 turn, address[] players, uint256 highestChip, uint256[] roundChips, bool[] folded, uint256 actsSinceReset)`. renderRoom uses `round.roundChips[i]`. |
| **H2** | `_startTurnTimer()` also called in `_onCommunityCardsDealt` so the flop/turn/river all start with a fresh countdown. |
| **H3** | `addPlayer()` re-broadcasts `turn_started` to the reconnecting player if `turnDeadline > Date.now()`. |
| **H4** | `_clearTurnTimer()` at top of both `_onRoundOver` and `_onShowdownStarted`. |
| **H5** | Reads `getTable().currentRound` instead of hardcoded `3`. Pre-river fold-win paths now use the correct round's folded[] array. |
| **H6** | `onNewTableCreated` subscribed in `index.js` boot. Invalidates cache + pre-warms runner so per-table subs are in place from the moment the table exists. |
| **M2** | All `innerHTML` interpolation in poker-live.html replaced with createElement + textContent + addEventListener. Affected: log(), renderTableList(), renderWalletBar(). Buttons attach handlers via addEventListener instead of inline onclick. |
| **M3** | 30s ws.ping() reaper. `ws.isAlive` flag flipped to false before each ping, set true on pong. Stale sockets terminated. |
| **M4** | TRUST_PROXY now gated on `req.socket.remoteAddress` being loopback (`127.x`, `::1`, `::ffff:127.x`). Direct connections to `:4001` can't spoof XFF. |
| **M5** | `saveTable` catch block also `fs.unlink(tmp).catch(()=>{})`. |
| **M6** | Corrupt JSON quarantined to `table-N.json.broken-<timestamp>` with ERROR log, not silently dropped. |
| **M7** | `_resetHand` made async; awaits `clearTable`. Callers `_onPotDistributed`/`_onEmergencyRefund` also async now. |
| **M8** | `accountsChanged` → toast + soft-disconnect to lobby (no auto on-chain `leaveTable`). `chainChanged` still reloads. |
| **M10** | 15s lobby auto-refresh when not in a room. |

### Deferred (acknowledged, not blocking)
- **H7** — N+1 chain reads. Performance not correctness; Promise.all + per-iter try/catch in a later pass.
- **M9** — Generic `redeliver` request type. Reconnect covers most cases; will add if frozen-but-not-dropped sockets prove common in production.
- **L*** — Cosmetic nits. `onEvent` dead-code kept for future test harness. `getDealerKey` one-shot is intentional (defense vs accidental second-import; tests use mocks).

## Specifically what I want re-checked

1. **C4 reconnect race**: rebuild calls `eventContract.on(filter, h)` against the new contract. ethers v6's `.on` is synchronous; the filter object is rebuilt from the same `name/args` so the topic hash matches. Sanity check: am I missing anything subtle about how ethers internally deduplicates listeners? My `_subs` Set holds the original handler reference, so re-adding it post-rebuild should attach to the new contract cleanly.

2. **C5 race vs the contract's own showdown path**: ShowdownStarted fires, dealer evaluates a tie, dealer calls `emergencyRefund(tableId)`. Between those steps, the contract is in Showdown state. Will `emergencyRefund` revert because of that? Need someone with eyes on `MollyPoker.sol` to confirm the function works from Showdown state, not just Active. If it doesn't, the tie path is still broken.

3. **C3 reconciliation correctness**: `_restore()` reads chain state and decides whether to keep or discard persisted data. The new logic only handles two cases (community cards advanced; chain not Active). Is there a third case I missed? E.g. chain still Active but on a different hand number than we persisted?

4. **H5 round-id choice**: I use `t.currentRound` from the chain at ShowdownStarted time. The contract may have already incremented this past the round that just closed. Is there a "round just settled" hint in any of the events that would be more authoritative?

## Stack stats

| | |
|:---|---:|
| Total source | 3,554 lines |
| Dealer (9 files) | 2,021 lines |
| Frontend (1 file) | 1,533 lines |

## Repo
https://github.com/PettyMiggzy/Molly-/tree/main/poker/dealer

Latest commit: `fix(dealer+frontend): address Code Claude audit — C3-C6, H1-H6, M2-M8, M10`
