/*
   TableRunner — per-table state machine.

   Responsibilities (per single tableId):
   - Track which players are connected via WebSocket (separate from on-chain
     seating — a player can be seated on-chain but not connected to dealer)
   - When all seated players signal `ready`, shuffle a deck, compute commit
     hashes, submit dealCards tx, and privately push hole cards to each
     player's WS
   - Listen to chain events for the table: ActionTaken (broadcast), RoundOver
     (submit dealCommunityCards), PotDistributed (hand reset)
   - At round 3 end (river complete), evaluate hands with pokersolver and
     submit showdown tx
   - Reset state between hands

   Players still send their own playHand txs from the frontend; we only OBSERVE
   those via ActionTaken events. The dealer's owner-only role is dealCards,
   dealCommunityCards, and showdown.
*/
import pokersolver from 'pokersolver';
const { Hand } = pokersolver;

import { log, metrics } from './config.js';
import {
  getTablePlayers, getTable, getRound, getCommunityCards,
  dealCards, dealCommunityCards, showdown, emergencyRefund,
  subscribeToTable,
} from './chain.js';
import { shuffleDeck, commitPlayerCards, cardToString, cardToPokersolver } from './deck.js';
import { saveTable, loadTable, clearTable } from './persistence.js';

// Local state machine
const STATE = Object.freeze({
  IDLE:     'IDLE',     // between hands; can start a new one
  DEALING:  'DEALING',  // dealCards tx in flight
  ACTIVE:   'ACTIVE',   // hand in progress; observing rounds
  ADVANCING:'ADVANCING',// dealCommunityCards tx in flight
  SHOWDOWN: 'SHOWDOWN', // showdown tx in flight
});

export class TableRunner {
  constructor(tableId, broadcastFn, sendPrivateFn) {
    this.tableId = tableId;
    this.localState = STATE.IDLE;
    this.broadcast = broadcastFn;       // (type, payload) → all WS at this table
    this.sendPrivate = sendPrivateFn;   // (address, type, payload) → that player's WS only
    this.seatedWs = new Set();          // addresses with an open WS connection
    this.readyPlayers = new Set();      // addresses that have signaled ready

    // Per-hand state — reset between hands
    this.deck = null;
    this.holeCards = new Map();         // address → {card1, card2}
    this.keys = new Map();              // address → uint256 BigInt
    this.communityCards = [];           // accumulating
    this.seatOrder = [];                // address[] in chain seating order at deal time
    this.unsubscribe = null;            // detach chain events on stop()

    // D2 — turn timer state. Frontend countdown is informational; the
    // contract doesn't enforce timeouts. If a player goes AFK the hand
    // stalls until they (or someone, via cashOutBusted on a short stack)
    // moves it along. v2 contract change can add a public timeoutFold.
    this.turnDeadline = null;     // ms timestamp
    this.turnPlayer = null;       // address whose turn it is
    this.turnTimer = null;        // setTimeout handle
    this.TURN_TIMEOUT_MS = 60_000; // 60s soft warning
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToTable(this.tableId, {
      onBuyIn:             (player, amount, received) => this._onBuyIn(player, amount, received),
      onLeftTable:         (player) => this._onLeftTable(player),
      onActionTaken:       (roundId, player, action, amount) =>
                             this._onActionTaken(Number(roundId), player, Number(action), amount),
      onRoundOver:         (roundId) => this._onRoundOver(Number(roundId)),
      onShowdownStarted:   (handNum) => this._onShowdownStarted(Number(handNum)),
      onPotDistributed:    (handNum, winner, tableToken, winnerAmt, burnAmt, devAmt) =>
                             this._onPotDistributed(Number(handNum), winner, winnerAmt.toString(), burnAmt.toString(), devAmt.toString()),
      onCardsDealt:        (handNum) => this._onCardsDealt(Number(handNum)),
      onCommunityCardsDealt: (roundId, cards) =>
                             this._onCommunityCardsDealt(Number(roundId), cards.map(c => Number(c))),
      onEmergencyRefund:   (player, amount) => this._onEmergencyRefund(player, amount.toString()),
    });
    // Restore any persisted state from a previous run (async, fire-and-forget).
    this._restore().catch(e => log.warn(`[t${this.tableId}] restore failed: ${e.message}`));
    log.info(`[t${this.tableId}] runner started`);
  }

