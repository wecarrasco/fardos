import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampArrivals, diffDecks, printingKey, deckHash, type DiffDeck } from '../scripts/lib/diff.js';

const card = (name: string, extra: Partial<any> = {}) => ({
  name, quantity: 1, foil: false, setId: 'set', collectorNumber: '1', ...extra,
});
const deck = (id: string, cards: any[]): DiffDeck => ({ id, cards });

const TODAY = '2026-08-24';
const EARLIER = '2026-08-01';

/* ---------------------------------------------------------------- *
 * Arrival stamping
 * ---------------------------------------------------------------- */

test('a first build stamps nothing', () => {
  // The regression this guards: dating every card with no history would
  // announce the whole catalogue as new arrivals.
  const decks = [deck('a', [card('Alpha'), card('Beta', { collectorNumber: '2' })])];
  assert.equal(stampArrivals(decks, null, TODAY).length, 0);
  assert.ok(decks[0]!.cards.every((c) => c.firstSeen === undefined));
});

test('printings absent from the previous index are dated today', () => {
  const previous = { decks: [deck('a', [card('Old')])] };
  const decks = [deck('a', [card('Old'), card('Brand New', { collectorNumber: '9' })])];

  const arrived = stampArrivals(decks, previous, TODAY);
  assert.deepEqual(arrived, ['Brand New|set|9|'], 'returns the keys, for the exact-build window');
  assert.equal(decks[0]!.cards[0]!.firstSeen, undefined, 'pre-existing stays undated');
  assert.equal(decks[0]!.cards[1]!.firstSeen, TODAY);
});

test('an existing arrival date is carried forward, not overwritten', () => {
  const previous = { decks: [deck('a', [card('Known', { firstSeen: EARLIER })])] };
  const decks = [deck('a', [card('Known')])];

  assert.equal(stampArrivals(decks, previous, TODAY).length, 0);
  assert.equal(decks[0]!.cards[0]!.firstSeen, EARLIER, 'must not be re-dated to today');
});

test('a card moved between decks is not a new arrival', () => {
  // Identity is catalogue-wide, so shuffling decks must not resurface a card.
  const previous = { decks: [deck('a', [card('Wanderer', { firstSeen: EARLIER })])] };
  const decks = [deck('b', [card('Wanderer')])];

  assert.equal(stampArrivals(decks, previous, TODAY).length, 0);
  assert.equal(decks[0]!.cards[0]!.firstSeen, EARLIER);
});

test('the same printing in several decks keeps the earliest date', () => {
  const previous = {
    decks: [
      deck('a', [card('Shared', { firstSeen: '2026-08-10' })]),
      deck('b', [card('Shared', { firstSeen: EARLIER })]),
    ],
  };
  const decks = [deck('a', [card('Shared')]), deck('b', [card('Shared')])];

  stampArrivals(decks, previous, TODAY);
  assert.equal(decks[0]!.cards[0]!.firstSeen, EARLIER);
  assert.equal(decks[1]!.cards[0]!.firstSeen, EARLIER);
});

test('one new printing appearing in two decks counts once', () => {
  const previous = { decks: [deck('a', [])] };
  const decks = [deck('a', [card('Fresh')]), deck('b', [card('Fresh')])];
  assert.equal(stampArrivals(decks, previous, TODAY).length, 1);
});

test('foil and non-foil are distinct printings', () => {
  const previous = { decks: [deck('a', [card('Dual')])] };
  const decks = [deck('a', [card('Dual'), card('Dual', { foil: true })])];

  assert.equal(stampArrivals(decks, previous, TODAY).length, 1, 'only the foil is new');
  assert.equal(decks[0]!.cards[1]!.firstSeen, TODAY);
});

test('a different printing of a stocked card is a new arrival', () => {
  const previous = { decks: [deck('a', [card('Reprint', { setId: 'aaa' })])] };
  const decks = [deck('a', [card('Reprint', { setId: 'aaa' }), card('Reprint', { setId: 'bbb' })])];
  assert.equal(stampArrivals(decks, previous, TODAY).length, 1);
});

test('quantity changes alone are not arrivals', () => {
  const previous = { decks: [deck('a', [card('Restocked', { quantity: 1, firstSeen: EARLIER })])] };
  const decks = [deck('a', [card('Restocked', { quantity: 12 })])];

  assert.equal(stampArrivals(decks, previous, TODAY).length, 0);
  assert.equal(decks[0]!.cards[0]!.firstSeen, EARLIER);
});

test('a card that left and came back is treated as arriving again', () => {
  const previous = { decks: [deck('a', [card('Other')])] };
  const decks = [deck('a', [card('Returned')])];
  assert.equal(stampArrivals(decks, previous, TODAY).length, 1, 'back in stock reads as new');
});

test('printingKey separates on every field that matters', () => {
  const base = card('X');
  assert.notEqual(printingKey(base), printingKey({ ...base, name: 'Y' }));
  assert.notEqual(printingKey(base), printingKey({ ...base, setId: 'other' }));
  assert.notEqual(printingKey(base), printingKey({ ...base, collectorNumber: '2' }));
  assert.notEqual(printingKey(base), printingKey({ ...base, foil: true }));
  assert.equal(printingKey(base), printingKey({ ...base, quantity: 99 }), 'quantity is not identity');
});

/* ---------------------------------------------------------------- *
 * Deck diffing
 * ---------------------------------------------------------------- */

test('deck diff reports additions, removals and content changes', () => {
  const previous = {
    decks: [deck('keep', [card('A')]), deck('edit', [card('B')]), deck('gone', [card('C')])],
  };
  const decks = [
    deck('keep', [card('A')]),
    deck('edit', [card('B', { quantity: 4 })]),
    deck('fresh', [card('D')]),
  ];

  assert.deepEqual(diffDecks(decks, previous), { added: 1, removed: 1, changed: 1, first: false });
});

test('deck diff treats a missing previous index as a first build', () => {
  const decks = [deck('a', [card('A')]), deck('b', [card('B')])];
  assert.deepEqual(diffDecks(decks, null), { added: 2, removed: 0, changed: 0, first: true });
});

test('deck hash ignores card order but not card content', () => {
  const a = deck('x', [card('One'), card('Two', { collectorNumber: '2' })]);
  const reordered = deck('x', [...a.cards].reverse());
  assert.equal(deckHash(a), deckHash(reordered));

  const changed = deck('x', [card('One', { quantity: 5 }), card('Two', { collectorNumber: '2' })]);
  assert.notEqual(deckHash(a), deckHash(changed));
});
