import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPrice, formatPrice, referenceTotal, describeTotals } from '../web/prices.js';
import { parseDeckPage, PRICE_VENDORS } from '../src/scrapers/manabox.js';
import { readFixture, FIXTURES } from './fixture-manifest.js';

const USD = { vendor: 'tcgplayer', label: 'TCGplayer', currency: 'USD' };
const CK = { vendor: 'cardKingdom', label: 'Card Kingdom', currency: 'USD' };
const EUR = { vendor: 'cardmarket', label: 'Cardmarket', currency: 'EUR' };

/** A card priced by whichever vendors are named. */
const card = (prices: Record<string, number>, quantity = 1) => ({ name: 'X', quantity, prices });
const tcg = (price?: number, quantity = 1) =>
  card(price === undefined ? {} : { tcgplayer: price }, quantity);

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
 * Reading one vendor's price
 * ---------------------------------------------------------------- */

test('each vendor is read independently', () => {
  const c = card({ tcgplayer: 1.5, cardKingdom: 4 });
  assert.equal(cardPrice(c, USD), 1.5);
  assert.equal(cardPrice(c, CK), 4);
});

test('a vendor that does not list the card yields null', () => {
  // Coverage differs between vendors, so this is the normal case, not an error.
  const c = card({ cardKingdom: 4 });
  assert.equal(cardPrice(c, USD), null);
  assert.equal(cardPrice(c, CK), 4);
});

test('a card with no prices at all is handled', () => {
  for (const bad of [{ name: 'X', quantity: 1 }, null, undefined]) {
    assert.equal(cardPrice(bad as any, USD), null);
  }
});

/* ---------------------------------------------------------------- *
 * Totals
 * ---------------------------------------------------------------- */

test('totals multiply by quantity', () => {
  assert.deepEqual(referenceTotal([tcg(2.5, 4), tcg(1, 2)], USD),
    { total: 12, priced: 2, unpriced: 0 });
});

test('totals are per vendor, not shared', () => {
  const cards = [card({ tcgplayer: 1, cardKingdom: 3 }, 2)];
  assert.equal(referenceTotal(cards, USD).total, 2);
  assert.equal(referenceTotal(cards, CK).total, 6);
});

test('unpriced cards are reported, not counted as zero', () => {
  // Counting them as zero would present a partial total as if complete.
  const t = referenceTotal([tcg(10, 1), tcg(undefined, 5), tcg(undefined, 1)], USD);
  assert.equal(t.total, 10);
  assert.equal(t.priced, 1);
  assert.equal(t.unpriced, 2);
});

test('an empty or missing list totals to nothing', () => {
  for (const input of [[], null, undefined]) {
    assert.deepEqual(referenceTotal(input as any, USD), { total: 0, priced: 0, unpriced: 0 });
  }
});

test('totals round to cents rather than drifting', () => {
  assert.equal(referenceTotal([tcg(0.1, 3)], USD).total, 0.3);
});

/* ---------------------------------------------------------------- *
 * Wording
 * ---------------------------------------------------------------- */

test('a total names every vendor it came from', () => {
  // No number may stand alone; none of them is this shop's price.
  const text = describeTotals([card({ tcgplayer: 10, cardKingdom: 25 }, 2)], [USD, CK])!;
  assert.match(text, /TCGplayer/);
  assert.match(text, /Card Kingdom/);
  assert.match(text, /20\.00/);
  assert.match(text, /50\.00/);
});

test('vendors appear in the order they were published', () => {
  const cards = [card({ tcgplayer: 1, cardKingdom: 2 })];
  assert.ok(describeTotals(cards, [USD, CK])!.indexOf('TCGplayer') <
            describeTotals(cards, [USD, CK])!.indexOf('Card Kingdom'));
  assert.ok(describeTotals(cards, [CK, USD])!.indexOf('Card Kingdom') <
            describeTotals(cards, [CK, USD])!.indexOf('TCGplayer'));
});

test('an identical gap is stated once, not repeated per vendor', () => {
  const cards = [card({ tcgplayer: 10, cardKingdom: 20 }), card({})];
  const text = describeTotals(cards, [USD, CK])!;
  assert.equal(text.match(/unpriced/g)!.length, 1);
  assert.match(text, /1 unpriced/);
});

