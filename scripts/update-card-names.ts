/**
 * Rebuild the list of every Magic card name from Scryfall's catalog.
 *
 *   npm run names:update
 *
 * Run it after a set release and commit the result, the same way the legality
 * table is kept. The twice-daily build never fetches it: the file changes a
 * few times a year and the job has no business depending on a third party to
 * publish a page.
 *
 * Scryfall permits this. Their robots.txt disallows only /admin and the error
 * pages, and `/catalog/card-names` exists precisely so a project downloads one
 * list instead of making 35,000 calls.
 *
 * Why the names and not the legality table we already have: that table holds
 * only cards legal in at least one of the six formats, so Black Lotus,
 * Ancestral Recall, Mox Sapphire and Chaos Orb are missing from it -- exactly
 * the cards someone puts on a wishlist.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = 'https://api.scryfall.com/catalog/card-names';
const OUT = 'card-names.json';

/**
 * Below this, something is wrong at the other end and the committed list is
 * the better answer. Scryfall returned 35,667 names in November 2026 and that
 * number only grows, so a response with a fraction of it is a fault, not a
 * shrinking game.
 */
const MIN_NAMES = 30_000;

async function main() {
  const res = await fetch(CATALOG, {
    headers: { 'user-agent': config.userAgent, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`catalog request failed: HTTP ${res.status}`);

  const body = (await res.json()) as { object?: string; total_values?: number; data?: unknown };
  const names = Array.isArray(body.data)
    ? body.data.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : [];

  if (names.length < MIN_NAMES) {
    log.anomaly('card-name catalog came back too small -- refusing to overwrite the list', {
      got: names.length, expected: `>= ${MIN_NAMES}`, url: CATALOG,
    });
    process.exitCode = 1;
    return;
  }

  // Sorted so a diff shows what a set actually added, rather than re-ordering
  // 35,000 lines whenever Scryfall changes how it walks its own table.
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));

  const path = resolve(root, OUT);
  const before: string[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const had = new Set(before);
  const added = sorted.filter((n) => !had.has(n));
  const now = new Set(sorted);
  const removed = before.filter((n) => !now.has(n));

  writeFileSync(path, `${JSON.stringify(sorted)}\n`, 'utf8');

  log.info('card names written', {
    out: OUT,
    names: sorted.length,
    sizeKb: Math.round(JSON.stringify(sorted).length / 1024),
    added: added.length,
    removed: removed.length,
  });
  // Named, not just counted: a removal is rare enough that seeing which name
  // vanished is worth a line, and a wrong one is how a wishlist loses a card.
  for (const n of added.slice(0, 10)) log.info(`  + ${n}`);
  if (added.length > 10) log.info(`  ... and ${added.length - 10} more`);
  for (const n of removed.slice(0, 10)) log.info(`  - ${n}`);
  if (removed.length > 10) log.info(`  ... and ${removed.length - 10} more`);
}

main().catch((err) => {
  log.anomaly('card-name update failed -- the existing list was left untouched', {
    err: String(err),
  });
  process.exitCode = 1;
});
