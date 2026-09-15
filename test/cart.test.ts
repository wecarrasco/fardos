import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToCart, cartCount, cartMessage, emptyCart, lineKey, loadCart,
  removeLine, resolveCart, saveCart, setQuantity, wantedFrom,
} from '../web/cart.js';
import { formatPrice } from '../web/prices.js';

const TCG = { vendor: 'tcgplayer', label: 'TCGplayer', currency: 'USD' };
const CK = { vendor: 'cardKingdom', label: 'Card Kingdom', currency: 'USD' };

const card = (name: string, extra: any = {}) => ({
  name, quantity: 3, foil: false, setName: 'Set A', setId: 'aaa',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Artifact', ...extra,
});
const deck = (id: string, cards: any[], extra: any = {}) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, discount: null, updatedAt: null,
  cardCount: cards.reduce((n, c) => n + c.quantity, 0), cards, ...extra,
});
const index = (decks: any[]) => ({ decks, priceSources: [TCG, CK] });

/* ---------------------------------------------------------------- *
 * Identity
 * ---------------------------------------------------------------- */

test('the deck is part of a line identity', () => {
  // The same Sol Ring in two decks is two different things to buy: different
  // stock, and often a different discount.
  const c = card('Sol Ring');
  assert.notEqual(lineKey('deck-a', c), lineKey('deck-b', c));
});

test('different printings of one card are different lines', () => {
  assert.notEqual(
    lineKey('d', card('Sol Ring', { setId: 'aaa' })),
    lineKey('d', card('Sol Ring', { setId: 'bbb' })),
  );
  assert.notEqual(
    lineKey('d', card('Sol Ring')),
    lineKey('d', card('Sol Ring', { foil: true })),
  );
});

/* ---------------------------------------------------------------- *
 * Adding and adjusting
 * ---------------------------------------------------------------- */

test('adding the same line twice raises the quantity', () => {
  let c = emptyCart();
  c = addToCart(c, 'd', card('Sol Ring'));
  c = addToCart(c, 'd', card('Sol Ring'));
  assert.equal(c.length, 1);
  assert.equal(c[0]!.want, 2);
});

test('you cannot ask for more than the deck holds', () => {
  // The number lands in a message the seller has to fill.
  let c = emptyCart();
  const two = card('Sol Ring', { quantity: 2 });
  c = addToCart(c, 'd', two, 5);
  assert.equal(c[0]!.want, 2);
  c = addToCart(c, 'd', two, 3);
  assert.equal(c[0]!.want, 2);
});

test('a card with no copies cannot be added at all', () => {
  const c = addToCart(emptyCart(), 'd', card('Sol Ring', { quantity: 0 }));
  assert.deepEqual(c, []);
});

test('stepping down to zero removes the line', () => {
  let c = addToCart(emptyCart(), 'd', card('Sol Ring'));
  c = addToCart(c, 'd', card('Sol Ring'), -1);
  assert.deepEqual(c, []);
});

test('adding never mutates the cart it was given', () => {
  const before = addToCart(emptyCart(), 'd', card('Sol Ring'));
  const snapshot = JSON.stringify(before);
  addToCart(before, 'd', card('Sol Ring'));
  assert.equal(JSON.stringify(before), snapshot);
});

test('quantities can be set directly, within the cap', () => {
  let c = addToCart(emptyCart(), 'd', card('Sol Ring'));
  const key = c[0]!.key;
  assert.equal(setQuantity(c, key, 3, 4)[0]!.want, 3);
  assert.equal(setQuantity(c, key, 9, 4)[0]!.want, 4);
  assert.deepEqual(setQuantity(c, key, 0, 4), []);
  assert.deepEqual(setQuantity(c, key, -2, 4), []);
});

test('counting reports copies, not lines', () => {
  let c = addToCart(emptyCart(), 'a', card('Sol Ring'), 2);
  c = addToCart(c, 'b', card('Arcane Signet'), 3);
  assert.equal(c.length, 2);
  assert.equal(cartCount(c), 5);
  assert.equal(cartCount([]), 0);
  assert.equal(cartCount(null as any), 0);
});

