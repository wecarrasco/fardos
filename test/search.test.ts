import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { search, suggest, rankMatch } from '../web/search.js';
import { parseDeckPage } from '../src/scrapers/manabox.js';
import { normalizeCardName } from '../web/normalize.js';
import { readFixture, FIXTURES } from './fixture-manifest.js';

/**
 * Build an index in the same shape scripts/build-index.ts emits, so these tests
 * exercise the real contract between the build output and the browser.
 */
function buildIndex(keys: (keyof typeof FIXTURES)[]) {
  return {
    generatedAt: new Date().toISOString(),
    decks: keys.map((k, i) => {
      const d = parseDeckPage(readFixture(FIXTURES[k].file), FIXTURES[k].deckId);
      return {
        id: d.deckId,
        name: d.name,
        url: d.url,
        category: i === 0 ? null : 'A CATEGORY',
        updatedAt: d.lastUpdated,
        cardCount: d.cards.reduce((n, c) => n + c.quantity, 0),
        cards: d.cards.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          foil: c.foil,
          setName: c.setName,
          setId: c.setId,
          collectorNumber: c.collectorNumber,
          rarity: c.rarity,
          typeName: c.typeName,
        })),
      };
    }),
  };
}

let index: ReturnType<typeof buildIndex>;
before(() => { index = buildIndex(['mixed', 'small', 'planeswalkers']); });

/* ---------------------------------------------------------------- *
 * Matching
 * ---------------------------------------------------------------- */

test('finds a card and reports deck, entry and copy counts', () => {
  const r = search(index, 'seedborn muse');
  assert.equal(r.deckCount, 1);
  assert.equal(r.hitCount, 2);
  assert.equal(r.totalCopies, 4);
});

test('keeps distinct printings as separate entries', () => {
  const cards = search(index, 'seedborn muse').decks[0]!.cards;
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.setId).sort(), ['10e', 'bbd']);
});

test('matching is case, accent and punctuation insensitive', () => {
  assert.ok(search(index, 'BALEFUL STRIX').hitCount > 0);
  assert.ok(search(index, 'anhelo, the painter').hitCount > 0);
  assert.ok(search(index, 'anhelo the painter').hitCount > 0);
});

/* ---------------------------------------------------------------- *
 * Word order
 * ---------------------------------------------------------------- */

test('words may be given in any order', () => {
  // The defect this fixes: a substring match made word order mandatory, so a
  // half-remembered name found nothing at all.
  for (const [a, b] of [['seedborn muse', 'muse seedborn'], ['baleful strix', 'strix baleful']]) {
    const inOrder = search(index, a);
    const reversed = search(index, b);
    assert.ok(inOrder.hitCount > 0, `"${a}" should match`);
    assert.equal(reversed.hitCount, inOrder.hitCount, `"${b}" should match the same cards`);
  }
});

test('every word must be present, not just one of them', () => {
  assert.equal(search(index, 'seedborn zzzznotacard').hitCount, 0);
});

test('words may match partially and out of order', () => {
  assert.ok(search(index, 'muse seed').hitCount > 0, 'prefixes of each word are enough');
});

test('a phrase match outranks a mere scattering of the same words', () => {
  const ranks = search(index, 'seedborn muse').decks.flatMap((d) => d.cards)
    .map((c) => c.name);
  assert.ok(ranks.length > 0);

  // rankMatch is the ordering rule the search relies on.
  assert.equal(rankMatch('seedborn muse', 'seedborn muse', ['seedborn', 'muse']), 0, 'exact');
  assert.equal(rankMatch('seedborn muse of x', 'seedborn muse', ['seedborn', 'muse']), 1, 'prefix');
  assert.equal(rankMatch('the seedborn muse', 'seedborn muse', ['seedborn', 'muse']), 2, 'inside');
  assert.equal(rankMatch('muse of the seedborn', 'seedborn muse', ['seedborn', 'muse']), 3, 'scattered');
  assert.equal(rankMatch('seedborn only', 'seedborn muse', ['seedborn', 'muse']), -1, 'incomplete');
});

test('a single word is not split, so it cannot match more loosely', () => {
  assert.equal(rankMatch('lightning bolt', 'zzz', ['zzz']), -1);
  assert.equal(rankMatch('lightning bolt', 'bolt', ['bolt']), 2);
});

