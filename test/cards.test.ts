import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardImageUrl, scryfallPageUrl, otherDecksWithCard, totalsForName, printingKey, sortCardTypes }
  from '../web/cards.js';

const card = (name: string, extra: any = {}) => ({
  name, quantity: 1, foil: false, setName: 'Set', setId: 'set',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature', ...extra,
});
const deck = (id: string, cards: any[]) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, updatedAt: null, cardCount: 0, cards,
});
const index = (decks: any[]) => ({ decks });

/* ---------------------------------------------------------------- *
 * Image and page URLs
 * ---------------------------------------------------------------- */

test('derives the image from set and collector number', () => {
  assert.equal(
    cardImageUrl(card('Sol Ring', { setId: 'sld', collectorNumber: '2467' })),
    'https://api.scryfall.com/cards/sld/2467?format=image&version=normal',
  );
});

test('lowercases the set code and escapes odd collector numbers', () => {
  assert.match(cardImageUrl(card('x', { setId: 'PNEO', collectorNumber: '199p' }))!, /cards\/pneo\/199p\?/);
  assert.match(cardImageUrl(card('x', { collectorNumber: '1/2' }))!, /cards\/set\/1%2F2\?/);
});

test('honours the requested image size', () => {
  assert.match(cardImageUrl(card('x'), 'small')!, /version=small$/);
  assert.match(cardImageUrl(card('x'), 'large')!, /version=large$/);
});

test('yields nothing when the printing is unknown', () => {
  // DOM-fallback parsing produces cards with no set or collector number.
  for (const bad of [{ setId: null }, { collectorNumber: null }, { setId: null, collectorNumber: null }]) {
    assert.equal(cardImageUrl(card('x', bad)), null);
    assert.equal(scryfallPageUrl(card('x', bad)), null);
  }
  assert.equal(cardImageUrl(null as any), null);
});

test('links to the printing on Scryfall', () => {
  assert.equal(
    scryfallPageUrl(card('x', { setId: 'MH3', collectorNumber: '451' })),
    'https://scryfall.com/card/mh3/451',
  );
});

/* ---------------------------------------------------------------- *
 * Where else the card is
 * ---------------------------------------------------------------- */

test('finds the same printing in other decks, excluding the current one', () => {
  const i = index([
    deck('a', [card('Sol Ring', { quantity: 2 })]),
    deck('b', [card('Sol Ring', { quantity: 3 })]),
    deck('c', [card('Something Else')]),
  ]);

  const others = otherDecksWithCard(i, card('Sol Ring'), 'a');
  assert.deepEqual(others.map((o) => [o.deckId, o.quantity]), [['b', 3]]);
});

test('a different printing of the same card is not the same card', () => {
  // Same name, different set: a buyer asking for this exact printing is not
  // served by the other one, so it must not be offered as "also in".
  const i = index([
    deck('a', [card('Sol Ring', { setId: 'sld' })]),
    deck('b', [card('Sol Ring', { setId: 'c21' })]),
  ]);
  assert.deepEqual(otherDecksWithCard(i, card('Sol Ring', { setId: 'sld' }), 'a'), []);
});

test('foil and non-foil are different printings', () => {
  const i = index([
    deck('a', [card('Sol Ring')]),
    deck('b', [card('Sol Ring', { foil: true })]),
  ]);
  assert.deepEqual(otherDecksWithCard(i, card('Sol Ring'), 'a'), []);
  assert.equal(otherDecksWithCard(i, card('Sol Ring', { foil: true }), 'b').length, 0);
});

test('several entries of one printing in a deck are summed', () => {
  const i = index([
    deck('a', [card('Sol Ring')]),
    deck('b', [card('Sol Ring', { quantity: 2 }), card('Sol Ring', { quantity: 5 })]),
  ]);
  assert.deepEqual(otherDecksWithCard(i, card('Sol Ring'), 'a').map((o) => o.quantity), [7]);
});

test('handles an empty or missing index', () => {
  assert.deepEqual(otherDecksWithCard(null as any, card('x'), 'a'), []);
  assert.deepEqual(otherDecksWithCard(index([]), card('x'), 'a'), []);
  assert.deepEqual(otherDecksWithCard(index([deck('a', [])]), null as any, 'a'), []);
});

/* ---------------------------------------------------------------- *
 * Totals by name
 * ---------------------------------------------------------------- */

test('totals count every copy of a name across printings and decks', () => {
  const i = index([
    deck('a', [card('Sol Ring', { quantity: 2 }), card('Sol Ring', { setId: 'c21', quantity: 1 })]),
    deck('b', [card('Sol Ring', { quantity: 3, foil: true })]),
    deck('c', [card('Other')]),
  ]);

  assert.deepEqual(totalsForName(i, 'Sol Ring'), { copies: 6, printings: 3, decks: 2 });
});

test('a name that is not stocked totals to nothing', () => {
  assert.deepEqual(totalsForName(index([deck('a', [card('x')])]), 'Nope'),
    { copies: 0, printings: 0, decks: 0 });
});

test('printingKey separates on the fields that define a printing', () => {
  const base = card('X');
  assert.notEqual(printingKey(base), printingKey(card('Y')));
  assert.notEqual(printingKey(base), printingKey(card('X', { setId: 'other' })));
  assert.notEqual(printingKey(base), printingKey(card('X', { collectorNumber: '2' })));
  assert.notEqual(printingKey(base), printingKey(card('X', { foil: true })));
  assert.equal(printingKey(base), printingKey(card('X', { quantity: 99 })),
    'quantity is stock, not identity');
});

/* ---------------------------------------------------------------- *
 * Card-type ordering
 * ---------------------------------------------------------------- */

test('card types sort into reading order, not the order encountered', () => {
  assert.deepEqual(
    sortCardTypes(['Land', 'Instant', 'Creature', 'Artifact']),
    ['Creature', 'Artifact', 'Instant', 'Land'],
  );
});

test('the order does not change when types drop out', () => {
  // Narrowing a deck must remove sections without shuffling the survivors.
  const all = sortCardTypes(['Sorcery', 'Creature', 'Land', 'Enchantment', 'Instant']);
  const fewer = sortCardTypes(['Sorcery', 'Creature', 'Instant']);
  assert.deepEqual(fewer, all.filter((t) => fewer.includes(t)));
});

test('unknown types go last, alphabetically, rather than disappearing', () => {
  assert.deepEqual(
    sortCardTypes(['Zebra', 'Creature', 'Aardvark', 'Land']),
    ['Creature', 'Land', 'Aardvark', 'Zebra'],
  );
});

test('sorting does not mutate its input', () => {
  const input = ['Land', 'Creature'];
  sortCardTypes(input);
  assert.deepEqual(input, ['Land', 'Creature']);
});
