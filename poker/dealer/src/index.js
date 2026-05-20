/*
   Entry point. Validates chain connection + ownership, then starts WS server.
*/
import { config, log } from './config.js';
import { bootInfo, detachAll, onNewTableCreated } from './chain.js';
import { startServer, stopAllRunners, invalidateTotalTablesCache } from './server.js';
import { stopAuthCleanup } from './auth.js';
import { listSavedTables } from './persistence.js';
import { getRunner } from './tables.js';

async function main() {
  log.info('starting MollyPoker dealer node...');
  log.info(`contract: ${config.contractAddress}`);

  // L4 — uncaught/unhandled handlers registered FIRST so anything thrown
  // during boot or in async chains is captured.
  process.on('uncaughtException', (e) => log.error('uncaught:', e));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection:', e));

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

  // C2 — recreate runners for any tables that had persisted state from a
  // previous run. The runners will _restore() on start.
  const saved = listSavedTables();
  if (saved.length > 0) {
    log.info(`restoring ${saved.length} table(s) from disk: [${saved.join(', ')}]`);
    for (const tid of saved) {
      try { getRunner(tid); }
      catch (e) { log.warn(`failed to restore runner for table ${tid}: ${e.message}`); }
    }
  }

  // H6 — subscribe to NewTableCreated globally so events stop being dropped
  // for the window between table creation and first WS join. Also pre-warms
  // a runner for the new table (which subscribes to its per-table events).
  onNewTableCreated((tableId) => {
    const tid = Number(tableId);
    log.info(`event NewTableCreated: tableId=${tid} — pre-warming runner`);
    invalidateTotalTablesCache();
    try { getRunner(tid); }
    catch (e) { log.warn(`pre-warm runner failed for table ${tid}: ${e.message}`); }
  });

  const wss = startServer();

  async function shutdown(sig) {
    log.info(`${sig} — closing ${wss.clients.size} ws clients`);
    wss.clients.forEach(ws => ws.close(1001, 'server shutting down'));
    // Stop per-table runners (each unsubscribes its event listeners)
    try { await stopAllRunners(); } catch (e) { log.warn('stopAllRunners failed:', e.message); }
    // L5 — detach any remaining contract event listeners
    try { await detachAll(); } catch (e) { log.warn('detachAll failed:', e.message); }
    stopAuthCleanup();
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
}

// L4 — top-level catch in case main() throws before its own handlers fire
main().catch((e) => {
  log.error('fatal:', e);
  process.exit(1);
});