  async _restore() {
    const saved = await loadTable(this.tableId);
    if (!saved) return;
    this.localState = saved.localState || 'IDLE';
    this.seatOrder = saved.seatOrder || [];
    this.deck = saved.deck || null;
    this.holeCards = new Map(Object.entries(saved.holeCards || {}));
    this.keys = new Map(Object.entries(saved.keys || {}));
    this.communityCards = saved.communityCards || [];
    log.info(`[t${this.tableId}] restored: ${this.seatOrder.length} seats, state=${this.localState}, deck=${this.deck ? 'present' : 'none'}`);

    // C3 — reconcile pending tx by reading chain state. If the tx mined,
    // chain has the new state and we proceed. If it didn't mine, we discard
    // the optimistic local state (community cards rollback already happens
    // in the helper that wrote them).
    if (saved._pendingTx) {
      log.warn(`[t${this.tableId}] restore: pending ${saved._pendingTx.kind} tx — reconciling against chain`);
      try {
        const t = await getTable(this.tableId);
        const chainCommunity = await getCommunityCards(this.tableId);

        // Case A: chain has more community cards than we recorded as committed
        // → the dealCommunity tx mined. Keep deck/keys, accept the chain state.
        if (chainCommunity.length > (saved.communityCards || []).length) {
          this.communityCards = chainCommunity.map(c => Number(c));
          log.info(`[t${this.tableId}] reconcile: chain has ${chainCommunity.length} community cards, accepted`);
        }

        // Case B (CC re-audit): dealCards mined during the restart window.
        // We persisted with localState=DEALING (pre-tx); chain is now Active
        // but community is empty. Without this fix, _onRoundOver later sees
        // localState=DEALING and refuses to advance → hand stalls forever.
        if (saved._pendingTx.kind === 'dealCards'
            && Number(t.state) === 0          // chain Active
            && chainCommunity.length === 0    // pre-flop
            && this.localState === STATE.DEALING) {
          log.info(`[t${this.tableId}] reconcile: dealCards mined during restart — synthesizing CardsDealt → ACTIVE`);
          this.localState = STATE.ACTIVE;
          this._startTurnTimer();
        }

        // Case C: chain not Active and we had an in-progress hand → showdown
        // completed or emergency-refunded. Drop the in-memory hand.
        if (Number(t.state) !== 0 && this.localState !== STATE.IDLE) {
          log.warn(`[t${this.tableId}] reconcile: chain not Active, resetting hand`);
          await this._resetHand();
          return;
        }
      } catch (e) {
        log.error(`[t${this.tableId}] reconcile failed: ${e.message} — caution advised`);
      }
    }
  }

  async _persist() {
    await saveTable({
      tableId: this.tableId,
      localState: this.localState,
      seatOrder: this.seatOrder,
      deck: this.deck,
      keys: Object.fromEntries(this.keys),
      holeCards: Object.fromEntries(this.holeCards),
      communityCards: this.communityCards,
      _pendingTx: this._pendingTx || null,
    });
  }

  async stop() {
    if (this.unsubscribe) {
      await this.unsubscribe();
      this.unsubscribe = null;
    }
    log.info(`[t${this.tableId}] runner stopped`);
  }

  /* ---------- WS-side interface ---------- */

