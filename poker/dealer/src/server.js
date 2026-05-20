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

const clients = new Map(); // wsId -> { ws, address?, joinedTableId? }

function send(ws, type, payload = {}) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, ...payload })); }
  catch (e) { log.warn('send failed:', e.message); }
}

function broadcastTable(tableId, type, payload, exceptWsId = null) {
  for (const [wsId, c] of clients.entries()) {
    if (c.joinedTableId === tableId && wsId !== exceptWsId) {
      send(c.ws, type, payload);
    }
  }
}

async function handleMessage(wsId, ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch { return send(ws, 'error', { message: 'invalid json' }); }
  if (!msg || typeof msg.type !== 'string') {
    return send(ws, 'error', { message: 'missing type' });
  }

  log.debug(`← ${wsId.slice(0,8)} ${msg.type}`);

  switch (msg.type) {
    case 'auth_request': {
      const nonce = newNonce();
      return send(ws, 'auth_challenge', {
        nonce,
        message: challengeMessage(nonce),
      });
    }

    case 'auth_submit': {
      const { nonce, signature } = msg;
      if (!nonce || !signature) {
        return send(ws, 'auth_fail', { reason: 'missing nonce or signature' });
      }
      const result = verifyAndBind(wsId, nonce, signature);
      if (!result.ok) return send(ws, 'auth_fail', { reason: result.reason });
      clients.get(wsId).address = result.address;
      log.info(`auth ok ${wsId.slice(0,8)} → ${result.address}`);
      return send(ws, 'auth_ok', { address: result.address });
    }

    case 'list_tables': {
      // open — no auth required
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
      if (typeof tableId !== 'number') {
        return send(ws, 'error', { message: 'tableId must be number' });
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

    case 'join_table':
    case 'leave_table':
    case 'action':
    case 'ready':
      // Phase B implements these
      return send(ws, 'error', { message: `${msg.type} not yet implemented (phase B)` });

    default:
      return send(ws, 'error', { message: `unknown type: ${msg.type}` });
  }
}

export function startServer() {
  const wss = new WebSocketServer({ port: config.port });
  log.info(`WebSocket server listening on :${config.port}`);

  wss.on('connection', (ws, req) => {
    const wsId = randomUUID();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    clients.set(wsId, { ws, address: null, joinedTableId: null });
    log.info(`+ connect ${wsId.slice(0,8)} from ${ip} (${clients.size} total)`);

    send(ws, 'hello', {
      wsId,
      contract: config.contractAddress,
      message: 'send {type:"auth_request"} to begin',
    });

    ws.on('message', async (raw) => {
      try { await handleMessage(wsId, ws, raw.toString()); }
      catch (e) {
        log.error(`message handler error:`, e);
        send(ws, 'error', { message: e.message || 'internal error' });
      }
    });

    ws.on('close', () => {
      const c = clients.get(wsId);
      if (c?.joinedTableId !== null && c?.joinedTableId !== undefined) {
        broadcastTable(c.joinedTableId, 'player_left', { address: c.address }, wsId);
      }
      clearSession(wsId);
      clients.delete(wsId);
      log.info(`- close ${wsId.slice(0,8)} (${clients.size} remaining)`);
    });

    ws.on('error', (e) => {
      log.warn(`ws error ${wsId.slice(0,8)}:`, e.message);
    });
  });

  return wss;
}
