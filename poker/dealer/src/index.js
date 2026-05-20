/*
   Entry point. Validates chain connection + ownership, then starts WS server.
*/
import { config, log } from './config.js';
import { bootInfo } from './chain.js';
import { startServer } from './server.js';

async function main() {
  log.info('starting MollyPoker dealer node...');
  log.info(`contract: ${config.contractAddress}`);

  let boot;
  try {
    boot = await bootInfo();
  } catch (e) {
    log.error('chain bootstrap failed:', e.message);
    log.error('check MONAD_RPC and MOLLY_POKER_ADDRESS in .env');
    process.exit(1);
  }

  log.info(`chain:    ${boot.networkName} (chainId ${boot.chainId})`);
  log.info(`dealer:   ${boot.dealerAddress}`);
  log.info(`balance:  ${boot.dealerBalance} MON`);
  log.info(`owner:    ${boot.contractOwner}`);

  if (!boot.isOwner) {
    log.error('!!! dealer wallet is NOT the contract owner !!!');
    log.error(`dealCards / dealCommunityCards / showdown will all revert.`);
    log.error(`either fund the right key or transferOwnership to ${boot.dealerAddress}`);
    process.exit(1);
  }

  if (parseFloat(boot.dealerBalance) < 0.1) {
    log.warn(`!! dealer balance < 0.1 MON — top up before going live !!`);
  }

  log.info('✓ dealer is owner, ready to deal');

  const wss = startServer();

  function shutdown(sig) {
    log.info(`${sig} — closing ${wss.clients.size} ws clients`);
    wss.clients.forEach(ws => ws.close(1001, 'server shutting down'));
    wss.close(() => {
      log.info('clean exit');
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('forced exit (clients did not close)');
      process.exit(1);
    }, 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (e) => log.error('uncaught:', e));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e));
}

main();
