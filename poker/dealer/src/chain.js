/*
   On-chain interface to MollyPoker.

   Reads table state, listens to events, signs+sends owner-only txs
   (dealCards, dealCommunityCards, showdown).

   ABI is loaded from the hardhat artifact, so this stays in sync
   with the compiled contract. Run `npx hardhat compile` in poker/
   before starting the dealer.
*/
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config, log, getDealerKey } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defensive: try both `dealer/src/chain.js` and `dealer/chain.js` layouts
// in case someone flattens the folder. The contract is always compiled into
// `poker/artifacts/contracts/MollyPoker.sol/MollyPoker.json` relative to the
// hardhat root.
const ARTIFACT_CANDIDATES = [
  resolve(__dirname, '../../artifacts/contracts/MollyPoker.sol/MollyPoker.json'), // dealer/src/
  resolve(__dirname, '../artifacts/contracts/MollyPoker.sol/MollyPoker.json'),    // dealer/ (flat)
  resolve(__dirname, './artifacts/contracts/MollyPoker.sol/MollyPoker.json'),     // run-in-place
];

let ABI;
let abiLoadedFrom;
for (const path of ARTIFACT_CANDIDATES) {
  try {
    ABI = JSON.parse(readFileSync(path, 'utf8')).abi;
    abiLoadedFrom = path;
    break;
  } catch { /* try next */ }
}
if (!ABI) {
  log.error(`could not load contract ABI from any of:`);
  ARTIFACT_CANDIDATES.forEach(p => log.error(`  ${p}`));
  log.error(`run 'npx hardhat compile' in poker/ first`);
  process.exit(1);
}
log.debug(`ABI loaded from ${abiLoadedFrom}`);

export const provider = new ethers.JsonRpcProvider(config.rpc);
const wallet = new ethers.Wallet(getDealerKey(), provider);
export const contract = new ethers.Contract(config.contractAddress, ABI, wallet);

/* ---------- WSS event-subscription manager ----------
   ethers v6 WebSocketProvider has no built-in reconnect — if QuickNode drops
   the socket, all subscriptions silently die. We wrap it with a heartbeat
   watchdog: every HEARTBEAT_MS we ping the provider; on consecutive failures
   we destroy + rebuild and re-install all known subscriptions.
*/
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_FAILS_BEFORE_REBUILD = 2;

let eventProvider = null;     // WebSocketProvider or null when HTTP fallback
let eventContract = null;     // Contract bound to the active event provider
let heartbeatTimer = null;
let heartbeatFails = 0;
let _rebuildInProgress = false;

// Registry of active subscriptions so we can replay them after a rebuild.
// Each entry: { name: 'NewBuyIn', args: [tableId], handler: fn }
const _subs = new Set();

function _safeWssUrlLog() {
  try {
    const u = new URL(config.rpcWss);
    return `${u.protocol}//${u.host} (path hidden)`;
  } catch { return '(redacted)'; }
}

function _buildEventStack() {
  if (config.rpcWss) {
    eventProvider = new ethers.WebSocketProvider(config.rpcWss);
    eventContract = new ethers.Contract(config.contractAddress, ABI, eventProvider);
    log.info(`event subscriptions via WSS: ${_safeWssUrlLog()}`);
  } else {
    eventProvider = null;
    eventContract = contract; // share the HTTP-backed contract
    log.info(`event subscriptions via HTTP polling (set MONAD_RPC_WSS for real-time)`);
  }
}

async function _rebuildAndResubscribe() {
  if (_rebuildInProgress) return;
  _rebuildInProgress = true;
  try {
    log.warn(`WSS connection unhealthy — rebuilding (${_subs.size} subs to replay)`);
    // Best-effort tear-down of the old provider
    if (eventProvider && typeof eventProvider.destroy === 'function') {
      try { await eventProvider.destroy(); } catch (e) { log.debug(`old WSS destroy: ${e.message}`); }
    }
    _buildEventStack();
    // Replay every recorded sub against the new eventContract
    for (const sub of _subs) {
      try {
        const filter = sub.args && sub.args.length
          ? eventContract.filters[sub.name](...sub.args)
          : eventContract.filters[sub.name]();
        eventContract.on(filter, sub.handler);
      } catch (e) {
        log.error(`replay sub ${sub.name}(${sub.args.join(',')}) failed: ${e.message}`);
      }
    }
    heartbeatFails = 0;
    log.info(`WSS rebuild complete — ${_subs.size} subs reinstalled`);
  } catch (e) {
    log.error(`WSS rebuild failed: ${e.message}`);
  } finally {
    _rebuildInProgress = false;
  }
}

