/**
 * Refresh the deck list from a saved copy of the seller's Linktree page.
 *
 *   npm run decks:update -- ~/Downloads/ChelitoSAF.html
 *
 * Why a saved file rather than a fetch: linktr.ee's robots.txt refuses every
 * unnamed agent, and enforces it. A person opening a public page in their own
 * browser is not that. So the human does the fetching, and the same
 * `parseLinktree()` the scraper always used does the parsing -- no second
 * implementation to drift, and the fixture tests still cover it.
 *
 * To save the page: open https://linktr.ee/<seller> in a browser and use
 * File > Save Page As (Chrome: "Webpage, Complete" or "Single File" both work).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLinktree, deckDiscount } from '../src/scrapers/linktree.js';
import { DECK_LIST_PATH, parseDeckList, type DeckList, type DeckListEntry } from '../src/decks.js';
import { config, linktreeUrl } from '../src/config.js';
import { log } from '../src/logger.js';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const htmlPath = argv.find((a) => !a.startsWith('--'));

if (!htmlPath) {
  console.error(
    'Usage: npm run decks:update -- <saved-linktree-page.html>\n\n' +
    `Open ${linktreeUrl()} in your browser, save the page, then pass the file here.`,
  );
  process.exit(1);
}

if (!existsSync(htmlPath)) {
  console.error(`No such file: ${htmlPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');
const links = parseLinktree(html);

if (links.length === 0) {
  // Either the wrong page was saved, or Linktree changed its markup. Both are
  // worth stopping for: overwriting a good list with nothing would empty the
  // site on the next build.
  log.anomaly('no ManaBox deck links found in the saved page -- refusing to overwrite the deck list', {
    file: htmlPath,
    bytes: html.length,
  });
  console.error(
    '\nFound 0 deck links. Check that you saved the seller profile page itself,\n' +
    'not a redirect or an error page. The existing deck list was left untouched.',
  );
  process.exit(1);
}

const decks: DeckListEntry[] = links.map((link) => ({ ...link, discount: deckDiscount(link) }));

// Compare against what is already published so the change is visible rather
// than silent -- the same reason the site reports arrivals instead of just
// showing more cards.
const listPath = resolve(root, DECK_LIST_PATH);
let previous: DeckList | null = null;
if (existsSync(listPath)) {
  try {
    previous = parseDeckList(readFileSync(listPath, 'utf8'));
  } catch {
    previous = null; // a corrupt existing list is replaced, not merged
  }
}

const before = new Map((previous?.decks ?? []).map((d) => [d.deckId, d]));
const after = new Map(decks.map((d) => [d.deckId, d]));

const added = decks.filter((d) => !before.has(d.deckId));
const removed = (previous?.decks ?? []).filter((d) => !after.has(d.deckId));
const repriced = decks.filter((d) => {
  const was = before.get(d.deckId);
  return was && (was.discount ?? null) !== (d.discount ?? null);
});

const list: DeckList = {
  capturedAt: new Date().toISOString().slice(0, 10),
  source: linktreeUrl(config.linktreeUsername),
  decks,
};

writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');

log.info('deck list written', {
  out: DECK_LIST_PATH,
  decks: decks.length,
  withDiscount: decks.filter((d) => d.discount !== null).length,
});

const lines = [`${decks.length} decks written to ${DECK_LIST_PATH}`];
if (previous) {
  lines.push(
    `  added:    ${added.length}${added.length ? ` (${added.map((d) => d.linkText.trim()).join(', ')})` : ''}`,
    `  removed:  ${removed.length}${removed.length ? ` (${removed.map((d) => d.linkText.trim()).join(', ')})` : ''}`,
    `  repriced: ${repriced.length}${repriced.length ? ` (${repriced.map((d) => `${d.linkText.trim()}: ${before.get(d.deckId)?.discount ?? 'none'}% -> ${d.discount ?? 'none'}%`).join('; ')})` : ''}`,
  );
} else {
  lines.push('  (no previous list to compare against)');
}
console.log(lines.join('\n'));
