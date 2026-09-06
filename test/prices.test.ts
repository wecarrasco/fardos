import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, referenceTotal, describeTotal } from '../web/prices.js';
import { parseDeckPage, PRICE_VENDORS } from '../src/scrapers/manabox.js';
import { readFixture, FIXTURES } from './fixture-manifest.js';

const USD = { vendor: 'tcgplayer', label: 'TCGplayer', currency: 'USD' };
const EUR = { vendor: 'cardmarket', label: 'Cardmarket', currency: 'EUR' };
const card = (price?: number, quantity = 1) => ({ name: 'X', quantity, ...(price === undefined ? {} : { price }) });

/* ---------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------- */

test('formats an amount in the vendor currency', () => {
  assert.match(formatPrice(12.61, USD)!, /12\.61/);
  assert.match(formatPrice(12.61, EUR)!, /12[.,]61/);
});

test('nothing to show yields null rather than a zero', () => {
  // A missing price must not render as "$0.00", which reads as free.
  for (const bad of [undefined, null, NaN, Infinity, -1]) {
    assert.equal(formatPrice(bad as any, USD), null);
  }
});

test('zero is a real price and is shown', () => {
  assert.ok(formatPrice(0, USD));
});

test('an unknown currency degrades instead of blanking the page', () => {
  const out = formatPrice(5, { vendor: 'x', label: 'X', currency: 'NOTACURRENCY' });
  assert.match(out!, /5\.00 NOTACURRENCY/);
});

/* ---------------------------------------------------------------- *
 * Totals
 * ---------------------------------------------------------------- */

test('totals multiply by quantity', () => {
  assert.deepEqual(referenceTotal([card(2.5, 4), card(1, 2)]),
    { total: 12, priced: 2, unpriced: 0 });
});

test('unpriced cards are reported, not counted as zero', () => {
  // Counting them as zero would present a partial total as if complete.
  const t = referenceTotal([card(10, 1), card(undefined, 5), card(undefined, 1)]);
  assert.equal(t.total, 10);
  assert.equal(t.priced, 1);
  assert.equal(t.unpriced, 2);
});

test('an empty or missing list totals to nothing', () => {
  for (const input of [[], null, undefined]) {
    assert.deepEqual(referenceTotal(input as any), { total: 0, priced: 0, unpriced: 0 });
  }
});

test('totals round to cents rather than drifting', () => {
  assert.equal(referenceTotal([card(0.1, 3)]).total, 0.3);
});

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

test('a total always names the vendor it came from', () => {
  // The number must never stand alone; it is not this shop's price.
  const text = describeTotal([card(10, 2)], USD)!;
  assert.match(text, /TCGplayer/);
  assert.match(text, /20\.00/);
});

test('a total says how many cards it could not price', () => {
  assert.match(describeTotal([card(10), card(undefined)], USD)!, /1 unpriced/);
  assert.ok(!describeTotal([card(10)], USD)!.includes('unpriced'));
});

test('nothing priced yields no total at all', () => {
  assert.equal(describeTotal([card(undefined), card(undefined)], USD), null);
  assert.equal(describeTotal([], USD), null);
});

/* ---------------------------------------------------------------- *
 * Parsing, against a saved page
 * ---------------------------------------------------------------- */

test('prices are read from the deck payload', () => {
  const deck = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId, 'tcgplayer');
  const priced = deck.cards.filter((c) => typeof c.price === 'number');

  assert.ok(priced.length > 0, 'the saved page should carry prices');
  assert.ok(priced.every((c) => c.price! > 0));
  // Rounded to cents. Compared as strings, because 12.61 * 100 is not exactly
  // 1261 in binary floating point and the naive check fails on valid input.
  assert.ok(priced.every((c) => /^\d+(\.\d{1,2})?$/.test(String(c.price))),
    'prices should carry at most two decimals: ' +
    priced.filter((c) => !/^\d+(\.\d{1,2})?$/.test(String(c.price))).slice(0, 3)
      .map((c) => `${c.name}=${c.price}`).join(', '));
});

test('choosing another vendor changes the figures', () => {
  const tcg = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId, 'tcgplayer');
  const cm = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId, 'cardmarket');

  const differs = tcg.cards.some((c, i) => c.price !== cm.cards[i]!.price);
  assert.ok(differs, 'two vendors should not agree on every card');
});

test('a card the vendor does not list has no price, not a zero', () => {
  const deck = parseDeckPage(readFixture(FIXTURES.tokens.file), FIXTURES.tokens.deckId, 'tcgplayer');
  const unpriced = deck.cards.filter((c) => c.price === null);
  assert.ok(unpriced.length > 0, 'tokens are largely unpriced');
  assert.ok(deck.cards.every((c) => c.price === null || c.price > 0));
});

test('the DOM fallback yields no prices rather than wrong ones', () => {
  const html = readFixture(FIXTURES.mixed.file).replace(/props="[^"]*"/g, 'props=""');
  const deck = parseDeckPage(html, FIXTURES.mixed.deckId, 'tcgplayer');
  assert.ok(deck.cards.length > 0);
  assert.ok(deck.cards.every((c) => c.price === null));
});

test('cardhoarder is not offered as a vendor', () => {
  // It quotes MTGO event tickets, which would render as if it were money.
  assert.ok(!('cardhoarder' in PRICE_VENDORS));
  assert.equal(PRICE_VENDORS.tcgplayer.currency, 'USD');
  assert.equal(PRICE_VENDORS.cardmarket.currency, 'EUR');
});
