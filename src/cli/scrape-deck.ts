/**
 * Standalone ManaBox deck scraper.
 *   npm run scrape:deck -- AZ_RG1TNdsG5sWmkbXJ3gA
 *   npm run scrape:deck -- <id> --json
 */
import { scrapeDeck } from '../scrapers/manabox.js';
import { parseDeckId } from '../scrapers/linktree.js';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: npm run scrape:deck -- <deckId|deckUrl> [--json]');
  process.exit(1);
}
const deckId = parseDeckId(target) ?? target;
const deck = await scrapeDeck(deckId);

if (!deck) {
  console.error(`deck ${deckId} is unavailable (404/410)`);
  process.exit(2);
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(deck, null, 2));
} else {
  const total = deck.cards.reduce((n, c) => n + c.quantity, 0);
  console.log(`${deck.name}`);
  console.log(`${deck.url}`);
  console.log(`updated ${deck.lastUpdated ?? 'unknown'}`);
  console.log(`${deck.cards.length} entries / ${total} cards (page declares ${deck.declaredCardCount})\n`);

  const groups = new Map<string, typeof deck.cards>();
  for (const c of deck.cards) {
    const g = groups.get(c.typeName) ?? [];
    g.push(c);
    groups.set(c.typeName, g);
  }
  for (const [type, cards] of groups) {
    console.log(`--- ${type} (${cards.reduce((n, c) => n + c.quantity, 0)})`);
    for (const c of cards) {
      const foil = c.foil ? ' [FOIL]' : '';
      const set = c.setId ? ` (${c.setId.toUpperCase()} #${c.collectorNumber})` : '';
      console.log(`  ${String(c.quantity).padStart(2)}x ${c.name}${foil}${set}`);
    }
  }
}
