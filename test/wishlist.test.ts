import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToWishlist, catalogueName, emptyWishlist, inWishlist, loadWishlist, removeWish,
  resolveWishlist, saveWishlist, wishKey,
} from '../web/wishlist.js';

const card = (name: string, extra: any = {}) => ({
  name, quantity: 2, foil: false, setName: 'Set A', setId: 'aaa',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Artifact', ...extra,
});
const deck = (id: string, cards: any[], extra: any = {}) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, discount: null, updatedAt: null,
  cardCount: cards.reduce((n, c) => n + c.quantity, 0), cards, ...extra,
});
const index = (decks: any[]) => ({ decks, priceSources: [] });

/* ---------------------------------------------------------------- *
 * Identity
 * ---------------------------------------------------------------- */

test('a wishlist line is a name, not a printing in a deck', () => {
  // The whole difference from the cart: you want the card, not a copy in a
  // particular deck, and most of the time no deck has it yet.
  assert.equal(wishKey('Sol Ring'), wishKey('  sol ring  '));
});

test('adding the same card twice leaves one line', () => {
  let w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  w = addToWishlist(w, 'sol ring', '2026-11-20');
  assert.equal(w.length, 1);
  // The second add must not move the date: it is what the arrival check
  // measures against, and refreshing it would erase the wait.
  assert.equal(w[0]!.addedAt, '2026-11-01');
});

test('the typed name is kept, the normalised one is the key', () => {
  const w = addToWishlist(emptyWishlist(), '  Ragavan, Nimble Pilferer ', '2026-11-01');
  assert.equal(w[0]!.name, 'Ragavan, Nimble Pilferer');
  assert.ok(inWishlist(w, 'ragavan, nimble pilferer'));
});

test('a line with no letters or digits is refused', () => {
  for (const junk of ['', '   ', '///', '---']) {
    assert.deepEqual(addToWishlist(emptyWishlist(), junk, '2026-11-01'), []);
  }
});

test('adding does not mutate the list it was given', () => {
  const before = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const after = addToWishlist(before, 'Arcane Signet', '2026-11-02');
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test('a line can be removed by its key', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  assert.deepEqual(removeWish(w, wishKey('Sol Ring')), []);
  assert.equal(removeWish(w, 'nothing').length, 1);
});

/* ---------------------------------------------------------------- *
 * The catalogue's own spelling
 * ---------------------------------------------------------------- */

test('a name typed in any case is stored as the catalogue writes it', () => {
  const idx = index([deck('a', [card('Ragavan, Nimble Pilferer')])]);
  assert.equal(catalogueName(idx, 'ragavan, nimble pilferer'), 'Ragavan, Nimble Pilferer');
  assert.equal(catalogueName(idx, '  RAGAVAN, NIMBLE PILFERER  '), 'Ragavan, Nimble Pilferer');
});

test('a half-typed name is not promoted to the nearest card', () => {
  // A wishlist that quietly swaps in a different card is worse than one
  // showing a typo: the typo is visible and the wrong card is not.
  const idx = index([deck('a', [card('Sol Ring')])]);
  assert.equal(catalogueName(idx, 'sol r'), null);
  assert.equal(catalogueName(idx, 'Sol Ringer'), null);
});

test('a card nobody stocks has no catalogue spelling', () => {
  assert.equal(catalogueName(index([deck('a', [card('Sol Ring')])]), 'Black Lotus'), null);
  assert.equal(catalogueName(null as any, 'Sol Ring'), null);
  assert.equal(catalogueName(index([]), ''), null);
});

/* ---------------------------------------------------------------- *
 * Arrivals -- the point of the thing
 * ---------------------------------------------------------------- */

test('a card that arrived after you asked is an arrival', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring', { firstSeen: '2026-11-14' })])]));

  assert.equal(r.rows[0]!.state, 'arrived');
  assert.equal(r.rows[0]!.arrivedAt, '2026-11-14');
  assert.equal(r.arrived, 1);
});

test('a card already in stock when you asked is not an arrival', () => {
  // Otherwise every card wishlisted from a search result would announce itself
  // as new the moment it was added.
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-14');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring', { firstSeen: '2026-09-30' })])]));

  assert.equal(r.rows[0]!.state, 'stocked');
  assert.equal(r.rows[0]!.arrivedAt, null);
});

test('a card stocked on the very day you asked is not an arrival either', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-14');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring', { firstSeen: '2026-11-14' })])]));
  assert.equal(r.rows[0]!.state, 'stocked');
});

test('a printing with no arrival date cannot claim to have arrived', () => {
  // Cards predating arrival tracking are undated. Reading undated as "new"
  // would announce the whole back catalogue.
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring')])]));
  assert.equal(r.rows[0]!.state, 'stocked');
  assert.equal(r.rows[0]!.arrivedAt, null);
});

