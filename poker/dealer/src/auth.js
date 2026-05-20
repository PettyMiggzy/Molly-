/*
   Wallet authentication for WebSocket clients.

   Player signs a nonce-bearing message at connect time. Dealer
   recovers the address from the signature. From then on, every
   message from that WS connection is attributed to that address.

   The nonce prevents replay across sessions. The contract address
   in the message prevents reuse against other dapps.
*/
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';

import { config } from './config.js';

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// nonce -> { address?, issuedAt }
const nonces = new Map();
// wsId -> { address, sessionExpiresAt }
const sessions = new Map();

export function newNonce() {
  const nonce = randomBytes(16).toString('hex');
  nonces.set(nonce, { issuedAt: Date.now() });
  return nonce;
}

export function challengeMessage(nonce) {
  return [
    `MollyPoker login`,
    ``,
    `Contract: ${config.contractAddress}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
  ].join('\n');
}

export function verifyAndBind(wsId, nonce, signature) {
  const entry = nonces.get(nonce);
  if (!entry) return { ok: false, reason: 'unknown nonce' };
  if (Date.now() - entry.issuedAt > NONCE_TTL_MS) {
    nonces.delete(nonce);
    return { ok: false, reason: 'nonce expired' };
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(challengeMessage(nonce), signature);
  } catch (e) {
    return { ok: false, reason: 'bad signature' };
  }
  if (!recovered) return { ok: false, reason: 'bad signature' };
  nonces.delete(nonce); // consume

  sessions.set(wsId, {
    address: ethers.getAddress(recovered),
    sessionExpiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { ok: true, address: ethers.getAddress(recovered) };
}

export function getSession(wsId) {
  const s = sessions.get(wsId);
  if (!s) return null;
  if (Date.now() > s.sessionExpiresAt) {
    sessions.delete(wsId);
    return null;
  }
  return s;
}

export function clearSession(wsId) {
  sessions.delete(wsId);
}

// periodic cleanup so the maps don't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces.entries()) {
    if (now - v.issuedAt > NONCE_TTL_MS) nonces.delete(k);
  }
  for (const [k, v] of sessions.entries()) {
    if (now > v.sessionExpiresAt) sessions.delete(k);
  }
}, 60 * 1000);
