/**
 * Rebuild the format-legality table from Scryfall's bulk data.
 *
 *   npm run legality:update
 *
 * Run this on a laptop a few times a year -- after a banned-list announcement
 * or a set release -- and commit the result. The build never fetches it; see
 * src/legality.ts for why a 25MB immutable download does not belong in a job
 * that runs twice a day.
 *
 * Scryfall permits this. Their robots.txt disallows only /admin and the error
 * pages, and the bulk files exist so that projects download one file instead
 * of making 35,000 API calls.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import {
  LEGAL_FORMATS, LEGALITY_PATH, legalityBits, legalityKey,
  parseLegalityTable, type LegalityTable,
} from '../src/legality.js';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BULK_META = 'https://api.scryfall.com/bulk-data/oracle_cards';

/**
 * Layouts that print a real card's name on something that is not that card.
 *
 * Art Series cards are the dangerous ones: oracle_cards carries one row per
 * oracle id, and an Art Series "Mortify" has the same name as the real one,
 * costs nothing and is legal nowhere. A first-wins name join picks whichever
 * came first in the file, which is how a probe produced an index claiming
 * Mortify was banned everywhere.
 */
const NOT_A_CARD = new Set([
  'art_series', 'token', 'double_faced_token', 'emblem',
  'scheme', 'planar', 'vanguard', 'augment', 'host',
]);

async function main() {
  const headers = { 'user-agent': config.userAgent, accept: 'application/json' };

  const metaRes = await fetch(BULK_META, { headers });
  if (!metaRes.ok) throw new Error(`Scryfall bulk metadata: HTTP ${metaRes.status}`);
  const meta = await metaRes.json() as { jsonl_download_uri: string; compressed_size: number; updated_at: string };

  console.log(
    `Scryfall oracle_cards, updated ${meta.updated_at}\n` +
    `Downloading ${(meta.compressed_size / 1e6).toFixed(1)} MB...`,
  );

  const res = await fetch(meta.jsonl_download_uri, { headers: { 'user-agent': config.userAgent } });
  if (!res.ok || !res.body) throw new Error(`Scryfall bulk download: HTTP ${res.status}`);

  // Streamed, not buffered: 25MB compressed is 400MB of JSON, and we keep a
  // name and six bits from each row.
  const lines = createInterface({
    input: Readable.fromWeb(res.body as any).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  /** @see NOT_A_CARD -- a real card always wins a name it shares with a decoy. */
  const legalities: Record<string, number> = {};
  const claimedByDecoy = new Set<string>();
  let rows = 0, decoys = 0, reclaimed = 0, legalInNothing = 0;

  for await (const line of lines) {
    if (!line.trim()) continue;
    rows++;
    const card = JSON.parse(line) as { name: string; layout: string; legalities: Record<string, string> };

    const key = legalityKey(card.name);
    if (NOT_A_CARD.has(card.layout)) {
      decoys++;
      claimedByDecoy.add(key);
      continue;
    }
    if (claimedByDecoy.has(key)) reclaimed++;

    const bits = legalityBits(card.legalities);
    // A card legal in none of the six is left out: absent and zero mean the
    // same thing to every reader, and absent is 30 bytes cheaper.
    if (bits === 0) { legalInNothing++; continue; }
    if (legalities[card.name] === undefined) legalities[card.name] = bits;
  }

  if (Object.keys(legalities).length === 0) {
    // Either Scryfall changed the format or the download was truncated. Both
    // are worth stopping for: overwriting a good table with nothing would make
    // the whole catalogue look illegal on the next build.
    log.anomaly('no legal cards found in the bulk file -- refusing to overwrite the legality table', {
      rows, decoys,
    });
    console.error('\nParsed 0 legal cards. The existing table was left untouched.');
    process.exit(1);
  }

  const path = resolve(root, LEGALITY_PATH);
  let previous: LegalityTable | null = null;
  if (existsSync(path)) {
    try {
      previous = parseLegalityTable(readFileSync(path, 'utf8'));
    } catch {
      previous = null;   // a table we cannot read is replaced, not merged
    }
  }

  // Sorted so that refreshing produces a readable diff instead of a reshuffle.
  const sorted = Object.fromEntries(
    Object.entries(legalities).sort(([a], [b]) => a.localeCompare(b)),
  );

  const table: LegalityTable = {
    capturedAt: new Date().toISOString().slice(0, 10),
    source: meta.jsonl_download_uri,
    formats: [...LEGAL_FORMATS],
    legalities: sorted,
  };
  writeFileSync(path, `${JSON.stringify(table, null, 1)}\n`, 'utf8');

  log.info('legality table written', {
    out: LEGALITY_PATH, cards: Object.keys(sorted).length, rows, decoys,
  });

  const before = previous?.legalities ?? {};
  const added = Object.keys(sorted).filter((n) => before[n] === undefined);
  const removed = Object.keys(before).filter((n) => sorted[n] === undefined);
  const changed = Object.keys(sorted).filter((n) => before[n] !== undefined && before[n] !== sorted[n]);

  const named = (list: string[], n = 8) =>
    list.length ? ` (${list.slice(0, n).join(', ')}${list.length > n ? `, +${list.length - n} more` : ''})` : '';

  console.log(
    `\n${Object.keys(sorted).length} cards written to ${LEGALITY_PATH}\n` +
    `  from ${rows} rows, skipping ${decoys} tokens and art cards` +
    `${reclaimed ? ` (${reclaimed} names reclaimed from one)` : ''}\n` +
    `  ${legalInNothing} cards legal in none of the six formats, left out\n` +
    (previous
      ? `  added:   ${added.length}${named(added)}\n` +
        `  removed: ${removed.length}${named(removed)}\n` +
        `  changed: ${changed.length}${named(changed)}`
      : '  (no previous table to compare against)'),
  );

  if (changed.length) {
    console.log('\nLegality changed -- usually a ban, an unban, or a rotation:');
    for (const n of changed.slice(0, 20)) {
      const was = LEGAL_FORMATS.filter((_, i) => before[n]! & (1 << i));
      const now = LEGAL_FORMATS.filter((_, i) => sorted[n]! & (1 << i));
      console.log(`  ${n}: ${was.join(',') || 'none'} -> ${now.join(',') || 'none'}`);
    }
  }
}

main().catch((err) => {
  log.anomaly('legality update failed -- the existing table was left untouched', { err: String(err) });
  console.error(`\n${String(err)}`);
  process.exit(1);
});