test('a line reports how many of it are already carted', () => {
  const c = addToCart(emptyCart(), 'd', card('Sol Ring'), 2);
  assert.equal(wantedFrom(c, 'd', card('Sol Ring')), 2);
  assert.equal(wantedFrom(c, 'other', card('Sol Ring')), 0);
  assert.equal(wantedFrom(c, 'd', card('Something Else')), 0);
});

/* ---------------------------------------------------------------- *
 * Reconciling against the catalogue
 * ---------------------------------------------------------------- */

test('lines are grouped by deck, with the deck carried through', () => {
  const idx = index([deck('a', [card('Sol Ring')], { discount: 20 })]);
  const c = addToCart(emptyCart(), 'a', card('Sol Ring'), 2);
  const r = resolveCart(c, idx);

  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0]!.deckName, 'Deck a');
  assert.equal(r.groups[0]!.discount, 20);
  assert.equal(r.copies, 2);
  assert.equal(r.deckCount, 1);
});

test('a card that has left the deck is reported, not dropped', () => {
  // A list that shrinks by itself between visits is a list nobody can trust.
  const c = addToCart(emptyCart(), 'a', card('Sol Ring'));
  const r = resolveCart(c, index([deck('a', [card('Arcane Signet')])]));

  assert.equal(r.groups.length, 0);
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0]!.line.name, 'Sol Ring');
});

test('a deck that has left the catalogue is reported too', () => {
  const c = addToCart(emptyCart(), 'gone', card('Sol Ring'));
  const r = resolveCart(c, index([deck('a', [card('Sol Ring')])]));
  assert.equal(r.unavailable.length, 1);
});

test('a thinned deck is flagged and the total follows the stock', () => {
  const c = addToCart(emptyCart(), 'a', card('Sol Ring', { quantity: 4 }), 4);
  const r = resolveCart(c, index([deck('a', [card('Sol Ring', { quantity: 1 })])]));

  assert.equal(r.shortfalls.length, 1);
  assert.equal(r.shortfalls[0]!.want, 4);
  assert.equal(r.shortfalls[0]!.available, 1);
  // Counted as the one that can actually be supplied.
  assert.equal(r.copies, 1);
  assert.equal(r.supplied[0]!.quantity, 1);
});

test('an empty cart resolves to nothing rather than failing', () => {
  for (const input of [[], null, undefined]) {
    const r = resolveCart(input as any, index([deck('a', [card('X')])]));
    assert.deepEqual(r.groups, []);
    assert.equal(r.copies, 0);
  }
  assert.deepEqual(resolveCart([], null).groups, []);
});

/* ---------------------------------------------------------------- *
 * The message
 * ---------------------------------------------------------------- */

const twoDeckCart = () => {
  let c = addToCart(emptyCart(), 'a', card('Sol Ring', { prices: { tcgplayer: 2.5, cardKingdom: 4 } }), 2);
  c = addToCart(c, 'b', card('Lightning Bolt', { setId: 'm11', collectorNumber: '149' }));
  return c;
};
const twoDeckIndex = () => index([
  deck('a', [card('Sol Ring', { prices: { tcgplayer: 2.5, cardKingdom: 4 } })], { discount: 20 }),
  deck('b', [card('Lightning Bolt', { setId: 'm11', collectorNumber: '149' })]),
]);

