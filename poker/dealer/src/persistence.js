/*
   Per-table state persistence.

   When the dealer goes down mid-hand, the deck/keys/holeCards are gone unless
   we wrote them somewhere. This module saves them atomically after every state
   change, and restores on TableRunner startup.

   File layout: ./state/table-<tableId>.json
   {
     "tableId": 0,
     "localState": "ACTIVE",
     "seatOrder": ["0x...", "0x..."],
     "deck":      [int, int, ...],     // 0..51, length 52
     "keys":      { "0x...": "0x...key as hex string..." },
     "holeCards": { "0x...": { "card1": 5, "card2": 17 } },
     "communityCards": [3, 17, 25],
     "handNum":   42,
     "savedAt":   "2026-05-20T18:00:00Z"
   }

   Files for completed hands are deleted on PotDistributed / EmergencyRefund.
*/
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DEALER_STATE_DIR || resolve(__dirname, '../state');

function ensureDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
    log.info(`created state dir: ${STATE_DIR}`);
  }
}

function pathFor(tableId) {
  return resolve(STATE_DIR, `table-${tableId}.json`);
}

/**
 * Atomically save state for a single table.
 * Writes to a temp file then renames so partial writes can't corrupt state.
 */
export async function saveTable(state) {
  ensureDir();
  const path = pathFor(state.tableId);
  const tmp = `${path}.tmp`;

  // Convert BigInt keys to hex strings for JSON
  const serializable = {
    ...state,
    keys: Object.fromEntries(
      Object.entries(state.keys || {}).map(([addr, k]) =>
        [addr, typeof k === 'bigint' ? '0x' + k.toString(16) : k]
      )
    ),
    savedAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(tmp, JSON.stringify(serializable), 'utf8');
    await fs.rename(tmp, path);
  } catch (e) {
    log.warn(`persistence save failed for t${state.tableId}: ${e.message}`);
    // M5 — clean up the orphaned .tmp file so disk doesn't fill on repeated
    // rename failures (common on Windows/AV scanning the new file)
    fs.unlink(tmp).catch(() => {});
  }
}

/**
 * Load saved state for a table, if any. Returns null if no file exists.
 * Converts hex-string keys back to BigInt.
 */
export async function loadTable(tableId) {
  ensureDir();
  const path = pathFor(tableId);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e) {
    log.warn(`failed to read state for t${tableId}: ${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.keys) {
      parsed.keys = Object.fromEntries(
        Object.entries(parsed.keys).map(([addr, k]) =>
          [addr, typeof k === 'string' ? BigInt(k) : k]
        )
      );
    }
    log.info(`[t${tableId}] restored state from ${path} (savedAt=${parsed.savedAt})`);
    return parsed;
  } catch (e) {
    // M6 — corrupt JSON. Don't silently return null; quarantine the file
    // so an operator can see what went wrong, and continue without restore.
    const broken = `${path}.broken-${Date.now()}`;
    log.error(`[t${tableId}] state file corrupt (${e.message}); quarantined to ${broken}`);
    try { await fs.rename(path, broken); }
    catch (renameErr) { log.warn(`quarantine rename failed: ${renameErr.message}`); }
    return null;
  }
}

/**
 * Delete saved state for a table. Called on PotDistributed / EmergencyRefund.
 */
export async function clearTable(tableId) {
  const path = pathFor(tableId);
  if (!existsSync(path)) return;
  try {
    await fs.unlink(path);
    log.debug(`[t${tableId}] cleared persisted state`);
  } catch (e) {
    log.warn(`failed to clear state for t${tableId}: ${e.message}`);
  }
}

/**
 * Scan the state dir at startup and return tableIds that have saved state.
 * Caller uses this to recreate runners that were live before a restart.
 */
export function listSavedTables() {
  ensureDir();
  try {
    return readdirSync(STATE_DIR)
      .map(f => f.match(/^table-(\d+)\.json$/))
      .filter(Boolean)
      .map(m => Number(m[1]))
      .sort((a, b) => a - b);
  } catch (e) {
    log.warn(`failed to list state dir: ${e.message}`);
    return [];
  }
}
