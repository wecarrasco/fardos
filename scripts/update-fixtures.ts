/**
 * Re-download the test fixtures from the live sites.
 *
 *   npm run fixtures:update
 *
 * Fixtures are stored gzipped because the raw pages are ~300-800 KB each. Run
 * this when a parser test starts failing for a reason you believe is a real
 * site change rather than a regression -- then re-read the diff before
 * committing, since a fixture update silently redefines what "correct" means.
 */
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchHtml, sleep } from '../src/scrapers/http.js';
import { linktreeUrl } from '../src/config.js';
import { FIXTURES, FIXTURE_DIR } from '../test/fixture-manifest.js';

mkdirSync(FIXTURE_DIR, { recursive: true });

const targets: Array<{ file: string; url: string }> = [
  { file: 'linktree.html.gz', url: linktreeUrl() },
  ...Object.values(FIXTURES)
    .filter((f) => 'deckId' in f && f.deckId)
    .map((f) => ({ file: f.file, url: `https://manabox.app/decks/${f.deckId}` })),
];

for (const [i, t] of targets.entries()) {
  if (i > 0) await sleep(1200);
  const html = await fetchHtml(t.url);
  const gz = gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
  writeFileSync(resolve(FIXTURE_DIR, t.file), gz);
  console.log(
    `${t.file.padEnd(28)} ${String(Math.round(html.length / 1024)).padStart(4)}KB -> ` +
    `${String(Math.round(gz.length / 1024)).padStart(3)}KB  ${t.url}`,
  );
}