test('suggestions honour word order too', () => {
  const forward = suggest(index, 'seedborn muse', 10);
  const reversed = suggest(index, 'muse seedborn', 10);
  assert.deepEqual(reversed, forward);
});

test('matches substrings anywhere in the name', () => {
  const names = search(index, 'muse').decks.flatMap((d) => d.cards.map((c) => c.name));
  assert.ok(names.includes('Seedborn Muse'));
});

test('reports foil status and printing detail', () => {
  const card = search(index, 'barrowgoyf').decks[0]!.cards[0]!;
  assert.equal(card.foil, true);
  assert.equal(card.setId, 'sld');
  assert.equal(card.rarity, 'Rare');
});

test('empty and unmatched queries return an empty result, not an error', () => {
  for (const q of ['', '   ', '---', 'zzzznotacard', null, undefined]) {
    const r = search(index, q);
    assert.deepEqual(r.decks, []);
    assert.equal(r.deckCount, 0);
    assert.equal(r.totalCopies, 0);
  }
});

test('a missing or malformed index does not throw', () => {
  assert.deepEqual(search(null as any, 'sol').decks, []);
  assert.deepEqual(search({} as any, 'sol').decks, []);
});

/* ---------------------------------------------------------------- *
 * Ranking
 * ---------------------------------------------------------------- */

test('an exact name outranks a longer name containing it', () => {
  // "Ocelot Pride" exists; searching it must not be buried under partial matches.
  const first = search(index, 'ocelot pride').decks[0]!.cards[0]!;
  assert.equal(first.name, 'Ocelot Pride');
});

test('prefix matches rank above mid-word matches', () => {
  const cards = search(index, 'sol').decks.flatMap((d) => d.cards);
  const firstPrefix = cards.findIndex((c) => normalizeCardName(c.name).startsWith('sol'));
  const firstMid = cards.findIndex((c) => !normalizeCardName(c.name).startsWith('sol'));
  if (firstPrefix !== -1 && firstMid !== -1) {
    assert.ok(firstPrefix < firstMid, 'a prefix match should come first');
  }
});

test('decks holding a better match are listed first', () => {
  const r = search(index, 'island');
  if (r.decks.length > 1) {
    const ranks = r.decks.map((d) => d.bestRank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }
});

/* ---------------------------------------------------------------- *
 * Grouping and shape
 * ---------------------------------------------------------------- */

test('results carry the deck context the UI renders', () => {
  const deck = search(index, 'seedborn muse').decks[0]!;
  assert.equal(deck.deckName, 'SAF/ON THE ROAD 🛣️');
  assert.match(deck.deckUrl, /^https:\/\/manabox\.app\/decks\//);
  assert.ok(deck.deckUpdatedAt, 'the UI shows a per-deck freshness date');
  assert.equal(deck.totalQuantity, 4);
});

test('totals across decks add up', () => {
  const r = search(index, 'a');
  const summed = r.decks.reduce((n, d) => n + d.totalQuantity, 0);
  const entries = r.decks.reduce((n, d) => n + d.cards.length, 0);
  assert.equal(summed, r.totalCopies);
  assert.equal(entries, r.hitCount);
  assert.equal(r.deckCount, r.decks.length);
});

test('the limit caps work without corrupting the totals', () => {
  const r = search(index, 'a', { limit: 5 });
  assert.ok(r.hitCount <= 5);
  assert.equal(r.decks.reduce((n, d) => n + d.cards.length, 0), r.hitCount);
});

/* ---------------------------------------------------------------- *
 * Suggestions
 * ---------------------------------------------------------------- */

test('suggestions are distinct names with prefixes first', () => {
  assert.deepEqual(suggest(index, 'seedborn'), ['Seedborn Muse']);

  const sols = suggest(index, 'sol', 10);
  assert.equal(new Set(sols).size, sols.length, 'no duplicates');
  const firstMid = sols.findIndex((n) => !normalizeCardName(n).startsWith('sol'));
  const lastPrefix = sols.map((n) => normalizeCardName(n).startsWith('sol')).lastIndexOf(true);
  if (firstMid !== -1 && lastPrefix !== -1) assert.ok(lastPrefix < firstMid);
});

test('suggestions respect the limit and handle empty input', () => {
  assert.ok(suggest(index, 'a', 3).length <= 3);
  assert.deepEqual(suggest(index, ''), []);
  assert.deepEqual(suggest(null as any, 'sol'), []);
});
