import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFilters, isFiltered, facetsFor, applyFilters, pruneFilters, manaBucket, manaLabel,
  matchesColours,
} from '../web/filters.js';

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

  const stale = { ...emptyFilters(), foil: 'foil' as const, rarity: 'Mythic', typeName: 'Land', setId: 'zzz', minDiscount: 30, maxPrice: 5, manaValue: 4, colour: 'R' };
  assert.deepEqual(pruneFilters(stale, facets), emptyFilters());
});

test('choices that still apply are kept', () => {
  const facets = facetsFor(result([
    deck('a', 10, [card('One'), card('Two', { rarity: 'Common', foil: true })]),
    deck('b', 20, [card('Three')]),
  ]));

  const kept = pruneFilters(
    { ...emptyFilters(), foil: 'foil' as const, rarity: 'Common', minDiscount: 20 },
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

/* ---------------------------------------------------------------- *
 * Price ceiling
 * ---------------------------------------------------------------- */

const TCG = { vendor: 'tcgplayer', label: 'TCGplayer', currency: 'USD' };
const priced = (name: string, price?: number, extra: any = {}) =>
  card(name, { ...(price === undefined ? {} : { prices: { tcgplayer: price } }), ...extra });

test('price ceilings are not offered without prices', () => {
  const facets = facetsFor(result([deck('a', null, [card('One'), card('Two')])]), TCG);
  assert.deepEqual(facets.maxPrice, []);
});

test('a ceiling that changes nothing is not offered', () => {
  // Everything is under $100, so offering it would narrow nothing.
  const facets = facetsFor(result([
    deck('a', null, [priced('One', 1), priced('Two', 2)]),
  ]), TCG);
  const steps = facets.maxPrice.map((o: any) => o.value);
  assert.ok(!steps.includes(100));
  assert.ok(steps.includes(1), 'a step that excludes the $2 card is useful');
});

test('ceiling counts say how many entries survive', () => {
  const facets = facetsFor(result([
    deck('a', null, [priced('A', 0.5), priced('B', 3), priced('C', 40)]),
  ]), TCG);
  const under5 = facets.maxPrice.find((o: any) => o.value === 5);
  assert.equal(under5!.count, 2);
  assert.equal(under5!.label, 'Under $5');
});

test('a ceiling drops the dearer cards', () => {
  const r = result([deck('a', null, [priced('Cheap', 1), priced('Dear', 60)])]);
  const out = applyFilters(r, { ...emptyFilters(), maxPrice: 5 }, TCG);
  assert.deepEqual(out.decks[0]!.cards.map((c: any) => c.name), ['Cheap']);
  assert.equal(out.hitCount, 1);
});

test('an unpriced card is dropped by a ceiling, not let through', () => {
  // It might cost anything; showing it under "Under $5" would promise it does not.
  const r = result([deck('a', null, [priced('Known', 1), priced('Unknown')])]);
  const out = applyFilters(r, { ...emptyFilters(), maxPrice: 5 }, TCG);
  assert.deepEqual(out.decks[0]!.cards.map((c: any) => c.name), ['Known']);
});

test('a deck left with nothing under the ceiling disappears', () => {
  const r = result([
    deck('a', null, [priced('Cheap', 1)]),
    deck('b', null, [priced('Dear', 90)]),
  ]);
  const out = applyFilters(r, { ...emptyFilters(), maxPrice: 5 }, TCG);
  assert.deepEqual(out.decks.map((d: any) => d.deckId), ['a']);
  assert.equal(out.deckCount, 1);
});

test('a ceiling counts as filtering', () => {
  assert.equal(isFiltered({ ...emptyFilters(), maxPrice: 5 }), true);
  assert.equal(isFiltered(emptyFilters()), false);
});

test('a ceiling the new results cannot offer is dropped', () => {
  const facets = facetsFor(result([deck('a', null, [priced('One', 200)])]), TCG);
  const pruned = pruneFilters({ ...emptyFilters(), maxPrice: 1 }, facets);
  assert.equal(pruned.maxPrice, null);
});

/* ---------------------------------------------------------------- *
 * Mana value
 * ---------------------------------------------------------------- */

test('mana values above six share one bucket', () => {
  assert.equal(manaBucket(0), 0);
  assert.equal(manaBucket(6), 6);
  assert.equal(manaBucket(7), 7);
  assert.equal(manaBucket(13), 7, 'the tail collapses');
  assert.equal(manaLabel(6), '6');
  assert.equal(manaLabel(7), '7+');
});

test('an unknown mana value is no bucket at all', () => {
  // Not zero. A card we were told nothing about must not land under "free".
  for (const v of [null, undefined, NaN, 'three']) assert.equal(manaBucket(v as any), null);
});

test('mana buckets are offered in curve order, not by popularity', () => {
  const f = facetsFor(result([deck('a', null, [
    card('A', { mv: 5 }), card('B', { mv: 1 }), card('C', { mv: 1 }), card('D', { mv: 9 }),
  ])]));
  assert.deepEqual(f.manaValue.map((o) => [o.label, o.count]), [['1', 2], ['5', 1], ['7+', 1]]);
});

test('one mana value is not a choice', () => {
  const f = facetsFor(result([deck('a', null, [card('A', { mv: 2 }), card('B', { mv: 2 })])]));
  assert.deepEqual(f.manaValue, []);
});

test('filtering by mana value drops the unknowns with the misses', () => {
  const r = result([deck('a', null, [
    card('Two', { mv: 2 }), card('Nine', { mv: 9 }), card('Silent'),
  ])]);
  const two = applyFilters(r, { ...emptyFilters(), manaValue: 2 });
  assert.deepEqual(two.decks[0]!.cards.map((c: any) => c.name), ['Two']);

  const big = applyFilters(r, { ...emptyFilters(), manaValue: 7 });
  assert.deepEqual(big.decks[0]!.cards.map((c: any) => c.name), ['Nine'], '9 falls in 7+');
});

/* ---------------------------------------------------------------- *
 * Colour
 * ---------------------------------------------------------------- */

test('isFiltered notices the mana filters', () => {
  assert.equal(isFiltered({ ...emptyFilters(), manaValue: 0 }), true, 'mv 0 is a choice');
  assert.equal(isFiltered({ ...emptyFilters(), colours: ['C'] }), true);
  assert.equal(isFiltered({ ...emptyFilters(), colourMode: 'exactly' }), false,
    'a mode with nothing ticked narrows nothing');
});

/* ---------------------------------------------------------------- *
 * Colour: the ticks, and how they are compared
 * ---------------------------------------------------------------- */

const IZZET = 'UR', MONO_U = 'U', GRIXIS = 'BUR', NONE = 'C';

test('ticking nothing restricts nothing, whatever the mode', () => {
  for (const mode of ['including', 'exactly', 'at-most'] as const) {
    assert.equal(matchesColours(MONO_U, [], mode), true);
    assert.equal(matchesColours(undefined, [], mode), true);
  }
});

test('"including" asks for at least these colours', () => {
  assert.equal(matchesColours(IZZET, ['U'], 'including'), true);
  assert.equal(matchesColours(GRIXIS, ['U', 'R'], 'including'), true, 'extra colours are fine');
  assert.equal(matchesColours(MONO_U, ['U', 'R'], 'including'), false, 'missing red');
  assert.equal(matchesColours(NONE, ['C'], 'including'), true);
});

test('"exactly" asks for these colours and no others', () => {
  assert.equal(matchesColours(IZZET, ['U', 'R'], 'exactly'), true);
  assert.equal(matchesColours(IZZET, ['R', 'U'], 'exactly'), true, 'tick order is not meaning');
  assert.equal(matchesColours(GRIXIS, ['U', 'R'], 'exactly'), false, 'one colour too many');
  assert.equal(matchesColours(MONO_U, ['U', 'R'], 'exactly'), false, 'one colour short');
  assert.equal(matchesColours(NONE, ['C'], 'exactly'), true);
});

test('"at most" asks for nothing outside these colours', () => {
  assert.equal(matchesColours(IZZET, ['U', 'R'], 'at-most'), true);
  assert.equal(matchesColours(MONO_U, ['U', 'R'], 'at-most'), true, 'fewer is still within');
  assert.equal(matchesColours(GRIXIS, ['U', 'R'], 'at-most'), false, 'black is outside');
});

test('a colourless card is within every "at most" selection', () => {
  // The deckbuilding question: a Sol Ring goes in an Izzet deck. Nothing on it
  // is outside any pair of colours, because nothing is on it.
  assert.equal(matchesColours(NONE, ['U', 'R'], 'at-most'), true);
  assert.equal(matchesColours(NONE, ['W'], 'at-most'), true);
  // But it is not blue, and it is not exactly Izzet.
  assert.equal(matchesColours(NONE, ['U'], 'including'), false);
  assert.equal(matchesColours(NONE, ['U', 'R'], 'exactly'), false);
});

test('a card with no recorded identity answers to no selection', () => {
  // Including "at most", which otherwise waves colourless cards through: not
  // knowing a card's colours is not the same as it having none.
  for (const mode of ['including', 'exactly', 'at-most'] as const) {
    assert.equal(matchesColours(undefined, ['U'], mode), false, mode);
    assert.equal(matchesColours('', ['C'], mode), false, mode);
  }
});

test('the modes applied to a real result set', () => {
  const r = result([deck('a', null, [
    card('Izzet', { ci: 'UR' }), card('Blue', { ci: 'U' }),
    card('Grixis', { ci: 'BUR' }), card('Rock', { ci: 'C' }), card('Silent'),
  ])]);
  const names = (f: any) =>
    applyFilters(r, { ...emptyFilters(), ...f }).decks.flatMap((d: any) => d.cards.map((c: any) => c.name));

  assert.deepEqual(names({ colours: ['U', 'R'], colourMode: 'including' }), ['Izzet', 'Grixis']);
  assert.deepEqual(names({ colours: ['U', 'R'], colourMode: 'exactly' }), ['Izzet']);
  assert.deepEqual(names({ colours: ['U', 'R'], colourMode: 'at-most' }), ['Izzet', 'Blue', 'Rock']);
  assert.deepEqual(names({ colours: ['C'], colourMode: 'exactly' }), ['Rock']);
});

test('every colour present is offered, even one they all share', () => {
  // With a mode in play it still narrows: "exactly green" drops the Selesnya
  // card from an all-green pile.
  const f = facetsFor(result([deck('a', null, [
    card('Mono', { ci: 'G' }), card('Selesnya', { ci: 'GW' }),
  ])]));
  assert.deepEqual(f.colour.map((o) => [o.value, o.count]), [['W', 1], ['G', 2]]);
});

test('one colour across the whole result is no control at all', () => {
  const f = facetsFor(result([deck('a', null, [card('A', { ci: 'R' }), card('B', { ci: 'R' })])]));
  assert.deepEqual(f.colour, []);
});

test('colours are listed in WUBRG order with colourless last', () => {
  const f = facetsFor(result([deck('a', null, [
    card('A', { ci: 'G' }), card('B', { ci: 'C' }), card('C', { ci: 'W' }), card('D', { ci: 'U' }),
  ])]));
  assert.deepEqual(f.colour.map((o) => o.label), ['White', 'Blue', 'Green', 'Colorless']);
});

test('ticks the new results cannot satisfy are dropped one by one', () => {
  const facets = facetsFor(result([deck('a', null, [
    card('A', { ci: 'W' }), card('B', { ci: 'U' }),
  ])]));
  const pruned = pruneFilters(
    { ...emptyFilters(), colours: ['W', 'G'], colourMode: 'at-most' }, facets);
  assert.deepEqual(pruned.colours, ['W'], 'green is gone, white survives');
  assert.equal(pruned.colourMode, 'at-most', 'the mode is kept');

  const all = pruneFilters({ ...emptyFilters(), colours: ['G', 'R'] }, facets);
  assert.deepEqual(all.colours, [], 'nothing left means no colour filter');
});
