/*
   WebSocket server for the dealer.

   Phase A: connection lifecycle, auth, table-info reads.
   Phase B: join_table/leave_table/ready/action handlers, per-table broadcast,
            private card delivery, integration with TableRunner registry.
   Phase C will add: nginx/wss, reconnection, per-table teardown.
*/
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

import { config, log } from './config.js';
import {
  newNonce, challengeMessage, verifyAndBind, getSession, clearSession,
} from './auth.js';
import {
  getTable, getTablePlayers, getRound, getCommunityCards, getTotalTables,
} from './chain.js';
import {
  initTables, getRunner, shutdownAllTables, listRunners,
} from './tables.js';

const clients = new Map(); // wsId -> { ws, address?, joinedTableId?, ip, rate, actionRate }

// M5 — per-IP connection cap
const MAX_CONNS_PER_IP = 20;
const ipCounts = new Map(); // ip -> count

// M3 — token bucket: 10 requests / 10 seconds for general queries
const RATE_LIMIT = { max: 10, windowMs: 10_000 };
// Higher rate for authenticated action messages (poker needs sub-second betting).
// Distinct bucket so heavy query traffic can't starve action throughput.
const ACTION_RATE_LIMIT = { max: 60, windowMs: 10_000 };

// L8 — only trust x-forwarded-for when behind a known proxy.
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
    log.error(`stringify failed for type=${type}:`, e.message);
    try { ws.send(JSON.stringify({ type: 'error', message: 'internal serialization error' })); }
    catch { /* socket dying */ }
    return;
  }
  try { ws.send(frame); }
  catch (e) { log.warn('send failed:', e.message); }
}

function sendInternalError(ws, e) {
  log.error('internal error:', e?.stack || e?.message || e);
  send(ws, 'error', { message: 'internal error' });
}

/* ---------- broadcast helpers for TableRunner ---------- */

function broadcastTable(tableId, type, payload) {
  let count = 0;
  for (const c of clients.values()) {
    if (c.joinedTableId === tableId) {
      send(c.ws, type, payload);
      count++;
    }
  }
  log.debug(`broadcast t${tableId} ${type} → ${count} ws`);
}

// Address → WS lookup for private card delivery. A given address may have
// multiple connections (e.g. mobile + desktop); send to all of them.
function sendPrivate(address, type, payload) {
  const lower = address.toLowerCase();
  let count = 0;
  for (const c of clients.values()) {
    if (c.address && c.address.toLowerCase() === lower) {
      send(c.ws, type, payload);
      count++;
    }
  }
  log.debug(`sendPrivate ${address.slice(0,8)} ${type} → ${count} ws`);
}

initTables({ broadcastTable, sendPrivate });

/* ---------- rate limiting + validation ---------- */

