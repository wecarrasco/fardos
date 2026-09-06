import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SORT, SORT_LABELS, availableSorts, isSorted, pruneSort, sortResult,
} from '../web/sorting.js';

const TCG = { vendor: 'tcgplayer', label: 'TCGplayer', currency: 'USD' };

const card = (name: string, price?: number, extra: any = {}) => ({
  name, quantity: 1, foil: false, setName: 'Set A', setId: 'aaa',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature',
  ...(price === undefined ? {} : { prices: { tcgplayer: price } }),
  ...extra,
});
const deck = (id: string, discount: number | null, cards: any[]) => ({
  deckId: id, deckName: `Deck ${id}`, deckUrl: `https://manabox.app/decks/${id}`,
  category: null, discount, deckUpdatedAt: null,
  totalQuantity: cards.length, cards,
});
const result = (decks: any[]) => ({
  query: 'x', deckCount: decks.length,
  hitCount: decks.reduce((n, d) => n + d.cards.length, 0),
  totalCopies: decks.reduce((n, d) => n + d.totalQuantity, 0),
  decks,
});

const names = (r: any) => r.decks.flatMap((d: any) => d.cards.map((c: any) => c.name));
const deckIds = (r: any) => r.decks.map((d: any) => d.deckId);

/* ---------------------------------------------------------------- *
 * Which orders are worth offering
 * ---------------------------------------------------------------- */

test('price orders are not offered without prices', () => {
  const r = result([deck('a', null, [card('One'), card('Two')])]);
  assert.deepEqual(availableSorts(r, TCG), ['match']);
});

test('price orders appear once anything is priced', () => {
  const r = result([deck('a', null, [card('One', 5), card('Two')])]);
  assert.deepEqual(availableSorts(r, TCG), ['match', 'priceAsc', 'priceDesc']);
});

test('discount order needs discounts that actually differ', () => {
  const same = result([deck('a', 20, [card('One')]), deck('b', 20, [card('Two')])]);
  assert.ok(!availableSorts(same, TCG).includes('discount'));

  const varies = result([deck('a', 20, [card('One')]), deck('b', 10, [card('Two')])]);
  assert.ok(availableSorts(varies, TCG).includes('discount'));
});

test('a stale order falls back to match rather than doing nothing', () => {
  assert.equal(pruneSort('priceAsc', ['match']), DEFAULT_SORT);
  assert.equal(pruneSort('priceAsc', ['match', 'priceAsc']), 'priceAsc');
  assert.equal(pruneSort('nonsense', ['match']), DEFAULT_SORT);
});

test('only a real reordering counts as sorted', () => {
  assert.equal(isSorted(DEFAULT_SORT), false);
  assert.equal(isSorted('priceAsc'), true);
  assert.equal(isSorted('nonsense'), false);
  assert.deepEqual(Object.keys(SORT_LABELS).sort(),
    ['discount', 'match', 'priceAsc', 'priceDesc']);
});

/* ---------------------------------------------------------------- *
 * Ordering
 * ---------------------------------------------------------------- */

test('match order is left exactly as it was', () => {
  const r = result([deck('a', null, [card('Z', 99), card('A', 1)])]);
  assert.equal(sortResult(r, 'match', TCG), r);
});

test('cheapest first orders the cards', () => {
  const r = result([deck('a', null, [card('Dear', 30), card('Cheap', 2), card('Mid', 9)])]);
  assert.deepEqual(names(sortResult(r, 'priceAsc', TCG)), ['Cheap', 'Mid', 'Dear']);
  assert.deepEqual(names(sortResult(r, 'priceDesc', TCG)), ['Dear', 'Mid', 'Cheap']);
});

