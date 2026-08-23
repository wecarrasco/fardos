/** Run one full refresh against the database, then exit. */
import { runRefresh } from '../jobs/refresh.js';
import { getStats } from '../db/repo.js';
import { closeDb } from '../db/index.js';

const result = await runRefresh();
console.log('\n=== refresh:', result);
console.log('=== stats  :', getStats());
closeDb();
process.exit(result.status === 'failed' ? 1 : 0);