function _startHeartbeat() {
  if (!config.rpcWss || heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    try {
      // Cheap call — if WSS is dead this rejects fast
      await eventProvider.getBlockNumber();
      if (heartbeatFails > 0) log.debug(`WSS heartbeat ok (recovered)`);
      heartbeatFails = 0;
    } catch (e) {
      heartbeatFails++;
      log.warn(`WSS heartbeat fail ${heartbeatFails}/${HEARTBEAT_FAILS_BEFORE_REBUILD}: ${e.message}`);
      if (heartbeatFails >= HEARTBEAT_FAILS_BEFORE_REBUILD) {
        _rebuildAndResubscribe().catch(err => log.error(`rebuild threw: ${err.message}`));
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

function _stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

_buildEventStack();
_startHeartbeat();

// Exported deliberately as a getter so the address can be inspected/logged but
// the wallet object itself isn't passed around.
export function dealerAddress() { return wallet.address; }

/* ---------- read helpers ---------- */

export async function getTable(tableId) {
  const t = await contract.tables(tableId);
  return {
    state:        Number(t.state), // 0=Active, 1=Inactive, 2=Showdown
    totalHands:   t.totalHands,
    currentRound: Number(t.currentRound),
    buyInAmount:  t.buyInAmount,
    maxPlayers:   Number(t.maxPlayers),
    pot:          t.pot,
    bigBlind:     t.bigBlind,
    token:        t.token,
    creator:      t.creator,
  };
}

export async function getTablePlayers(tableId) {
  return await contract.getTablePlayers(tableId);
}

export async function getRound(tableId, roundId) {
  const r = await contract.getRound(tableId, roundId);
  return {
    state:          r.state,
    turn:           Number(r.turn),
    players:        r.players,
    highestChip:    r.highestChip.toString(),                  // H2 — BigInt → string
    roundChips:     r.roundChips.map(c => c.toString()),       // H2
    folded:         r.folded,
    actsSinceReset: Number(r.actsSinceReset),
  };
}

export async function getCommunityCards(tableId) {
  const cards = await contract.getCommunityCards(tableId);
  return cards.map(c => Number(c));
}

export async function getChips(playerAddr, tableId) {
  return (await contract.chips(playerAddr, tableId)).toString();  // H2
}

export async function getTotalTables() {
  return Number(await contract.totalTables());
}

export async function getDevOwed(token) {
  return (await contract.devOwed(token)).toString();              // H2
}

export async function getOwner() {
  return await contract.owner();
}

/* ---------- write helpers ---------- */

export async function dealCards(tableId, playerCardHashes) {
  // playerCardHashes = [{ card1Hash: bytes32, card2Hash: bytes32 }, ...]
  log.info(`tx dealCards table=${tableId} players=${playerCardHashes.length}`);
  const tx = await contract.dealCards(playerCardHashes, tableId);
  const rcpt = await tx.wait();
  log.info(`✓ dealCards tx=${tx.hash} block=${rcpt.blockNumber}`);
  return rcpt;
}

export async function dealCommunityCards(tableId, roundId, cards) {
  log.info(`tx dealCommunityCards table=${tableId} round=${roundId} cards=[${cards.join(',')}]`);
  const tx = await contract.dealCommunityCards(tableId, roundId, cards);
  const rcpt = await tx.wait();
  log.info(`✓ dealCommunityCards tx=${tx.hash}`);
  return rcpt;
}

export async function showdown(tableId, keys, cards, winner) {
  // keys: uint256[]  (one per seat, used for hash verification)
  // cards: [{card1: uint8, card2: uint8}, ...]
  log.info(`tx showdown table=${tableId} winner=${winner}`);
  const tx = await contract.showdown(tableId, keys, cards, winner);
  const rcpt = await tx.wait();
  log.info(`✓ showdown tx=${tx.hash} block=${rcpt.blockNumber}`);
  return rcpt;
}

// C5 — used when the dealer detects a tie at showdown. The current contract
// only accepts a single winner; calling emergencyRefund returns all players'
// chips and resets the table, which is the only fund-safe path until the
// contract gains split-pot support.
export async function emergencyRefund(tableId) {
  log.warn(`tx emergencyRefund table=${tableId} (likely tie-induced)`);
  const tx = await contract.emergencyRefund(tableId);
  const rcpt = await tx.wait();
  log.info(`✓ emergencyRefund tx=${tx.hash}`);
  return rcpt;
}

/* ---------- event listeners ---------- */

export function onEvent(name, handler) {
  eventContract.on(name, handler);
  log.debug(`subscribed to event: ${name}`);
}

/**
 * Subscribe to all per-table events for a single table. Uses the WSS-backed
 * eventContract for sub-second delivery (falls back to HTTP polling if
 * MONAD_RPC_WSS is unset). Returns an unsubscribe function.
 *
 *   subscribeToTable(7, {
 *     onBuyIn:           (player, amount, received, ev) => ...,
 *     onLeftTable:       (player, ev) => ...,
 *     onActionTaken:     (roundId, player, action, amount, ev) => ...,
 *     onRoundOver:       (roundId, ev) => ...,
 *     onShowdownStarted: (handNum, ev) => ...,
 *     onPotDistributed:  (handNum, winner, tableToken, winnerAmt, burnAmt, devAmt, ev) => ...,
 *     onCardsDealt:      (handNum, cardHashes, ev) => ...,
 *   })
 */
export function subscribeToTable(tableId, handlers) {
  const subs = [];
  const map = [
    ['NewBuyIn',          handlers.onBuyIn],
    ['LeftTable',         handlers.onLeftTable],
    ['ActionTaken',       handlers.onActionTaken],
    ['RoundOver',         handlers.onRoundOver],
    ['ShowdownStarted',   handlers.onShowdownStarted],
    ['PotDistributed',    handlers.onPotDistributed],
    ['CardsDealt',        handlers.onCardsDealt],
    ['CommunityCardsDealt', handlers.onCommunityCardsDealt],
    ['EmergencyRefund',   handlers.onEmergencyRefund],
  ];
  for (const [name, h] of map) {
    if (!h) continue;
    const filter = eventContract.filters[name](tableId);
    eventContract.on(filter, h);
    const sub = { name, args: [tableId], handler: h };
    _subs.add(sub);
    subs.push(sub);
  }
  log.debug(`subscribed to ${subs.length} events for table ${tableId}`);
  return async function unsubscribe() {
    for (const sub of subs) {
      try {
        const filter = eventContract.filters[sub.name](...sub.args);
        await eventContract.off(filter, sub.handler);
      } catch (e) { log.debug(`unsub ${sub.name} failed: ${e.message}`); }
      _subs.delete(sub);
    }
    log.debug(`unsubscribed ${subs.length} events for table ${tableId}`);
  };
}

export function onNewTableCreated(handler) {
  const filter = eventContract.filters.NewTableCreated();
  eventContract.on(filter, handler);
  const sub = { name: 'NewTableCreated', args: [], handler };
  _subs.add(sub);
  return async () => {
    try {
      const f = eventContract.filters.NewTableCreated();
      await eventContract.off(f, handler);
    } catch (e) { log.debug(`unsub NewTableCreated failed: ${e.message}`); }
    _subs.delete(sub);
  };
}

export async function detachAll() {
  _stopHeartbeat();
  _subs.clear();
  if (eventContract) {
    try { await eventContract.removeAllListeners(); } catch {}
  }
  if (eventProvider && typeof eventProvider.destroy === 'function') {
    try { await eventProvider.destroy(); }
    catch (e) { log.warn('WSS provider destroy failed:', e.message); }
  }
}

/* ---------- boot info ---------- */

export async function bootInfo() {
  const [net, balance, owner] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(wallet.address),
    getOwner(),
  ]);
  return {
    chainId:        Number(net.chainId),
    networkName:    net.name,
    dealerAddress:  wallet.address,
    dealerBalance:  ethers.formatEther(balance),
    contractOwner:  owner,
    isOwner:        owner.toLowerCase() === wallet.address.toLowerCase(),
  };
}