  addPlayer(address) {
    this.seatedWs.add(address);
    log.debug(`[t${this.tableId}] +ws ${address.slice(0,8)} (${this.seatedWs.size} connected)`);
    // D1 — reconnection: if a hand is in progress AND we have cards stored
    // for this address (from before the disconnect), re-deliver them.
    if (this.localState === STATE.ACTIVE || this.localState === STATE.ADVANCING) {
      const cards = this.holeCards.get(address);
      if (cards) {
        try {
          this.sendPrivate(address, 'your_cards', {
            tableId: this.tableId,
            card1: cards.card1,
            card2: cards.card2,
            card1Str: cardToString(cards.card1),
            card2Str: cardToString(cards.card2),
            reconnected: true,
          });
          log.info(`[t${this.tableId}] re-delivered cards to ${address.slice(0,8)} on reconnect`);
        } catch (e) {
          log.warn(`[t${this.tableId}] re-deliver failed: ${e.message}`);
        }
      }
      // H3 — also re-broadcast the in-flight turn countdown so the
      // reconnecting client sees the same deadline everyone else does
      if (this.turnDeadline && this.turnDeadline > Date.now()) {
        try {
          this.sendPrivate(address, 'turn_started', {
            tableId: this.tableId,
            deadline: this.turnDeadline,
            timeoutMs: Math.max(0, this.turnDeadline - Date.now()),
            reconnected: true,
          });
        } catch (e) {
          log.warn(`[t${this.tableId}] re-send turn_started failed: ${e.message}`);
        }
      }
    }
  }

  removePlayer(address) {
    this.seatedWs.delete(address);
    this.readyPlayers.delete(address);
    log.debug(`[t${this.tableId}] -ws ${address.slice(0,8)} (${this.seatedWs.size} connected)`);
  }

  async setReady(address) {
    this.readyPlayers.add(address);
    this.broadcast('ready_update', {
      tableId: this.tableId,
      readyCount: this.readyPlayers.size,
      readyPlayers: [...this.readyPlayers],
    });
    log.debug(`[t${this.tableId}] ready ${address.slice(0,8)} (${this.readyPlayers.size} ready)`);
    await this._maybeStartHand();
  }

  /* ---------- hand lifecycle ---------- */

  async _maybeStartHand() {
    if (this.localState !== STATE.IDLE) return;

    const tableInfo = await getTable(this.tableId);
    // Contract states: 0=Active, 1=Inactive, 2=Showdown
    if (Number(tableInfo.state) !== 1) {
      log.debug(`[t${this.tableId}] skip start: chain state ${tableInfo.state} (need Inactive)`);
      return;
    }

    const chainPlayers = await getTablePlayers(this.tableId);
    if (chainPlayers.length < 2) {
      log.debug(`[t${this.tableId}] skip start: only ${chainPlayers.length} seated`);
      return;
    }

    // Require ALL chain-seated players to be ready before dealing.
    // Phase D: add timeout that starts with whoever's ready after 60s.
    const allReady = chainPlayers.every(p => this.readyPlayers.has(p));
    if (!allReady) {
      const missing = chainPlayers.filter(p => !this.readyPlayers.has(p));
      log.debug(`[t${this.tableId}] skip start: waiting on ${missing.length} player(s)`);
      return;
    }

    await this._startHand(chainPlayers);
  }

  async _startHand(chainPlayers) {
    this.localState = STATE.DEALING;
    this.seatOrder = [...chainPlayers];
    this.deck = shuffleDeck();
    this.holeCards.clear();
    this.keys.clear();
    this.communityCards = [];

    const hashes = [];
    let cursor = 0;
    for (const addr of chainPlayers) {
      const card1 = this.deck[cursor++];
      const card2 = this.deck[cursor++];
      const { key, card1Hash, card2Hash } = commitPlayerCards(card1, card2);
      this.holeCards.set(addr, { card1, card2 });
      this.keys.set(addr, key);
      hashes.push({ card1Hash, card2Hash });
    }

    log.info(`[t${this.tableId}] starting hand for ${chainPlayers.length} players`);
    metrics.inc('handsStarted');

    // C3 — persist deck/keys BEFORE submitting the dealCards tx. If we crash
    // between tx-submit and tx-confirm, the deck is still on disk and we can
    // reconcile against chain state on restart.
    this._pendingTx = { kind: 'dealCards', startedAt: Date.now() };
    try { await this._persist(); }
    catch (e) { log.warn(`[t${this.tableId}] pre-tx persist failed: ${e.message}`); }

    try {
      await dealCards(this.tableId, hashes);
      metrics.inc('dealCardsTx');
    } catch (e) {
      metrics.inc('txErrors');
      log.error(`[t${this.tableId}] dealCards failed:`, e.shortMessage || e.message);
      this.broadcast('deal_failed', { tableId: this.tableId, reason: 'dealCards tx reverted' });
      this._pendingTx = null;
      await this._resetHand();
      return;
    }
    // Tx confirmed — clear pending marker, repersist with committed state
    this._pendingTx = null;
    await this._persist();

    // Privately notify each seated player of their own cards.
    // Note: only players currently connected via WS will see this. If a player
    // is seated on-chain but disconnected, their cards are knowable only when
    // they come back — the dealer holds them in memory.
    for (const addr of chainPlayers) {
      const cards = this.holeCards.get(addr);
      if (!cards) continue;
      this.sendPrivate(addr, 'your_cards', {
        tableId: this.tableId,
        card1: cards.card1,
        card2: cards.card2,
        card1Str: cardToString(cards.card1),
        card2Str: cardToString(cards.card2),
      });
    }

    // Reset ready-set for next hand
    this.readyPlayers.clear();
    // State will move to ACTIVE on the CardsDealt event from chain
  }

