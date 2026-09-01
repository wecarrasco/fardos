import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscount, deckDiscount, parseLinktree } from '../src/scrapers/linktree.js';
import { betterDealFor, otherDecksWithCard, categoryLabel } from '../web/cards.js';
import { readFixture, LINKTREE_FIXTURE } from './fixture-manifest.js';

/* ---------------------------------------------------------------- *
 * Reading the percentage out of the seller's own wording
 * ---------------------------------------------------------------- */

test('reads the discount from the wordings the seller actually uses', () => {
  assert.equal(parseDiscount('MARVEL — 10% OFF'), 10);
  assert.equal(parseDiscount('LINKS 20% de DESCUENTO'), 20);
  assert.equal(parseDiscount('LINKS CLÁSICOS DE SAF 📎 (30% OFF)'), 30);
  assert.equal(parseDiscount('SAF STANDARD 🎲 (20% OFF)'), 20);
  assert.equal(parseDiscount('The Hobbit/Commons (20% OFF) 🪨'), 20);
});

test('tolerates spacing and ignores text without a percentage', () => {
  assert.equal(parseDiscount('5 % off'), 5);
  assert.equal(parseDiscount('Sol Ring'), null);
  assert.equal(parseDiscount(''), null);
  assert.equal(parseDiscount(null), null);
  assert.equal(parseDiscount(undefined), null);
});

test('rejects percentages that cannot be a discount', () => {
  // "100% legit" is marketing copy, not a giveaway.
  assert.equal(parseDiscount('100% legit'), null);
  assert.equal(parseDiscount('0% off'), null);
});

/* ---------------------------------------------------------------- *
 * Which discount applies to a deck
 * ---------------------------------------------------------------- */

test("a deck's own label beats its section heading", () => {
  // The real case: these sit under a heading that says 10% OFF.
  assert.equal(
    deckDiscount({ linkText: 'MARVEL : COMMONS (20% OFF) ⚡', category: 'MARVEL — 10% OFF' }),
    20,
  );
});

test('the section applies when the deck says nothing', () => {
  assert.equal(deckDiscount({ linkText: 'Doom Prevails 😈', category: 'MARVEL — 10% OFF' }), 10);
});

test('a deck with neither has no discount', () => {
  assert.equal(deckDiscount({ linkText: 'SAF/ON THE ROAD 🛣️', category: null }), null);
});

test('an ungrouped deck can still state its own discount', () => {
  assert.equal(deckDiscount({ linkText: 'The Hobbit/Commons (20% OFF) 🪨', category: null }), 20);
});

test('every deck on the real page resolves to a sane discount', () => {
  const links = parseLinktree(readFixture(LINKTREE_FIXTURE));
  const values = links.map(deckDiscount);

  assert.equal(values.length, 63);
  for (const v of values) {
    assert.ok(v === null || (v > 0 && v < 100), `unexpected discount ${v}`);
  }
  // The four decks that override their section must not be flattened to it.
  const overrides = links.filter((l) => parseDiscount(l.linkText) !== null);
  assert.equal(overrides.length, 4);
  for (const l of overrides) assert.equal(deckDiscount(l), parseDiscount(l.linkText));
});

/* ---------------------------------------------------------------- *
 * Finding the cheaper copy
 * ---------------------------------------------------------------- */

const card = (name: string, extra: any = {}) => ({
  name, quantity: 2, foil: false, setName: 'Set', setId: 'set',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature', ...extra,
});
const deck = (id: string, discount: number | null, cards: any[]) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, discount, updatedAt: null, cardCount: 0, cards,
});

test('finds the same printing at a bigger discount', () => {
  const index = { decks: [deck('a', 10, [card('Daredevil')]), deck('b', 30, [card('Daredevil')])] };
  const better = betterDealFor(index, card('Daredevil'), { id: 'a', discount: 10 });
  assert.equal(better?.deckId, 'b');
  assert.equal(better?.discount, 30);
});

test('says nothing when the current deck is already the best', () => {
  const index = { decks: [deck('a', 30, [card('X')]), deck('b', 10, [card('X')])] };
  assert.equal(betterDealFor(index, card('X'), { id: 'a', discount: 30 }), null);
});

test('an equal discount is not a better deal', () => {
  const index = { decks: [deck('a', 20, [card('X')]), deck('b', 20, [card('X')])] };
  assert.equal(betterDealFor(index, card('X'), { id: 'a', discount: 20 }), null);
});

test('a discounted deck beats one with no discount at all', () => {
  const index = { decks: [deck('a', null, [card('X')]), deck('b', 20, [card('X')])] };
  assert.equal(betterDealFor(index, card('X'), { id: 'a', discount: null })?.discount, 20);
});

test('a different printing is not the same deal', () => {
  // Someone after this exact card is not served by another set at a discount.
  const index = {
    decks: [deck('a', 10, [card('X', { setId: 'aaa' })]), deck('b', 30, [card('X', { setId: 'bbb' })])],
  };
  assert.equal(betterDealFor(index, card('X', { setId: 'aaa' }), { id: 'a', discount: 10 }), null);
});

test('the best of several cheaper options is offered', () => {
  const index = {
    decks: [deck('a', 10, [card('X')]), deck('b', 20, [card('X')]), deck('c', 30, [card('X')])],
  };
  assert.equal(betterDealFor(index, card('X'), { id: 'a', discount: 10 })?.deckId, 'c');
});

test('the other-decks list is ordered by discount, best first', () => {
  const index = {
    decks: [deck('a', 0, [card('X')]), deck('b', 10, [card('X')]),
            deck('c', 30, [card('X')]), deck('d', 20, [card('X')])],
  };
  assert.deepEqual(
    otherDecksWithCard(index, card('X'), 'a').map((o) => o.discount),
    [30, 20, 10],
  );
});

/* ---------------------------------------------------------------- *
 * Section labels
 * ---------------------------------------------------------------- */

test('the discount phrase is stripped from a section label', () => {
  // The percentage gets its own badge, so repeating it in the chip is noise.
  assert.equal(categoryLabel('MARVEL — 10% OFF'), 'MARVEL');
  assert.equal(categoryLabel('LINKS CLÁSICOS DE SAF 📎 (20% OFF)'), 'LINKS CLÁSICOS DE SAF 📎');
  assert.equal(categoryLabel('SAF STANDARD 🎲 (10% OFF)'), 'SAF STANDARD 🎲');
  assert.equal(categoryLabel('LINKS 10% de DESCUENTO'), 'LINKS');
});

test('a label without a discount is left alone', () => {
  assert.equal(categoryLabel('Just A Section'), 'Just A Section');
  assert.equal(categoryLabel(null), null);
});

test('a label that is only a discount keeps its original text', () => {
  // Stripping would leave nothing, and an empty chip is worse than a redundant one.
  assert.equal(categoryLabel('30% OFF'), '30% OFF');
  assert.equal(categoryLabel('(20% OFF)'), '(20% OFF)');
});
