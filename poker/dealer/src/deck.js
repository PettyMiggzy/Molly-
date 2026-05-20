/*
   Deck primitives for MollyPoker.

   Card encoding: 0..51 = rank * 4 + suit
     rank: 0..12 → 2,3,4,5,6,7,8,9,T,J,Q,K,A
     suit: 0..3  → c,d,h,s

   Commit-reveal: for each player, the dealer generates a per-hand
   secret key (uint256). The hash submitted on-chain via dealCards is:
     keccak256(abi.encodePacked(key, card))     // key is uint256, card is uint8

   At showdown the dealer reveals the keys + plaintext cards. The contract
   re-computes the hashes and rejects any mismatch.

   This file produces hashes byte-identical to MollyPoker.sol's:
     bytes32 h1 = keccak256(abi.encodePacked(_keys[i], _cards[i].card1));
*/
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['c','d','h','s'];

/**
 * Fisher-Yates shuffle using crypto.randomBytes for entropy.
 * Each swap pulls 4 fresh random bytes and mods into the remaining range.
 * Modulo bias is negligible at 32-bit range / 52-card max.
 */
export function shuffleDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const r = randomBytes(4).readUInt32BE(0);
    const j = r % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Generate per-player secret key + card hashes. The returned key is a BigInt
 * that the dealer must persist until showdown — it's needed to reveal.
 *
 * @param {number} card1  0..51
 * @param {number} card2  0..51
 * @returns {{ key: bigint, card1Hash: string, card2Hash: string }}
 */
export function commitPlayerCards(card1, card2) {
  validateCard(card1);
  validateCard(card2);
  // Full 256-bit key (32 bytes = uint256)
  const key = ethers.toBigInt('0x' + randomBytes(32).toString('hex'));
  const card1Hash = ethers.solidityPackedKeccak256(['uint256', 'uint8'], [key, card1]);
  const card2Hash = ethers.solidityPackedKeccak256(['uint256', 'uint8'], [key, card2]);
  return { key, card1Hash, card2Hash };
}

function validateCard(c) {
  if (!Number.isInteger(c) || c < 0 || c > 51) {
    throw new Error(`invalid card: ${c} (must be 0..51)`);
  }
}

/**
 * Pretty-print a single card for logs / debugging.
 * Example: cardToString(0)  -> '2c'
 *          cardToString(51) -> 'As'
 */
export function cardToString(card) {
  validateCard(card);
  const rank = Math.floor(card / 4);
  const suit = card % 4;
  return RANKS[rank] + SUITS[suit];
}

/**
 * Convert our 0..51 encoding to pokersolver's string format ('As', 'Td', '2c', etc.).
 * pokersolver expects uppercase suit characters for evaluation? Actually it accepts
 * either case but normalizes internally. We use lowercase to match cardToString.
 */
export function cardToPokersolver(card) {
  return cardToString(card);
}

/**
 * Standard hold'em dealing pattern. Given a fresh shuffled deck and N players,
 * returns:
 *   - holeCards:  Map<seatIndex, {card1, card2}>  — first two cards per seat
 *   - flop:       [c1, c2, c3]
 *   - turn:       [c1]
 *   - river:      [c1]
 *   - deckCursor: how many cards consumed (sanity)
 *
 * Burns are NOT modeled — the contract doesn't expect burn cards. Each round
 * draws sequentially from the post-deal cursor.
 */
export function dealHand(deck, numPlayers) {
  if (!Array.isArray(deck) || deck.length !== 52) throw new Error('deck must be length 52');
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 9) {
    throw new Error('numPlayers must be 2..9');
  }
  const holeCards = new Map();
  let cur = 0;
  for (let seat = 0; seat < numPlayers; seat++) {
    const card1 = deck[cur++];
    const card2 = deck[cur++];
    holeCards.set(seat, { card1, card2 });
  }
  const flop  = [deck[cur++], deck[cur++], deck[cur++]];
  const turn  = [deck[cur++]];
  const river = [deck[cur++]];
  return { holeCards, flop, turn, river, deckCursor: cur };
}
