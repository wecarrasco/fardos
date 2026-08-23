/**
 * Standalone Linktree scraper.
 *   npm run scrape:linktree            -- pretty table
 *   npm run scrape:linktree -- --json  -- raw JSON, for piping
 *   npm run scrape:linktree -- --user someuser
 */
import { scrapeLinktree } from '../scrapers/linktree.js';
import { config } from '../config.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const userFlag = argv.indexOf('--user');
const username = userFlag !== -1 ? argv[userFlag + 1] : config.linktreeUsername;

const links = await scrapeLinktree(username);

if (asJson) {
  console.log(JSON.stringify(links, null, 2));
} else {
  let current: string | null | undefined;
  for (const l of links) {
    if (l.category !== current) {
      current = l.category;
      console.log(`\n=== ${current ?? '(ungrouped)'} ===`);
    }
    console.log(`  ${String(l.position + 1).padStart(2)}. ${l.linkText}`);
    console.log(`      ${l.url}`);
  }
  console.log(`\n${links.length} deck links total.`);
}