test('the message groups by deck, the way the stock is organised', () => {
  const text = cartMessage(resolveCart(twoDeckCart(), twoDeckIndex()));
  assert.match(text, /Deck a \(20% off\)/);
  assert.match(text, /2x Sol Ring/);
  assert.match(text, /Deck b/);
  assert.match(text, /1x Lightning Bolt \(M11\) #149/);
  assert.match(text, /3 cards from 2 decks/);
  // The deck heading comes before its own cards.
  assert.ok(text.indexOf('Deck a') < text.indexOf('2x Sol Ring'));
});

test('the message carries no prices by default', () => {
  // It is a request, not an offer: a column of third-party figures beside it
  // would read as telling the seller what they charge.
  const text = cartMessage(resolveCart(twoDeckCart(), twoDeckIndex()));
  assert.ok(!text.includes('$'));
  assert.ok(!/TCGplayer/.test(text));
});

test('prices can be included, and say what they are', () => {
  const text = cartMessage(resolveCart(twoDeckCart(), twoDeckIndex()),
    { includePrices: true, sources: [TCG, CK], formatPrice });
  // Two copies at $2.50 is $5.00: the figure is for the quantity asked for.
  assert.match(text, /\$5\.00 TCGplayer/);
  assert.match(text, /\$8\.00 Card Kingdom/);
  assert.match(text, /not your prices/);
});

test('the message asks only for what is there', () => {
  const c = addToCart(emptyCart(), 'a', card('Sol Ring', { quantity: 4 }), 4);
  const text = cartMessage(resolveCart(c, index([deck('a', [card('Sol Ring', { quantity: 1 })])])));
  assert.match(text, /1x Sol Ring/);
  assert.ok(!text.includes('4x'));
});

test('a foil is named as one', () => {
  const c = addToCart(emptyCart(), 'a', card('Sol Ring', { foil: true }));
  const text = cartMessage(resolveCart(c, index([deck('a', [card('Sol Ring', { foil: true })])])));
  assert.match(text, /\[foil\]/);
});

test('an empty cart produces no message at all', () => {
  assert.equal(cartMessage(resolveCart([], index([]))), '');
  assert.equal(cartMessage(null as any), '');
});

/* ---------------------------------------------------------------- *
 * Storage
 * ---------------------------------------------------------------- */

const fakeStore = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  } as any;
};

test('a cart survives a round trip', () => {
  const store = fakeStore();
  const c = addToCart(emptyCart(), 'a', card('Sol Ring'), 2);
  assert.equal(saveCart(c, store), true);
  assert.deepEqual(loadCart(store), c);
});

test('saving an empty cart clears the entry rather than storing "[]"', () => {
  const store = fakeStore({ cart: '[{"key":"x","deckId":"a","printing":"p","want":1,"name":"N"}]' });
  saveCart([], store);
  assert.equal(store.getItem('cart'), null);
});

test('unreadable storage yields an empty cart, never an exception', () => {
  // A corrupt entry must not stop the whole page from loading.
  for (const bad of ['not json', '{"not":"an array"}', '42', '']) {
    assert.deepEqual(loadCart(fakeStore({ cart: bad })), []);
  }
  const throws = { getItem() { throw new Error('blocked'); } } as any;
  assert.deepEqual(loadCart(throws), []);
});

test('malformed lines are discarded, sound ones kept', () => {
  const store = fakeStore({
    cart: JSON.stringify([
      { key: 'ok', deckId: 'a', printing: 'p', want: 2, name: 'Good' },
      { key: 'no-want', deckId: 'a', printing: 'p' },
      { key: 'zero', deckId: 'a', printing: 'p', want: 0, name: 'X' },
      null,
    ]),
  });
  const loaded = loadCart(store);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.name, 'Good');
});

test('storage refusing to write is reported, not thrown', () => {
  // Private mode, or a full quota.
  const store = { setItem() { throw new Error('quota'); }, removeItem() {} } as any;
  assert.equal(saveCart([{ key: 'k', deckId: 'd', printing: 'p', want: 1, name: 'N' }], store), false);
});

test('a removed line is gone and the rest are untouched', () => {
  let c = addToCart(emptyCart(), 'a', card('Sol Ring'));
  c = addToCart(c, 'b', card('Arcane Signet'));
  const out = removeLine(c, c[0]!.key);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, 'Arcane Signet');
});
