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
  dealerKey,
  contractAddress: contractAddressChecksum,
  port,
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[config.logLevel] ?? 1;

function ts() {
  return new Date().toISOString();
}

export const log = {
  debug: (...a) => LEVELS.debug >= minLevel && console.log(`[${ts()}] DEBUG`, ...a),
  info:  (...a) => LEVELS.info  >= minLevel && console.log(`[${ts()}] INFO `, ...a),
  warn:  (...a) => LEVELS.warn  >= minLevel && console.warn(`[${ts()}] WARN `, ...a),
  error: (...a) => LEVELS.error >= minLevel && console.error(`[${ts()}] ERROR`, ...a),
};
