/*
   Centralized config + logger. Validates env at boot so we fail fast
   on missing keys instead of cryptic runtime errors.
*/
import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || v.includes('<') || v.startsWith('your-')) {
    console.error(`✗ missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  rpc: required('MONAD_RPC'),
  dealerKey: required('DEALER_PRIVATE_KEY'),
  contractAddress: required('MOLLY_POKER_ADDRESS'),
  port: parseInt(process.env.PORT || '4001', 10),
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
