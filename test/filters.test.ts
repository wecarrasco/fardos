import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, isFiltered, facetsFor, applyFilters, pruneFilters } from '../web/filters.js';

const card = (name: string, extra: any = {}) => ({
  name, quantity: 2, foil: false, setName: 'Set A', setId: 'aaa',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature', ...extra,
});
const deck = (id: string, discount: number | null, cards: any[]) => ({
  deckId: id, deckName: `Deck ${id}`, deckUrl: `https://manabox.app/decks/${id}`,
  category: null, discount, deckUpdatedAt: null,
  totalQuantity: cards.reduce((n: number, c: any) => n + c.quantity, 0), cards,
});
const result = (decks: any[]) => ({
  query: 'x', deckCount: decks.length,
  hitCount: decks.reduce((n, d) => n + d.cards.length, 0),
  totalCopies: decks.reduce((n, d) => n + d.totalQuantity, 0),
  decks,
});

/* ---------------------------------------------------------------- *
 * Which controls are worth showing
 * ---------------------------------------------------------------- */

test('a dimension with only one value is not offered', () => {
  // Offering "Any rarity" when everything is Rare is a dead control.
  const f = facetsFor(result([deck('a', 10, [card('One'), card('Two')])]));
  assert.deepEqual(f.rarity, []);
  assert.deepEqual(f.typeName, []);
  assert.deepEqual(f.setId, []);
  assert.equal(f.foil, null, 'no foil toggle when nothing is foil');
  assert.deepEqual(f.discount, [], 'one discount tier is not a choice');
});

test('dimensions that vary are offered with counts', () => {
  const f = facetsFor(result([
    deck('a', 10, [card('One'), card('Two', { rarity: 'Common', typeName: 'Land' })]),
    deck('b', 20, [card('Three', { setId: 'bbb', setName: 'Set B' })]),
  ]));

  assert.deepEqual(f.rarity.map((o) => [o.value, o.count]), [['Rare', 2], ['Common', 1]]);
  assert.deepEqual(f.typeName.map((o) => o.value), ['Creature', 'Land']);
  assert.deepEqual(f.setId.map((o) => [o.value, o.label]), [['aaa', 'Set A'], ['bbb', 'Set B']]);
  assert.deepEqual(f.discount.map((o) => o.value), [20, 10], 'biggest discount first');
});

test('the foil toggle appears only when both finishes are present', () => {
  const both = facetsFor(result([deck('a', null, [card('One'), card('Two', { foil: true })])]));
  assert.deepEqual(both.foil, { foil: 1, nonfoil: 1 });

  const allFoil = facetsFor(result([deck('a', null, [card('One', { foil: true })])]));
  assert.equal(allFoil.foil, null);
});

test('facets ignore an empty or missing result', () => {
  for (const r of [null, undefined, { decks: [] }]) {
    const f = facetsFor(r as any);
    assert.equal(f.foil, null);
    assert.deepEqual(f.rarity, []);
  }
});

/* ---------------------------------------------------------------- *
 * Applying a selection
 * ---------------------------------------------------------------- */

test('an empty selection returns the results untouched', () => {
  const r = result([deck('a', 10, [card('One')])]);
  assert.equal(applyFilters(r, emptyFilters()), r, 'same object, no needless work');
});

test('filtering by finish, rarity, type and set', () => {
  const r = result([deck('a', null, [
    card('Foiled', { foil: true }),
    card('Plain'),
    card('Common Land', { rarity: 'Common', typeName: 'Land' }),
    card('Other Set', { setId: 'bbb' }),
  ])]);

  const only = (f: any) => applyFilters(r, { ...emptyFilters(), ...f }).decks[0]!.cards.map((c: any) => c.name);
  assert.deepEqual(only({ foil: 'foil' }), ['Foiled']);
  assert.deepEqual(only({ foil: 'nonfoil' }), ['Plain', 'Common Land', 'Other Set']);
  assert.deepEqual(only({ rarity: 'Common' }), ['Common Land']);
  assert.deepEqual(only({ typeName: 'Land' }), ['Common Land']);
  assert.deepEqual(only({ setId: 'bbb' }), ['Other Set']);
});

