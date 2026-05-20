/*
   Centralized config + logger. Validates env at boot so we fail fast
   on missing or malformed values instead of cryptic runtime errors.
*/
import 'dotenv/config';
import { ethers } from 'ethers';

// L6 — broader placeholder pattern set
const PLACEHOLDER_PATTERNS = [
  /^<.*>$/,        // <your-key>
  /^your-/i,       // your-something
  /^xxx+$/i,       // xxx, XXXX
  /^todo$/i,
  /^changeme$/i,
  /^placeholder$/i,
];

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ missing env: ${name}`);
    process.exit(1);
  }
  if (PLACEHOLDER_PATTERNS.some(rx => rx.test(v.trim()))) {
    console.error(`✗ env ${name} looks like a placeholder: '${v}'`);
    process.exit(1);
  }
  return v;
}

const rpc = required('MONAD_RPC');
const dealerKey = required('DEALER_PRIVATE_KEY');
const contractAddress = required('MOLLY_POKER_ADDRESS');

// Optional WebSocket RPC (e.g. QuickNode wss://). When present, chain.js uses
// it for event subscriptions instead of HTTP polling — sub-second event delivery.
// HTTP RPC is still used for read/write calls.
const rpcWss = process.env.MONAD_RPC_WSS || null;
if (rpcWss) {
  try { new URL(rpcWss); }
  catch {
    console.error(`✗ MONAD_RPC_WSS is not a valid URL: '${rpcWss}'`);
    process.exit(1);
  }
  if (!rpcWss.startsWith('ws://') && !rpcWss.startsWith('wss://')) {
    console.error(`✗ MONAD_RPC_WSS must start with ws:// or wss://, got: '${rpcWss}'`);
    process.exit(1);
  }
}

// M7 — validate PORT is a real port number
const portRaw = process.env.PORT || '4001';
const port = parseInt(portRaw, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`✗ invalid PORT: '${portRaw}' (must be 1-65535)`);
  process.exit(1);
}

// L7 — fail fast on malformed address or RPC URL
let contractAddressChecksum;
try {
  contractAddressChecksum = ethers.getAddress(contractAddress);
} catch {
  console.error(`✗ MOLLY_POKER_ADDRESS is not a valid address: '${contractAddress}'`);
  process.exit(1);
}
try {
  new URL(rpc);
} catch {
  console.error(`✗ MONAD_RPC is not a valid URL: '${rpc}'`);
  process.exit(1);
}

export const config = {
  rpc,
  rpcWss,
  // dealerKey intentionally NOT exposed here — access via getDealerKey() which
  // is consumed once by chain.js and not stashed in a shared object.
  contractAddress: contractAddressChecksum,
  port,
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// Scoped accessor — only chain.js should call this. Principle of least access:
// anything that needs to sign should go through the wallet exported from chain.js,
// not pluck the raw key off of `config`.
let _dealerKeyConsumed = false;
export function getDealerKey() {
  if (_dealerKeyConsumed) {
    throw new Error('dealer key already consumed; use the wallet from chain.js');
  }
  _dealerKeyConsumed = true;
  return dealerKey;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[config.logLevel] ?? 1;

function ts() {
  return new Date().toISOString();
}

// D3 — optional file logging. Set DEALER_LOG_FILE to enable. PM2 rotation
// applies; file output is additive to stdout (PM2 still captures stdout).
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logFile = process.env.DEALER_LOG_FILE || null;
let logStream = null;
if (logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    logStream = createWriteStream(logFile, { flags: 'a' });
    console.log(`[boot] file logging → ${logFile}`);
  } catch (e) {
    console.warn(`[boot] could not open log file '${logFile}':`, e.message);
  }
}

function emit(label, color, args) {
  const line = `[${ts()}] ${label}`;
  const consoleFn = (label.startsWith('ERROR') ? console.error
                    : label.startsWith('WARN') ? console.warn : console.log);
  consoleFn(line, ...args);
  if (logStream) {
    const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try { logStream.write(`${line} ${text}\n`); } catch {}
  }
}

export const log = {
  debug: (...a) => { if (LEVELS.debug >= minLevel) emit('DEBUG', null, a); },
  info:  (...a) => { if (LEVELS.info  >= minLevel) emit('INFO ', null, a); },
  warn:  (...a) => { if (LEVELS.warn  >= minLevel) emit('WARN ', null, a); },
  error: (...a) => { if (LEVELS.error >= minLevel) emit('ERROR', null, a); },
};

/* ---------- D3 — basic metrics counters ---------- */
const _metrics = {
  startedAt: Date.now(),
  handsStarted: 0,
  handsCompleted: 0,
  dealCardsTx: 0,
  dealCommunityTx: 0,
  showdownTx: 0,
  txErrors: 0,
  emergencyRefunds: 0,
  authOk: 0,
  authFail: 0,
};

export const metrics = {
  inc(key) {
    if (key in _metrics) _metrics[key]++;
  },
  snapshot() {
    return {
      ..._metrics,
      uptimeMs: Date.now() - _metrics.startedAt,
    };
  },
};