  /* ---------- chain event handlers ---------- */

  _onBuyIn(player, amount, received) {
    this.broadcast('buy_in', {
      tableId: this.tableId,
      player,
      amount: amount.toString(),
      received: received.toString(),
    });
  }

  _onLeftTable(player) {
    this.broadcast('left_table', { tableId: this.tableId, player });
  }

  _onCardsDealt(handNum) {
    this.localState = STATE.ACTIVE;
    this.broadcast('cards_dealt', { tableId: this.tableId, handNum });
    log.info(`[t${this.tableId}] hand ${handNum} dealt, now ACTIVE`);
    // D2 — first turn of the hand begins now
    this._startTurnTimer();
  }

  _onActionTaken(roundId, player, action, amount) {
    const actionNames = ['Check', 'Raise', 'Call', 'Fold'];
    this.broadcast('action_taken', {
      tableId: this.tableId,
      roundId,
      player,
      action,
      actionName: actionNames[action] || `Unknown(${action})`,
      amount: amount.toString(),
    });
    // D2 — after an action, the next non-folded player is up. We don't know
    // who that is server-side without re-reading the round; broadcast a
    // generic "turn_advance" with a deadline so the frontend can show a
    // countdown for whoever the contract designates as next.
    this._startTurnTimer();
  }

  /**
   * D2 — turn timer. Clear any prior timer, set a new deadline, broadcast.
   * The contract has no concept of turn timeouts; this is UX only. The
   * frontend can warn the active player they're about to stall the table.
   */
  _startTurnTimer() {
    this._clearTurnTimer();
    if (this.localState !== STATE.ACTIVE) return;
    this.turnDeadline = Date.now() + this.TURN_TIMEOUT_MS;
    this.broadcast('turn_started', {
      tableId: this.tableId,
      deadline: this.turnDeadline,
      timeoutMs: this.TURN_TIMEOUT_MS,
    });
    this.turnTimer = setTimeout(() => {
      this.broadcast('turn_warning', {
        tableId: this.tableId,
        message: 'turn timeout reached — table is stalled until the current player acts',
      });
      log.warn(`[t${this.tableId}] turn timeout — table stalled`);
    }, this.TURN_TIMEOUT_MS);
    this.turnTimer.unref();
  }

