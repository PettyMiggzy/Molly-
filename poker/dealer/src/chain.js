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
// Wallet kept module-internal. External callers go through the helpers below
// (dealCards/dealCommunityCards/showdown/bootInfo) rather than touching the
// signer directly — keeps the dealer key reachable only from this file.
const wallet = new ethers.Wallet(getDealerKey(), provider);
export const contract = new ethers.Contract(config.contractAddress, ABI, wallet);

// Separate provider for event subscriptions. WSS gives sub-second event
// delivery vs ~2-12s for HTTP polling. Falls back to the HTTP contract if
// MONAD_RPC_WSS isn't set.
let eventContract;
let eventProvider;
if (config.rpcWss) {
  eventProvider = new ethers.WebSocketProvider(config.rpcWss);
  eventContract = new ethers.Contract(config.contractAddress, ABI, eventProvider);
  log.info(`event subscriptions via WSS: ${config.rpcWss.replace(/\/\/[^@]*@/, '//<key>@')}`);
} else {
  eventContract = contract;
  log.info(`event subscriptions via HTTP polling (set MONAD_RPC_WSS for real-time)`);
}

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
  const filters = [];
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
    filters.push({ filter, h });
  }
  log.debug(`subscribed to ${filters.length} events for table ${tableId}`);
  return async function unsubscribe() {
    for (const { filter, h } of filters) {
      await eventContract.off(filter, h);
    }
    log.debug(`unsubscribed ${filters.length} events for table ${tableId}`);
  };
}

export function onNewTableCreated(handler) {
  const filter = eventContract.filters.NewTableCreated();
  eventContract.on(filter, handler);
  return async () => { await eventContract.off(filter, handler); };
}

export async function detachAll() {
  await eventContract.removeAllListeners();
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
