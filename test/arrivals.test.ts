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

const index = (decks: any[], lastUpdatePrintings?: string[]) => ({
  generatedAt: new Date().toISOString(),
  previousGeneratedAt: new Date(Date.now() - 43200000).toISOString(),
  ...(lastUpdatePrintings ? { lastUpdate: { newPrintings: lastUpdatePrintings } } : {}),
  decks,
});

/** Matches the key the build script writes. */
const key = (name: string, cn = '1', foil = false) => `${name}|set|${cn}|${foil ? 'F' : ''}`;

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

test('"since last update" lists exactly what the latest build added', () => {
  const i = index(
    [deck('a', [card('After', today), card('Before', twentyDaysAgo, { collectorNumber: '2' })])],
    [key('After')],
  );
  assert.deepEqual(newArrivals(i, { sinceLastUpdate: true }).decks[0]!.cards.map((c) => c.name),
    ['After']);
});

test('a quiet update empties "since last update" but not the day ranges', () => {
  // The morning build added two cards; the evening build added none. Both are
  // stamped today, so a date comparison would wrongly still show them here.
  const decks = [deck('a', [
    card('Morning A', today),
    card('Morning B', today, { collectorNumber: '2' }),
    card('Ancient', twentyDaysAgo, { collectorNumber: '3' }),
  ])];
  const afterQuietBuild = index(decks, []);   // this build added nothing

  assert.equal(newArrivals(afterQuietBuild, { sinceLastUpdate: true }).printingCount, 0,
    'the latest update genuinely added nothing');
  assert.equal(newArrivals(afterQuietBuild, { days: 7 }).printingCount, 2,
    'but the morning arrivals are still recent');
});

test('two builds on one day do not bleed into each other', () => {
  const decks = [deck('a', [card('Morning', today), card('Evening', today, { collectorNumber: '2' })])];
  const eveningBuild = index(decks, [key('Evening', '2')]);

  assert.deepEqual(
    newArrivals(eveningBuild, { sinceLastUpdate: true }).decks[0]!.cards.map((c) => c.name),
    ['Evening'],
    'same-day arrivals must be separable by build, not just by date',
  );
});

test('"since last update" is unavailable on an index that predates the field', () => {
  const i = index([deck('a', [card('Fresh', today)])]);   // no lastUpdate key
  const r = newArrivals(i, { sinceLastUpdate: true });
  assert.equal(r.available, false, 'the UI tells the reader to update rather than showing zero');
  assert.deepEqual(r.decks, []);
});

test('day ranges stay available on any index', () => {
  assert.equal(newArrivals(index([deck('a', [card('Fresh', today)])]), { days: 7 }).available, true);
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

test('a sold-out arrival is not listed, since it cannot be bought', () => {
  // The index only ever describes current stock, so a card added in the morning
  // and sold by evening simply is not there any more.
  const afterTheSale = index([deck('a', [card('Still Here', today)])], []);
  const r = newArrivals(afterTheSale, { days: 7 });
  assert.deepEqual(r.decks[0]!.cards.map((c) => c.name), ['Still Here']);
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

test('arrivalCutoff is a date for day ranges and null for the build window', () => {
  assert.match(arrivalCutoff(index([]), { days: 7 })!, /^\d{4}-\d{2}-\d{2}$/);
  // "The last update" is a specific build, not a date, so there is no cutoff.
  assert.equal(arrivalCutoff(index([]), { sinceLastUpdate: true }), null);
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