  _clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
  }

  async _onRoundOver(roundId) {
    // H4 — round is over; whoever was on the clock no longer is.
    this._clearTurnTimer();
    this.broadcast('round_over', { tableId: this.tableId, roundId });

    // Deal community cards for the next round, unless we've finished round 3.
    // RoundOver(3) means showdown will follow — the contract emits
    // ShowdownStarted next and we handle it in _onShowdownStarted.
    if (roundId >= 3) return;
    if (this.localState !== STATE.ACTIVE && this.localState !== STATE.ADVANCING) {
      log.warn(`[t${this.tableId}] RoundOver(${roundId}) in unexpected state ${this.localState}`);
      return;
    }
    if (!this.deck) {
      log.warn(`[t${this.tableId}] RoundOver(${roundId}) but no deck (dealer restart?)`);
      return;
    }

    // Determine which cards correspond to the next round
    // Cursor: 2*N players' hole cards already dealt; flop at 2N..2N+3; turn at 2N+3; river at 2N+4
    const N = this.seatOrder.length;
    let nextCards;
    let nextRound;
    if (roundId === 0) {
      // After round 0 (preflop), deal the flop → round 1
      nextRound = 1;
      nextCards = [this.deck[2*N], this.deck[2*N + 1], this.deck[2*N + 2]];
    } else if (roundId === 1) {
      nextRound = 2;
      nextCards = [this.deck[2*N + 3]];
    } else if (roundId === 2) {
      nextRound = 3;
      nextCards = [this.deck[2*N + 4]];
    } else {
      return;
    }

    this.localState = STATE.ADVANCING;
    // C3 — persist the upcoming community cards before tx submission so a
    // crash mid-tx can be reconciled on restart.
    const proposedCommunity = [...this.communityCards, ...nextCards];
    this._pendingTx = { kind: 'dealCommunity', round: nextRound, cards: nextCards, startedAt: Date.now() };
    const prevCommunity = this.communityCards;
    this.communityCards = proposedCommunity;
    try { await this._persist(); }
    catch (e) { log.warn(`[t${this.tableId}] pre-tx persist failed: ${e.message}`); }
    // Roll back the local state until tx confirms — the chain truth is what matters
    this.communityCards = prevCommunity;

    try {
      await dealCommunityCards(this.tableId, nextRound, nextCards);
      metrics.inc('dealCommunityTx');
      this.communityCards.push(...nextCards);
    } catch (e) {
      metrics.inc('txErrors');
      log.error(`[t${this.tableId}] dealCommunityCards(round=${nextRound}) failed:`, e.shortMessage || e.message);
      this.broadcast('deal_failed', { tableId: this.tableId, reason: `dealCommunityCards round ${nextRound} reverted` });
      this._pendingTx = null;
      // C3 case E (CC re-audit) — re-persist so a crash after this point
      // doesn't see a stale _pendingTx pointing to an aborted tx
      try { await this._persist(); }
      catch (perr) { log.warn(`[t${this.tableId}] post-revert persist failed: ${perr.message}`); }
      return;
    }
    this._pendingTx = null;
    await this._persist();
    this.localState = STATE.ACTIVE;
    await this._persist(); // C2 — update on-disk community cards
  }

  _onCommunityCardsDealt(roundId, cards) {
    this.broadcast('community_cards', {
      tableId: this.tableId,
      roundId,
      cards,
      cardStrs: cards.map(cardToString),
    });
    // H2 — new betting round just started on chain. First player of this
    // round is on the clock now.
    this._startTurnTimer();
  }

  async _onShowdownStarted(handNum) {
    // H4 — no further turns this hand
    this._clearTurnTimer();
    if (!this.deck || this.seatOrder.length === 0) {
      log.warn(`[t${this.tableId}] ShowdownStarted but no deck (dealer restart?)`);
      return;
    }
    if (this.localState === STATE.SHOWDOWN) return; // already in flight

    this.broadcast('showdown_started', { tableId: this.tableId, handNum });

    // H5 — Read currentRound from the chain rather than hardcoding round 3.
    // In practice the contract only transitions to Showdown from
    // currentRound==LAST_ROUND (=3), so this is equivalent to hardcoding 3.
    // Pre-river fold-wins do NOT emit ShowdownStarted (the contract calls
    // _distributePot directly and emits PotDistributed only). Keeping this
    // dynamic anyway as defense-in-depth against future contract changes.
    let lastRound;
    try {
      const t = await getTable(this.tableId);
      const roundId = Number(t.currentRound);
      lastRound = await getRound(this.tableId, roundId);
      log.debug(`[t${this.tableId}] showdown reading round ${roundId}`);
    } catch (e) {
      log.error(`[t${this.tableId}] showdown could not read round state: ${e.message}`);
      return;
    }

    // Evaluate hands for non-folded seats in seatOrder
    const liveHands = [];
    for (let i = 0; i < this.seatOrder.length; i++) {
      if (lastRound.folded[i]) continue;
      const addr = this.seatOrder[i];
      const hc = this.holeCards.get(addr);
      if (!hc) continue;
      const handCards = [hc.card1, hc.card2, ...this.communityCards].map(cardToPokersolver);
      const evaluated = Hand.solve(handCards);
      liveHands.push({ addr, hand: evaluated });
    }

    if (liveHands.length === 0) {
      log.error(`[t${this.tableId}] showdown with 0 live hands — cannot proceed`);
      return;
    }

    // pokersolver returns winners as an array. Multiple = tie.
    const winners = Hand.winners(liveHands.map(h => h.hand));

    // C5 — tie handling. The current contract only accepts a single winner,
    // so awarding the entire pot to one tied player would silently transfer
    // funds from the other tied player(s). Until the contract supports split
    // pots, the only fund-safe path is emergencyRefund: returns every
    // player's chips, resets the table.
    if (winners.length > 1) {
      const tiedAddrs = liveHands
        .filter(h => winners.includes(h.hand))
        .map(h => h.addr);
      log.warn(`[t${this.tableId}] TIE detected (${tiedAddrs.length}-way: ${tiedAddrs.map(a => a.slice(0,8)).join(', ')}). Triggering emergencyRefund — no winner takes the pot.`);
      this.broadcast('tie_refund', {
        tableId: this.tableId,
        tiedPlayers: tiedAddrs,
        handDescription: winners[0].descr,
        message: 'Tied hand — pot refunded to all players. Contract split-pot support coming in v2.',
      });
      this.localState = STATE.SHOWDOWN;
      try {
        await emergencyRefund(this.tableId);
      } catch (e) {
        metrics.inc('txErrors');
        log.error(`[t${this.tableId}] emergencyRefund tx failed: ${e.shortMessage || e.message}`);
        this.broadcast('showdown_failed', { tableId: this.tableId, reason: 'emergencyRefund tx reverted — please contact support' });
        this.localState = STATE.IDLE;
      }
      return;
    }

    const winner = liveHands.find(h => winners.includes(h.hand)).addr;
    log.info(`[t${this.tableId}] showdown winner: ${winner} (${winners[0].descr})`);

    // Build keys + cards arrays in seat order (must match exactly)
    const keys  = this.seatOrder.map(a => this.keys.get(a));
    const cards = this.seatOrder.map(a => {
      const c = this.holeCards.get(a);
      // Folded players' cards aren't hash-verified, so any value works
      return c ? { card1: c.card1, card2: c.card2 } : { card1: 0, card2: 0 };
    });

    this.localState = STATE.SHOWDOWN;
    try {
      await showdown(this.tableId, keys, cards, winner);
      metrics.inc('showdownTx');
    } catch (e) {
      metrics.inc('txErrors');
      log.error(`[t${this.tableId}] showdown tx failed:`, e.shortMessage || e.message);
      this.broadcast('showdown_failed', { tableId: this.tableId, reason: 'showdown tx reverted' });
      this.localState = STATE.IDLE;
      return;
    }
  }

  async _onPotDistributed(handNum, winner, winnerAmt, burnAmt, devAmt) {
    metrics.inc('handsCompleted');
    this.broadcast('hand_complete', {
      tableId: this.tableId,
      handNum,
      winner,
      winnerAmount: winnerAmt,
      burnAmount: burnAmt,
      devAmount: devAmt,
    });
    log.info(`[t${this.tableId}] hand ${handNum} complete, winner ${winner.slice(0,8)}, winnings ${winnerAmt}`);
    await this._resetHand();
  }

  async _onEmergencyRefund(player, amount) {
    metrics.inc('emergencyRefunds');
    this.broadcast('emergency_refund', {
      tableId: this.tableId,
      player,
      amount,
    });
    await this._resetHand();
  }

  async _resetHand() {
    this.localState = STATE.IDLE;
    this.deck = null;
    this.holeCards.clear();
    this.keys.clear();
    this.communityCards = [];
    this.seatOrder = [];
    this.readyPlayers.clear();
    this._clearTurnTimer();
    this._pendingTx = null;
    // M7 — await this so a fast back-to-back hand can't have its _persist
    // raced by a stale unlink. Errors are tolerable (file may not exist).
    try { await clearTable(this.tableId); }
    catch (e) { log.warn(`clearTable failed: ${e.message}`); }
  }
}