test('gaps that differ are stated per vendor', () => {
  // Card Kingdom prices a card TCGplayer skips, so one total is more complete
  // than the other and saying "1 unpriced" once would misdescribe both.
  const cards = [card({ tcgplayer: 10, cardKingdom: 20 }), card({ cardKingdom: 5 })];
  const text = describeTotals(cards, [USD, CK])!;
  assert.match(text, /TCGplayer \(1 unpriced\)/);
  assert.ok(!/Card Kingdom \(\d+ unpriced\)/.test(text));
});

test('a vendor with nothing priced is dropped rather than shown empty', () => {
  const text = describeTotals([card({ cardKingdom: 5 })], [USD, CK])!;
  assert.ok(!text.includes('TCGplayer'));
  assert.match(text, /Card Kingdom/);
});

test('nothing priced yields no total at all', () => {
  assert.equal(describeTotals([card({}), card({})], [USD, CK]), null);
  assert.equal(describeTotals([], [USD]), null);
  assert.equal(describeTotals([tcg(5)], []), null);
});

/* ---------------------------------------------------------------- *
 * Parsing, against a saved page
 * ---------------------------------------------------------------- */

test('prices are read from the deck payload', () => {
  const deck = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId, ['tcgplayer']);
  const priced = deck.cards.filter((c) => typeof c.prices.tcgplayer === 'number');

  assert.ok(priced.length > 0, 'the saved page should carry prices');
  assert.ok(priced.every((c) => c.prices.tcgplayer! > 0));
  // Rounded to cents. Compared as strings, because 12.61 * 100 is not exactly
  // 1261 in binary floating point and the naive check fails on valid input.
  const cents = (c: { prices: { tcgplayer?: number } }) =>
    /^\d+(\.\d{1,2})?$/.test(String(c.prices.tcgplayer));
  assert.ok(priced.every(cents),
    'prices should carry at most two decimals: ' +
    priced.filter((c) => !cents(c)).slice(0, 3)
      .map((c) => `${c.name}=${c.prices.tcgplayer}`).join(', '));
});

test('several vendors are read in one pass', () => {
  const deck = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId,
    ['tcgplayer', 'cardKingdom']);
  const both = deck.cards.filter((c) => c.prices.tcgplayer != null && c.prices.cardKingdom != null);

  assert.ok(both.length > 0, 'the saved page should carry both vendors');
  assert.ok(both.some((c) => c.prices.tcgplayer !== c.prices.cardKingdom),
    'two vendors should not agree on every card');
});

test('only the vendors asked for are stored', () => {
  // Publishing an unrequested vendor would quietly grow the index.
  const deck = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId, ['cardmarket']);
  assert.ok(deck.cards.every((c) => Object.keys(c.prices).every((k) => k === 'cardmarket')));
  assert.ok(deck.cards.some((c) => c.prices.cardmarket != null));
});

test('a card the vendor does not list has no key, not a zero', () => {
  const deck = parseDeckPage(readFixture(FIXTURES.tokens.file), FIXTURES.tokens.deckId, ['tcgplayer']);
  const unpriced = deck.cards.filter((c) => c.prices.tcgplayer === undefined);
  assert.ok(unpriced.length > 0, 'tokens are largely unpriced');
  assert.ok(deck.cards.every((c) => c.prices.tcgplayer === undefined || c.prices.tcgplayer > 0));
});

test('the DOM fallback yields no prices rather than wrong ones', () => {
  const html = readFixture(FIXTURES.mixed.file).replace(/props="[^"]*"/g, 'props=""');
  const deck = parseDeckPage(html, FIXTURES.mixed.deckId, ['tcgplayer', 'cardKingdom']);
  assert.ok(deck.cards.length > 0);
  assert.ok(deck.cards.every((c) => Object.keys(c.prices).length === 0));
});

test('cardhoarder is not offered as a vendor', () => {
  // It quotes MTGO event tickets, which would render as if it were money.
  assert.ok(!('cardhoarder' in PRICE_VENDORS));
  assert.equal(PRICE_VENDORS.tcgplayer.currency, 'USD');
  assert.equal(PRICE_VENDORS.cardmarket.currency, 'EUR');
});
