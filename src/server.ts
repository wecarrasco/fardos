import { config } from './config.js';
import { log } from './logger.js';
import { getDb, closeDb } from './db/index.js';
import { reconcileInterruptedRuns, getStats } from './db/repo.js';
import { createApp } from './app.js';

getDb();

// A process killed mid-refresh leaves its run row open; close it so the run
// history stays honest.
const interrupted = reconcileInterruptedRuns();
if (interrupted > 0) log.warn(`closed ${interrupted} run(s) left open by a previous process`);

const server = createApp().listen(config.port, () => {
  log.info(`server listening on http://localhost:${config.port}`);

  const stats = getStats();
  if (!stats.activeDecks) {
    log.warn('the index is empty -- press "Update now" in the web UI, or run `npm run refresh`');
  } else {
    log.info(`index holds ${stats.activeDecks} decks / ${stats.totalCards} cards`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`received ${sig}, shutting down`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}