test('the cheapest copy in the whole result comes first', () => {
  // The point of the order: the very first row is the answer, without reading
  // every deck to compare.
  const r = result([
    deck('dear', null, [card('A', 40), card('B', 50)]),
    deck('cheap', null, [card('C', 3), card('D', 80)]),
  ]);
  const sorted = sortResult(r, 'priceAsc', TCG);
  assert.deepEqual(deckIds(sorted), ['cheap', 'dear']);
  assert.equal(names(sorted)[0], 'C');
});

test('most valuable first leads with the dearest card, not the dearest deck average', () => {
  const r = result([
    deck('steady', null, [card('A', 20), card('B', 20)]),
    deck('spiky', null, [card('C', 1), card('D', 60)]),
  ]);
  const sorted = sortResult(r, 'priceDesc', TCG);
  assert.deepEqual(deckIds(sorted), ['spiky', 'steady']);
  assert.equal(names(sorted)[0], 'D');
});

test('an unpriced card sorts last in both directions', () => {
  // An unknown price is not a cheap one and not an expensive one, so it must
  // never lead either list.
  const r = result([deck('a', null, [card('Unknown'), card('Cheap', 1), card('Dear', 50)])]);
  assert.equal(names(sortResult(r, 'priceAsc', TCG)).at(-1), 'Unknown');
  assert.equal(names(sortResult(r, 'priceDesc', TCG)).at(-1), 'Unknown');
});

test('a deck with nothing priced sorts last, not first', () => {
  const r = result([
    deck('blank', null, [card('X'), card('Y')]),
    deck('priced', null, [card('Z', 12)]),
  ]);
  assert.deepEqual(deckIds(sortResult(r, 'priceAsc', TCG)), ['priced', 'blank']);
  assert.deepEqual(deckIds(sortResult(r, 'priceDesc', TCG)), ['priced', 'blank']);
});

test('cards at the same price fall back to their name', () => {
  const r = result([deck('a', null, [card('Beta', 5), card('Alpha', 5)])]);
  assert.deepEqual(names(sortResult(r, 'priceAsc', TCG)), ['Alpha', 'Beta']);
});

test('biggest discount orders the decks and leaves the cards alone', () => {
  const r = result([
    deck('small', 10, [card('Z', 1), card('A', 2)]),
    deck('big', 30, [card('Y', 5)]),
    deck('none', null, [card('X', 3)]),
  ]);
  const sorted = sortResult(r, 'discount', TCG);
  assert.deepEqual(deckIds(sorted), ['big', 'small', 'none']);
  // Card order within a deck is untouched: discount is a deck-level fact.
  assert.deepEqual(sorted.decks[1]!.cards.map((c: any) => c.name), ['Z', 'A']);
});

test('sorting never says what the seller charges', () => {
  // A 30%-off deck at $10 must not outrank a full-price deck at $6: applying
  // the discount to a third-party price would invent a number.
  const r = result([
    deck('discounted', 30, [card('Discounted', 10)]),
    deck('plain', null, [card('Plain', 6)]),
  ]);
  assert.deepEqual(deckIds(sortResult(r, 'priceAsc', TCG)), ['plain', 'discounted']);
});

/* ---------------------------------------------------------------- *
 * Robustness
 * ---------------------------------------------------------------- */

test('the original result is not mutated', () => {
  const r = result([deck('a', null, [card('Z', 9), card('A', 1)])]);
  const before = names(r);
  sortResult(r, 'priceAsc', TCG);
  assert.deepEqual(names(r), before);
});

test('an empty or missing result is handled', () => {
  assert.deepEqual(availableSorts(null, TCG), ['match']);
  assert.deepEqual(sortResult(result([]), 'priceAsc', TCG).decks, []);
  assert.equal(sortResult(null as any, 'priceAsc', TCG), null);
});

test('no price source means no price ordering', () => {
  const r = result([deck('a', null, [card('One', 5)])]);
  assert.deepEqual(availableSorts(r), ['match']);
  // Asked for anyway, every card looks unpriced, so nothing claims an order.
  assert.deepEqual(names(sortResult(r, 'priceAsc', undefined)), ['One']);
});
