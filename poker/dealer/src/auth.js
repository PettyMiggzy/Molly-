/*
   Wallet authentication for WebSocket clients.

   Player signs a nonce-bearing message at connect time. Dealer
   recovers the address from the signature. From then on, every
   message from that WS connection is attributed to that address.

   Nonce is bound to the issuing WS session (H3 from pass-A audit):
   a signature obtained on one connection can't be replayed on another.
*/
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';

import { config } from './config.js';

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// nonce -> { wsId, issuedAt }
const nonces = new Map();
// wsId -> { address, sessionExpiresAt }
const sessions = new Map();

export function newNonce(wsId) {
  // H3 — bind nonce to issuing wsId at creation time
  const nonce = randomBytes(16).toString('hex');
  nonces.set(nonce, { wsId, issuedAt: Date.now() });
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

  // L2 — consume the nonce up-front. Even a bad-signature attempt
  // burns it, removing any state between attempts.
  nonces.delete(nonce);

  if (Date.now() - entry.issuedAt > NONCE_TTL_MS) {
    return { ok: false, reason: 'bad signature' };
  }
  // H3 — nonce must be consumed by the same connection that requested it.
  // Generic error to avoid leaking nonce-existence to a probing attacker.
  if (entry.wsId !== wsId) {
    return { ok: false, reason: 'bad signature' };
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(challengeMessage(nonce), signature);
  } catch (e) {
    return { ok: false, reason: 'bad signature' };
  }
  // L3 — `ethers.verifyMessage` always returns a checksummed string or
  // throws, so the truthy check is unreachable in practice. Removed.

  const checksummed = ethers.getAddress(recovered);
  sessions.set(wsId, {
    address: checksummed,
    sessionExpiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { ok: true, address: checksummed };
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

// L1 — `.unref()` so this timer doesn't keep the event loop alive on its own.
// Also expose a handle so shutdown can stop it cleanly if needed.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces.entries()) {
    if (now - v.issuedAt > NONCE_TTL_MS) nonces.delete(k);
  }
  for (const [k, v] of sessions.entries()) {
    if (now > v.sessionExpiresAt) sessions.delete(k);
  }
}, 60 * 1000);
cleanupTimer.unref();

export function stopAuthCleanup() { clearInterval(cleanupTimer); }
