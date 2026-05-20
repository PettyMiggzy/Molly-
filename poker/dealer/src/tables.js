/*
   Registry of live TableRunner instances.

   One TableRunner per tableId. Created on demand the first time a player
   joins a table. Persists until the server shuts down (or we add explicit
   per-table teardown in phase D).

   The runner needs two callbacks to talk to WebSocket clients:
   - broadcastTable(tableId, type, payload): send to all sockets at that table
   - sendPrivate(address, type, payload):    send to one address's socket only

   server.js owns those callbacks (it has the WS client map) and registers
   them via initTables().
*/
import { log } from './config.js';
import { TableRunner } from './table.js';

const runners = new Map(); // tableId → TableRunner

let _broadcastFn = null;
let _sendPrivateFn = null;

export function initTables({ broadcastTable, sendPrivate }) {
  _broadcastFn = broadcastTable;
  _sendPrivateFn = sendPrivate;
}

export function getRunner(tableId) {
  if (!_broadcastFn || !_sendPrivateFn) {
    throw new Error('initTables() not called yet — wire from server.js');
  }
  let r = runners.get(tableId);
  if (!r) {
    r = new TableRunner(
      tableId,
      (type, payload) => _broadcastFn(tableId, type, payload),
      (address, type, payload) => _sendPrivateFn(address, type, payload),
    );
    r.start();
    runners.set(tableId, r);
    log.info(`[tables] created runner for tableId ${tableId}`);
  }
  return r;
}

export async function shutdownAllTables() {
  log.info(`[tables] shutting down ${runners.size} runners`);
  for (const r of runners.values()) {
    try { await r.stop(); } catch (e) { log.warn('runner stop failed:', e.message); }
  }
  runners.clear();
}

export function listRunners() {
  return [...runners.keys()];
}
