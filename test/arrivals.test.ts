import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newArrivals, arrivalCutoff, isNewCard } from '../web/arrivals.js';

const dayOffset = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const today = dayOffset(0);
const threeDaysAgo = dayOffset(-3);
const twentyDaysAgo = dayOffset(-20);

const card = (name: string, firstSeen?: string, extra: Record<string, unknown> = {}) => ({
  name, quantity: 2, foil: false, setName: 'Set', setId: 'set',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature',
  ...(firstSeen ? { firstSeen } : {}),
  ...extra,
});

const index = (decks: any[], previousGeneratedAt?: string) => ({
  generatedAt: new Date().toISOString(),
  previousGeneratedAt: previousGeneratedAt ?? null,
  decks,
});

const deck = (id: string, cards: any[]) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, updatedAt: new Date().toISOString(), cardCount: 0, cards,
});

/* ---------------------------------------------------------------- *
 * What counts as new
 * ---------------------------------------------------------------- */

test('cards inside the window are new, older ones are not', () => {
  const i = index([deck('a', [
    card('Fresh', today),
    card('Recent', threeDaysAgo, { collectorNumber: '2' }),
    card('Stale', twentyDaysAgo, { collectorNumber: '3' }),
  ])]);

  const r = newArrivals(i, { days: 7 });
  assert.deepEqual(r.decks[0]!.cards.map((c) => c.name), ['Fresh', 'Recent']);
  assert.equal(r.printingCount, 2);
  assert.equal(r.totalCopies, 4);
});

test('cards with no arrival date are never new', () => {
  // Everything in stock before tracking began is undated -- "unknown", not "new".
  const i = index([deck('a', [card('Untracked'), card('Also Untracked', undefined, { collectorNumber: '2' })])]);
  const r = newArrivals(i, { days: 3650 });
  assert.deepEqual(r.decks, []);
  assert.equal(r.hitCount, 0);
});

test('a first build marks nothing as new', () => {
  // The regression this guards: dating every card on the first run would
  // announce the entire 8,000-card catalogue as arrivals.
  const all = Array.from({ length: 50 }, (_, n) => card(`Card ${n}`, undefined, { collectorNumber: String(n) }));
  assert.equal(newArrivals(index([deck('a', all)]), { days: 30 }).hitCount, 0);
});

test('the window boundary is inclusive', () => {
  const i = index([deck('a', [card('Edge', dayOffset(-7))])]);
  assert.equal(newArrivals(i, { days: 7 }).hitCount, 1);
  assert.equal(newArrivals(i, { days: 6 }).hitCount, 0);
});

/* ---------------------------------------------------------------- *
 * Since the last update
 * ---------------------------------------------------------------- */

test('"since last update" uses the previous build date', () => {
  const i = index(
    [deck('a', [card('After', today), card('Before', twentyDaysAgo, { collectorNumber: '2' })])],
    new Date(Date.now() - 86400000).toISOString(),
  );
  const r = newArrivals(i, { sinceLastUpdate: true });
  assert.deepEqual(r.decks[0]!.cards.map((c) => c.name), ['After']);
});

test('"since last update" is unavailable on the first published build', () => {
  const i = index([deck('a', [card('Fresh', today)])]);   // previousGeneratedAt null
  const r = newArrivals(i, { sinceLastUpdate: true });
  assert.equal(r.cutoff, null, 'the UI uses this to offer a longer window instead');
  assert.deepEqual(r.decks, []);
});

/* ---------------------------------------------------------------- *
 * Grouping and ordering
 * ---------------------------------------------------------------- */

test('groups by deck, freshest deck first', () => {
  const i = index([
    deck('old', [card('Older', dayOffset(-5))]),
    deck('new', [card('Newer', today, { collectorNumber: '2' })]),
  ]);
  assert.deepEqual(newArrivals(i, { days: 7 }).decks.map((d) => d.deckId), ['new', 'old']);
});

test('within a deck, newest cards come first', () => {
  const i = index([deck('a', [
    card('Older', dayOffset(-5)),
    card('Newest', today, { collectorNumber: '2' }),
    card('Middle', dayOffset(-2), { collectorNumber: '3' }),
  ])]);
  assert.deepEqual(
    newArrivals(i, { days: 7 }).decks[0]!.cards.map((c) => c.name),
    ['Newest', 'Middle', 'Older'],
  );
});

test('the same printing in two decks counts once but shows in both', () => {
  const same = () => card('Shared', today);
  const r = newArrivals(index([deck('a', [same()]), deck('b', [same()])]), { days: 7 });
  assert.equal(r.printingCount, 1, 'one new card...');
  assert.equal(r.deckCount, 2, '...listed under both decks');
  assert.equal(r.totalCopies, 4);
});

test('foil and non-foil of one card are separate printings', () => {
  const r = newArrivals(index([deck('a', [
    card('Dual', today),
    card('Dual', today, { foil: true }),
  ])]), { days: 7 });
  assert.equal(r.printingCount, 2);
});

test('decks with nothing new are omitted entirely', () => {
  const i = index([
    deck('quiet', [card('Old', twentyDaysAgo)]),
    deck('busy', [card('New', today, { collectorNumber: '2' })]),
  ]);
  assert.deepEqual(newArrivals(i, { days: 7 }).decks.map((d) => d.deckId), ['busy']);
});

/* ---------------------------------------------------------------- *
 * Helpers and edge cases
 * ---------------------------------------------------------------- */

test('isNewCard needs both a cutoff and a date', () => {
  assert.equal(isNewCard(card('x', today), today), true);
  assert.equal(isNewCard(card('x'), today), false, 'no arrival date');
  assert.equal(isNewCard(card('x', today), null), false, 'no cutoff');
  assert.equal(isNewCard(card('x', twentyDaysAgo), today), false);
});

test('arrivalCutoff returns a plain date', () => {
  assert.match(arrivalCutoff(index([]), { days: 7 })!, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(arrivalCutoff(index([]), { sinceLastUpdate: true }), null);
  assert.equal(
    arrivalCutoff(index([], '2026-08-20T10:00:00.000Z'), { sinceLastUpdate: true }),
    '2026-08-20',
  );
});

test('a missing or empty index does not throw', () => {
  for (const i of [null, undefined, {}, { decks: [] }]) {
    const r = newArrivals(i as any, { days: 7 });
    assert.deepEqual(r.decks, []);
    assert.equal(r.hitCount, 0);
  }
});

test('the limit caps results without corrupting the counts', () => {
  const many = Array.from({ length: 40 }, (_, n) => card(`C${n}`, today, { collectorNumber: String(n) }));
  const r = newArrivals(index([deck('a', many)]), { days: 7, limit: 10 });
  assert.equal(r.decks[0]!.cards.length, 10);
});
