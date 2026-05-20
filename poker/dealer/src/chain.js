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

import { config, log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = resolve(__dirname, '../../artifacts/contracts/MollyPoker.sol/MollyPoker.json');

let ABI;
try {
  ABI = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')).abi;
} catch (e) {
  log.error(`could not load contract ABI from ${ARTIFACT_PATH}`);
  log.error(`run 'npx hardhat compile' in poker/ first`);
  process.exit(1);
}

export const provider = new ethers.JsonRpcProvider(config.rpc);
export const wallet = new ethers.Wallet(config.dealerKey, provider);
export const contract = new ethers.Contract(config.contractAddress, ABI, wallet);

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
    highestChip:    r.highestChip,
    roundChips:     r.roundChips,
    folded:         r.folded,
    actsSinceReset: Number(r.actsSinceReset),
  };
}

export async function getCommunityCards(tableId) {
  const cards = await contract.getCommunityCards(tableId);
  return cards.map(c => Number(c));
}

export async function getChips(playerAddr, tableId) {
  return await contract.chips(playerAddr, tableId);
}

export async function getTotalTables() {
  return Number(await contract.totalTables());
}

export async function getDevOwed(token) {
  return await contract.devOwed(token);
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
  contract.on(name, handler);
  log.debug(`subscribed to event: ${name}`);
}

export async function detachAll() {
  await contract.removeAllListeners();
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