test('the newest arrival wins when several printings turned up', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const r = resolveWishlist(w, index([
    deck('a', [card('Sol Ring', { setId: 'aaa', firstSeen: '2026-11-05' })]),
    deck('b', [card('Sol Ring', { setId: 'bbb', firstSeen: '2026-11-20' })]),
  ]));
  assert.equal(r.rows[0]!.arrivedAt, '2026-11-20');
});

test('a card no deck holds is waiting, not missing', () => {
  // The wishlist is the one place that keeps a card the seller does not stock.
  const w = addToWishlist(emptyWishlist(), 'Black Lotus', '2026-11-01');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring')])]));

  assert.equal(r.rows[0]!.state, 'waiting');
  assert.equal(r.rows[0]!.available, 0);
  assert.equal(r.rows[0]!.best, null);
  assert.equal(r.rows[0]!.discount, null);
  assert.equal(r.waiting, 1);
});

/* ---------------------------------------------------------------- *
 * The discount, as it stands right now
 * ---------------------------------------------------------------- */

test('the discount shown is the best on offer now, across every deck', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const r = resolveWishlist(w, index([
    deck('a', [card('Sol Ring')], { discount: 10 }),
    deck('b', [card('Sol Ring')], { discount: 35 }),
    deck('c', [card('Sol Ring')], { discount: null }),
  ]));

  assert.equal(r.rows[0]!.discount, 35);
  assert.equal(r.rows[0]!.best.deckName, 'Deck b');
  // Every deck is kept, so the row can say where else it is.
  assert.equal(r.rows[0]!.sources.length, 3);
  // Copies are counted across all of them, not just the cheapest.
  assert.equal(r.rows[0]!.available, 6);
});

test('no deck offering a discount reads as none, not as zero off', () => {
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  const r = resolveWishlist(w, index([deck('a', [card('Sol Ring')])]));
  assert.equal(r.rows[0]!.discount, null);
});

/* ---------------------------------------------------------------- *
 * Order and totals
 * ---------------------------------------------------------------- */

test('arrivals come first, then stock, then the wait', () => {
  let w = addToWishlist(emptyWishlist(), 'Waiting Card', '2026-11-01');
  w = addToWishlist(w, 'Old Stock', '2026-11-01');
  w = addToWishlist(w, 'Just Arrived', '2026-11-01');

  const r = resolveWishlist(w, index([deck('a', [
    card('Old Stock', { firstSeen: '2026-09-01' }),
    card('Just Arrived', { firstSeen: '2026-11-20' }),
  ])]));

  assert.deepEqual(r.rows.map((x) => x.line.name), ['Just Arrived', 'Old Stock', 'Waiting Card']);
  assert.deepEqual([r.arrived, r.stocked, r.waiting], [1, 1, 1]);
});

test('an empty wishlist resolves to nothing rather than failing', () => {
  for (const input of [[], null, undefined]) {
    const r = resolveWishlist(input as any, index([deck('a', [card('Sol Ring')])]));
    assert.deepEqual(r.rows, []);
    assert.equal(r.arrived, 0);
  }
  // Before the index has loaded, every line simply waits.
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  assert.equal(resolveWishlist(w, null as any).rows[0]!.state, 'waiting');
});

/* ---------------------------------------------------------------- *
 * Storage
 * ---------------------------------------------------------------- */

const fakeStore = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as any;
};

test('a wishlist survives a round trip', () => {
  const store = fakeStore();
  const w = addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01');
  assert.ok(saveWishlist(w, store));
  assert.deepEqual(loadWishlist(store), w);
});

test('an empty wishlist clears the key rather than storing []', () => {
  const store = fakeStore();
  saveWishlist(addToWishlist(emptyWishlist(), 'Sol Ring', '2026-11-01'), store);
  saveWishlist([], store);
  assert.equal(store.getItem('wishlist'), null);
});

test('unreadable storage is an empty wishlist, never a thrown page', () => {
  const store = fakeStore();
  for (const junk of ['not json', '{"not":"an array"}', '42']) {
    store.setItem('wishlist', junk);
    assert.deepEqual(loadWishlist(store), []);
  }
  // Rows missing the fields the page relies on are dropped, not trusted.
  store.setItem('wishlist', JSON.stringify([
    { key: 'ok', name: 'Ok', addedAt: '2026-11-01' }, { key: '' }, null, 7,
  ]));
  assert.equal(loadWishlist(store).length, 1);

  assert.deepEqual(loadWishlist({
    getItem: () => { throw new Error('blocked'); },
  } as any), []);
});
