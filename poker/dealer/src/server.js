/*
   WebSocket server for the dealer.

   Phase A: connection lifecycle, auth, basic routing, table-info reads.
   Phase B will add: join_table, action handling, deck commit-reveal.
   Phase C will add: showdown evaluation + tx submission.
*/
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

import { config, log } from './config.js';
import {
  newNonce, challengeMessage, verifyAndBind, getSession, clearSession,
} from './auth.js';
import { getTable, getTablePlayers, getRound, getCommunityCards, getTotalTables } from './chain.js';

const clients = new Map(); // wsId -> { ws, address?, joinedTableId?, ip, rate }

// M5 — per-IP connection cap
const MAX_CONNS_PER_IP = 20;
const ipCounts = new Map(); // ip -> count

// M3 — per-connection token bucket: 10 requests / 10 seconds
const RATE_LIMIT = { max: 10, windowMs: 10_000 };

// L8 — only trust x-forwarded-for when behind a known proxy.
// Set DEALER_TRUST_PROXY=1 in env once nginx (or similar) is in front.
const TRUST_PROXY = process.env.DEALER_TRUST_PROXY === '1';

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function send(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  let frame;
  try {
    frame = JSON.stringify({ type, ...payload });
  } catch (e) {
    // M2 / H2 — JSON.stringify can throw on BigInt; log + send generic error
    log.error(`stringify failed for type=${type}:`, e.message);
    try { ws.send(JSON.stringify({ type: 'error', message: 'internal serialization error' })); }
    catch { /* socket dying */ }
    return;
  }
  try { ws.send(frame); }
  catch (e) { log.warn('send failed:', e.message); }
}

// M2 — never leak ethers/RPC error messages to the client
function sendInternalError(ws, e) {
  log.error('internal error:', e?.stack || e?.message || e);
  send(ws, 'error', { message: 'internal error' });
}

function broadcastTable(tableId, type, payload, exceptWsId = null) {
  for (const [wsId, c] of clients.entries()) {
    if (c.joinedTableId === tableId && wsId !== exceptWsId) {
      send(c.ws, type, payload);
    }
  }
}

// M3 — token-bucket rate limit per connection
function checkRate(wsId) {
  const c = clients.get(wsId);
  if (!c) return false;
  const now = Date.now();
  if (!c.rate || now - c.rate.start > RATE_LIMIT.windowMs) {
    c.rate = { start: now, count: 1 };
    return true;
  }
  c.rate.count += 1;
  return c.rate.count <= RATE_LIMIT.max;
}

// M4 — strict tableId validation
async function validateTableId(tableId) {
  if (!Number.isInteger(tableId) || tableId < 0) return false;
  const total = await getTotalTables();
  return tableId < total;
}