test('discount filtering removes whole decks, since it is a deck property', () => {
  const r = result([
    deck('cheap', 20, [card('One')]),
    deck('dear', 10, [card('Two')]),
    deck('none', null, [card('Three')]),
  ]);
  const kept = applyFilters(r, { ...emptyFilters(), minDiscount: 20 });
  assert.deepEqual(kept.decks.map((d) => d.deckId), ['cheap']);
});

test('decks left with nothing are dropped, not shown empty', () => {
  const r = result([
    deck('a', null, [card('Foiled', { foil: true })]),
    deck('b', null, [card('Plain')]),
  ]);
  const kept = applyFilters(r, { ...emptyFilters(), foil: 'foil' });
  assert.deepEqual(kept.decks.map((d) => d.deckId), ['a']);
});

test('totals are recomputed to match what is shown', () => {
  const r = result([deck('a', null, [
    card('Foiled', { foil: true, quantity: 3 }),
    card('Plain', { quantity: 5 }),
  ])]);

  const kept = applyFilters(r, { ...emptyFilters(), foil: 'foil' });
  assert.equal(kept.hitCount, 1);
  assert.equal(kept.totalCopies, 3);
  assert.equal(kept.deckCount, 1);
  assert.equal(kept.decks[0]!.totalQuantity, 3, 'the deck header must agree too');
});

test('filters combine', () => {
  const r = result([deck('a', null, [
    card('Wanted', { foil: true, rarity: 'Mythic' }),
    card('Wrong rarity', { foil: true }),
    card('Wrong finish', { rarity: 'Mythic' }),
  ])]);
  const kept = applyFilters(r, { ...emptyFilters(), foil: 'foil', rarity: 'Mythic' });
  assert.deepEqual(kept.decks[0]!.cards.map((c: any) => c.name), ['Wanted']);
});

test('a selection matching nothing yields an empty result, not a crash', () => {
  const r = result([deck('a', null, [card('One')])]);
  const kept = applyFilters(r, { ...emptyFilters(), rarity: 'Mythic' });
  assert.deepEqual(kept.decks, []);
  assert.equal(kept.hitCount, 0);
  assert.equal(kept.totalCopies, 0);
});

/* ---------------------------------------------------------------- *
 * Not stranding the reader
 * ---------------------------------------------------------------- */

test('choices the new results cannot satisfy are dropped', () => {
  // Otherwise changing the search leaves a stale filter and an empty page.
  const facets = facetsFor(result([
    deck('a', 10, [card('One'), card('Two', { rarity: 'Common' })]),
  ]));

  const stale = { foil: 'foil' as const, rarity: 'Mythic', typeName: 'Land', setId: 'zzz', minDiscount: 30 };
  assert.deepEqual(pruneFilters(stale, facets), emptyFilters());
});

test('choices that still apply are kept', () => {
  const facets = facetsFor(result([
    deck('a', 10, [card('One'), card('Two', { rarity: 'Common', foil: true })]),
    deck('b', 20, [card('Three')]),
  ]));

  const kept = pruneFilters(
    { foil: 'foil', rarity: 'Common', typeName: null, setId: null, minDiscount: 20 },
    facets,
  );
  assert.equal(kept.foil, 'foil');
  assert.equal(kept.rarity, 'Common');
  assert.equal(kept.minDiscount, 20);
});

test('isFiltered reports whether anything is narrowing', () => {
  assert.equal(isFiltered(emptyFilters()), false);
  assert.equal(isFiltered({ ...emptyFilters(), foil: 'foil' }), true);
  assert.equal(isFiltered({ ...emptyFilters(), minDiscount: 10 }), true);
});