function checkRate(wsId, limit = RATE_LIMIT, bucketKey = 'rate') {
  const c = clients.get(wsId);
  if (!c) return false;
  const now = Date.now();
  const bucket = c[bucketKey];
  if (!bucket || now - bucket.start > limit.windowMs) {
    c[bucketKey] = { start: now, count: 1 };
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit.max;
}

let _totalCache = { value: 0, ts: 0 };
async function cachedTotalTables() {
  if (Date.now() - _totalCache.ts < 1000) return _totalCache.value;
  _totalCache = { value: await getTotalTables(), ts: Date.now() };
  return _totalCache.value;
}
export function invalidateTotalTablesCache() { _totalCache = { value: 0, ts: 0 }; }

async function validateTableId(tableId) {
  if (!Number.isInteger(tableId) || tableId < 0) return false;
  const total = await cachedTotalTables();
  return tableId < total;
}

function requireAuth(wsId, ws) {
  const s = getSession(wsId);
  if (!s) {
    send(ws, 'error', { message: 'auth required' });
    return null;
  }
  return s;
}

/* ---------- message router ---------- */

async function handleMessage(wsId, ws, raw) {
  // Per-type rate limiting: actions use a higher bucket.
  let msg;
  try { msg = JSON.parse(raw); }
  catch { return send(ws, 'error', { message: 'invalid json' }); }
  if (!msg || typeof msg.type !== 'string') {
    return send(ws, 'error', { message: 'missing type' });
  }

  const isActionMessage = (msg.type === 'action' || msg.type === 'ready');
  const limitOk = isActionMessage
    ? checkRate(wsId, ACTION_RATE_LIMIT, 'actionRate')
    : checkRate(wsId, RATE_LIMIT, 'rate');
  if (!limitOk) return send(ws, 'error', { message: 'rate limited' });

  log.debug(`← ${wsId.slice(0,8)} ${msg.type}`);

  switch (msg.type) {
    case 'auth_request': {
      const nonce = newNonce(wsId);
      return send(ws, 'auth_challenge', { nonce, message: challengeMessage(nonce) });
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
      const total = await cachedTotalTables();
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
        round = await getRound(tableId, t.currentRound);
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

    case 'join_table': {
      const session = requireAuth(wsId, ws);
      if (!session) return;
      const { tableId } = msg;
      if (!(await validateTableId(tableId))) {
        return send(ws, 'error', { message: 'invalid tableId' });
      }
      // Verify they're actually seated on-chain at this table
      const players = await getTablePlayers(tableId);
      const isSeated = players.map(p => p.toLowerCase()).includes(session.address.toLowerCase());
      if (!isSeated) {
        return send(ws, 'error', { message: 'not seated on this table; call buyIn first' });
      }

      const c = clients.get(wsId);
      if (!c) return;
      // If they were already at another table, remove them from that runner
      if (c.joinedTableId !== null && c.joinedTableId !== undefined && c.joinedTableId !== tableId) {
        const old = getRunner(c.joinedTableId);
        old.removePlayer(session.address);
      }
      c.joinedTableId = tableId;
      const runner = getRunner(tableId);
      runner.addPlayer(session.address);

      return send(ws, 'joined_table', {
        tableId,
        message: 'joined; send {type:"ready"} when you want the next hand to start',
      });
    }

    case 'leave_table': {
      const session = requireAuth(wsId, ws);
      if (!session) return;
      const c = clients.get(wsId);
      if (!c || c.joinedTableId === null || c.joinedTableId === undefined) {
        return send(ws, 'error', { message: 'not joined to any table' });
      }
      const tid = c.joinedTableId;
      const runner = getRunner(tid);
      runner.removePlayer(session.address);
      c.joinedTableId = null;
      // Note: on-chain leaveTable is a separate frontend call — this just
      // disconnects them from the dealer's awareness.
      return send(ws, 'left_table', { tableId: tid });
    }

    case 'ready': {
      const session = requireAuth(wsId, ws);
      if (!session) return;
      const c = clients.get(wsId);
      if (!c || c.joinedTableId === null || c.joinedTableId === undefined) {
        return send(ws, 'error', { message: 'join a table first' });
      }
      const runner = getRunner(c.joinedTableId);
      await runner.setReady(session.address);
      return send(ws, 'ready_ack', { tableId: c.joinedTableId });
    }

    case 'action': {
      // Players submit their playHand tx directly from the frontend.
      // This handler is informational only — we just ack so the UI can
      // show a "submitting" state. The authoritative state update comes
      // from the ActionTaken event broadcast by the TableRunner.
      const session = requireAuth(wsId, ws);
      if (!session) return;
      const c = clients.get(wsId);
      if (!c || c.joinedTableId === null || c.joinedTableId === undefined) {
        return send(ws, 'error', { message: 'join a table first' });
      }
      return send(ws, 'action_ack', {
        tableId: c.joinedTableId,
        message: 'submit your playHand tx on-chain; we will broadcast the result',
      });
    }

    default:
      return send(ws, 'error', { message: `unknown type: ${msg.type}` });
  }
}

export function startServer() {
  const wss = new WebSocketServer({
    port: config.port,
    maxPayload: 16 * 1024,
  });

  wss.on('error', (e) => {
    log.error('WebSocketServer error (fatal):', e);
    process.exit(1);
  });

  wss.on('listening', () => {
    log.info(`WebSocket server listening on :${config.port}`);
  });

  wss.on('connection', (ws, req) => {
    const wsId = randomUUID();
    const ip = clientIp(req);

    const ipCount = ipCounts.get(ip) || 0;
    if (ipCount >= MAX_CONNS_PER_IP) {
      log.warn(`reject ${ip}: too many connections (${ipCount})`);
      try { ws.close(1008, 'too many connections'); } catch {}
      return;
    }
    ipCounts.set(ip, ipCount + 1);

    clients.set(wsId, {
      ws, address: null, joinedTableId: null, ip,
      rate: null, actionRate: null,
    });
    log.info(`+ connect ${wsId.slice(0,8)} from ${ip} (${clients.size} total)`);

    send(ws, 'hello', {
      contract: config.contractAddress,
      message: 'send {type:"auth_request"} to begin',
    });

    ws.on('message', async (raw) => {
      try { await handleMessage(wsId, ws, raw.toString()); }
      catch (e) { sendInternalError(ws, e); }
    });

    const cleanup = () => {
      const c = clients.get(wsId);
      if (!c) return;
      if (c.joinedTableId !== null && c.joinedTableId !== undefined && c.address) {
        const runner = getRunner(c.joinedTableId);
        runner.removePlayer(c.address);
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
      cleanup();
    });
  });

  return wss;
}

export async function stopAllRunners() {
  await shutdownAllTables();
}

export function activeRunnerIds() {
  return listRunners();
}