async function handleMessage(wsId, ws, raw) {
  if (!checkRate(wsId)) {
    return send(ws, 'error', { message: 'rate limited' });
  }

  let msg;
  try { msg = JSON.parse(raw); }
  catch { return send(ws, 'error', { message: 'invalid json' }); }
  if (!msg || typeof msg.type !== 'string') {
    return send(ws, 'error', { message: 'missing type' });
  }

  log.debug(`← ${wsId.slice(0,8)} ${msg.type}`);

  switch (msg.type) {
    case 'auth_request': {
      // H3 — bind the nonce to this wsId
      const nonce = newNonce(wsId);
      return send(ws, 'auth_challenge', {
        nonce,
        message: challengeMessage(nonce),
      });
    }

    case 'auth_submit': {
      const { nonce, signature } = msg;
      if (typeof nonce !== 'string' || typeof signature !== 'string') {
        return send(ws, 'auth_fail', { reason: 'missing nonce or signature' });
      }
      const result = verifyAndBind(wsId, nonce, signature);
      if (!result.ok) return send(ws, 'auth_fail', { reason: result.reason });
      const c = clients.get(wsId);
      if (c) c.address = result.address;
      log.info(`auth ok ${wsId.slice(0,8)} → ${result.address}`);
      return send(ws, 'auth_ok', { address: result.address });
    }

    case 'list_tables': {
      const total = await getTotalTables();
      const out = [];
      for (let i = 0; i < total; i++) {
        const t = await getTable(i);
        const players = await getTablePlayers(i);
        out.push({
          tableId: i,
          state: ['Active', 'Inactive', 'Showdown'][t.state] || 'Unknown',
          buyIn: t.buyInAmount.toString(),
          bigBlind: t.bigBlind.toString(),
          maxPlayers: t.maxPlayers,
          token: t.token,
          totalHands: t.totalHands.toString(),
          pot: t.pot.toString(),
          seated: players.length,
          players,
        });
      }
      return send(ws, 'tables', { tables: out });
    }

    case 'table_state': {
      const { tableId } = msg;
      if (!(await validateTableId(tableId))) {
        return send(ws, 'error', { message: 'invalid tableId' });
      }
      const t = await getTable(tableId);
      const players = await getTablePlayers(tableId);
      const community = await getCommunityCards(tableId);
      let round = null;
      if (t.state === 0) {
        round = await getRound(tableId, t.currentRound); // BigInts already stringified by chain.js
      }
      return send(ws, 'table_state', {
        tableId,
        state:        ['Active', 'Inactive', 'Showdown'][t.state],
        currentRound: t.currentRound,
        totalHands:   t.totalHands.toString(),
        pot:          t.pot.toString(),
        bigBlind:     t.bigBlind.toString(),
        buyIn:        t.buyInAmount.toString(),
        maxPlayers:   t.maxPlayers,
        token:        t.token,
        creator:      t.creator,
        players,
        community,
        round,
      });
    }

    case 'join_table':
    case 'leave_table':
    case 'action':
    case 'ready':
      return send(ws, 'error', { message: `${msg.type} not yet implemented (phase B)` });

    default:
      return send(ws, 'error', { message: `unknown type: ${msg.type}` });
  }
}

export function startServer() {
  const wss = new WebSocketServer({
    port: config.port,
    maxPayload: 16 * 1024, // M1 — 16 KB cap, no phase-A message exceeds ~1 KB
  });
  log.info(`WebSocket server listening on :${config.port}`);

  wss.on('connection', (ws, req) => {
    const wsId = randomUUID();
    const ip = clientIp(req);

    // M5 — enforce per-IP connection cap
    const ipCount = ipCounts.get(ip) || 0;
    if (ipCount >= MAX_CONNS_PER_IP) {
      log.warn(`reject ${ip}: too many connections (${ipCount})`);
      try { ws.close(1008, 'too many connections'); } catch {}
      return;
    }
    ipCounts.set(ip, ipCount + 1);

    clients.set(wsId, { ws, address: null, joinedTableId: null, ip, rate: null });
    log.info(`+ connect ${wsId.slice(0,8)} from ${ip} (${clients.size} total)`);

    // L9 — don't echo wsId back to the client; it's an internal handle
    send(ws, 'hello', {
      contract: config.contractAddress,
      message: 'send {type:"auth_request"} to begin',
    });

    ws.on('message', async (raw) => {
      try { await handleMessage(wsId, ws, raw.toString()); }
      catch (e) {
        sendInternalError(ws, e);  // M2 — sanitized
      }
    });

    const cleanup = () => {
      const c = clients.get(wsId);
      if (!c) return;
      if (c.joinedTableId !== null && c.joinedTableId !== undefined) {
        broadcastTable(c.joinedTableId, 'player_left', { address: c.address }, wsId);
      }
      clearSession(wsId);
      clients.delete(wsId);
      const remaining = (ipCounts.get(ip) || 1) - 1;
      if (remaining <= 0) ipCounts.delete(ip);
      else ipCounts.set(ip, remaining);
      log.info(`- close ${wsId.slice(0,8)} (${clients.size} remaining)`);
    };

    ws.on('close', cleanup);
    ws.on('error', (e) => {
      log.warn(`ws error ${wsId.slice(0,8)}:`, e.message);
      cleanup(); // L4-adjacent — ensure map cleanup even if close doesn't fire
    });
  });

  return wss;
}
