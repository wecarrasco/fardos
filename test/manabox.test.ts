import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckPage, cardTypeName } from '../src/scrapers/manabox.js';
import { readFixture, FIXTURES } from './fixture-manifest.js';
import { captureLogs, hasAnomaly } from './helpers.js';

const parse = (k: keyof typeof FIXTURES) =>
  parseDeckPage(readFixture(FIXTURES[k].file), FIXTURES[k].deckId);

const sum = (cards: { quantity: number }[]) => cards.reduce((n, c) => n + c.quantity, 0);

/* -------------------------------------------------------------- *
 * The core invariant: what we parse matches what the page claims.
 * -------------------------------------------------------------- */

for (const key of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
  test(`${key}: parsed quantities match the page's own card count`, () => {
    const deck = parse(key);
    assert.ok(deck.cards.length > 0, 'expected a non-empty card list');
    assert.equal(deck.declaredCardCount !== null, true, 'page should declare a total');
    assert.equal(sum(deck.cards), deck.declaredCardCount);
  });

  test(`${key}: every card type resolves to a known name`, () => {
    // "Other (n)" is the fall-through for an integer we have not mapped; seeing
    // one means ManaBox introduced a type and the mapping needs updating.
    const unknown = parse(key).cards.filter((c) => c.typeName.startsWith('Other ('));
    assert.deepEqual(unknown.map((c) => `${c.name}: ${c.typeName}`), []);
  });

  test(`${key}: reports a last-updated timestamp`, () => {
    const { lastUpdated } = parse(key);
    assert.ok(lastUpdated, 'expected an editDate');
    assert.ok(!Number.isNaN(Date.parse(lastUpdated!)), 'expected a parseable ISO date');
  });
}

/* -------------------------------------------------------------- *
 * Deck-specific expectations
 * -------------------------------------------------------------- */

test('mixed deck: entry counts, foils and card types', () => {
  const deck = parse('mixed');
  assert.equal(deck.name, 'SAF/ON THE ROAD 🛣️');
  assert.equal(deck.cards.length, 57);
  assert.equal(sum(deck.cards), 108);
  assert.equal(deck.cards.filter((c) => c.foil).length, 26);
  assert.equal(deck.lastUpdated, '2026-08-22T16:00:39.998Z');

  const byType = new Map<string, number>();
  for (const c of deck.cards) byType.set(c.typeName, (byType.get(c.typeName) ?? 0) + c.quantity);
  assert.deepEqual(Object.fromEntries(byType), {
    Creature: 32, Sorcery: 21, Instant: 33, Land: 4, Artifact: 6, Enchantment: 12,
  });
});

test('the same card in two printings stays two separate entries', () => {
  // The regression this guards: deduping by card name would silently merge
  // these and lose a copy.
  const muses = parse('mixed').cards.filter((c) => c.name === 'Seedborn Muse');
  assert.equal(muses.length, 2);
  assert.deepEqual(
    muses.map((c) => ({ set: c.setId, qty: c.quantity })).sort((a, b) => a.set!.localeCompare(b.set!)),
    [{ set: 'bbd', qty: 1 }, { set: '10e', qty: 3 }].sort((a, b) => a.set.localeCompare(b.set)),
  );
  assert.notEqual(muses[0]!.internalId, muses[1]!.internalId);
});

test('small deck has fewer unique names than entries', () => {
  const deck = parse('small');
  assert.equal(deck.cards.length, 8);
  assert.equal(sum(deck.cards), 11);
  assert.ok(new Set(deck.cards.map((c) => c.name)).size < deck.cards.length);
});

test('type 0 is Planeswalker, not an unknown bucket', () => {
  const pw = parse('planeswalkers').cards.filter((c) => c.typeName === 'Planeswalker');
  assert.ok(pw.length > 0, 'fixture should contain planeswalkers');
  // Sanity-check the mapping against names that are unambiguously planeswalkers.
  assert.ok(pw.every((c) => /Chandra|Vraska|Jace|Liliana|Nissa|Garruk|Teferi|Ral|Ajani|Angrath/.test(c.name)),
    `unexpected members: ${pw.map((c) => c.name).join(', ')}`);
});

test('type 6 is Battle', () => {
  const battles = parse('battles').cards.filter((c) => c.typeName === 'Battle');
  assert.equal(battles.length, 9, 'entries');
  assert.equal(sum(battles), 11, 'copies');
  // Battles are the "Invasion of ..." double-faced cards from March of the Machine.
  assert.ok(battles.every((c) => c.name.startsWith('Invasion of ')),
    `unexpected members: ${battles.map((c) => c.name).join(', ')}`);
});

test('token deck maps to the Other bucket ManaBox itself renders', () => {
  const deck = parse('tokens');
  assert.equal(sum(deck.cards), 998);
  assert.ok(deck.cards.every((c) => c.typeName === 'Other'));
});

test('cards carry printing detail, not just name and quantity', () => {
  const card = parse('mixed').cards.find((c) => c.name === 'Baleful Strix');
  assert.ok(card);
  assert.equal(card!.setId, 'sld');
  assert.equal(card!.setName, 'Secret Lair Drop');
  assert.equal(card!.rarity, 'Rare');
  assert.equal(card!.collectorNumber, '2070');
  assert.equal(card!.typeName, 'Creature');
});

/* -------------------------------------------------------------- *
 * Degradation paths
 * -------------------------------------------------------------- */

test('falls back to DOM parsing when the JSON payload is gone', () => {
  const html = readFixture(FIXTURES.mixed.file);
  const viaJson = parseDeckPage(html, FIXTURES.mixed.deckId);

  let viaDom!: ReturnType<typeof parseDeckPage>;
  const logs = captureLogs(() => {
    viaDom = parseDeckPage(html.replace(/props="[^"]*"/g, 'props=""'), FIXTURES.mixed.deckId);
  });

  assert.ok(hasAnomaly(logs), 'the fallback must announce itself');
  const shape = (d: typeof viaJson) =>
    d.cards.map((c) => `${c.quantity}|${c.name}|${c.foil}`).sort();
  assert.deepEqual(shape(viaDom), shape(viaJson),
    'fallback must agree with the JSON path on name, quantity and foil');
});

test('the DOM fallback does not double-count the mobile copy of each row', () => {
  // Each card is rendered twice (desktop + mobile wrappers). Counting both
  // would report 114 rows for a 57-entry deck.
  const html = readFixture(FIXTURES.mixed.file).replace(/props="[^"]*"/g, 'props=""');
  let deck!: ReturnType<typeof parseDeckPage>;
  captureLogs(() => { deck = parseDeckPage(html, FIXTURES.mixed.deckId); });
  assert.equal(deck.cards.length, 57);
  assert.equal(sum(deck.cards), 108);
});

test('a total layout change yields zero cards and a loud anomaly', () => {
  const html = readFixture(FIXTURES.mixed.file)
    .replace(/props="[^"]*"/g, 'props=""')
    .replace(/class="hidden md:block"/g, 'class="renamed"');

  let deck!: ReturnType<typeof parseDeckPage>;
  const logs = captureLogs(() => { deck = parseDeckPage(html, FIXTURES.mixed.deckId); });

  assert.equal(deck.cards.length, 0);
  assert.ok(logs.some((l) => l.includes('parsed 0 cards')));
});

test('a card-count mismatch is reported', () => {
  // Drop one entry from the payload and confirm the cross-check notices.
  const html = readFixture(FIXTURES.small.file);
  const broken = html.replace('&quot;quantity&quot;:[0,', '&quot;quantity&quot;:[0,0*');

  let logs: string[] = [];
  captureLogs(() => { /* warm */ });
  logs = captureLogs(() => parseDeckPage(broken, FIXTURES.small.deckId));
  assert.ok(logs.some((l) => l.includes('mismatch') || l.includes('ANOMALY')),
    `expected a mismatch warning, got: ${logs.join(' | ')}`);
});

test('cardTypeName maps knowns and degrades gracefully', () => {
  assert.equal(cardTypeName(0), 'Planeswalker');
  assert.equal(cardTypeName(1), 'Creature');
  assert.equal(cardTypeName(6), 'Battle');
  assert.equal(cardTypeName(7), 'Land');
  assert.equal(cardTypeName(8), 'Other');
  assert.equal(cardTypeName(99), 'Other (99)');
  assert.equal(cardTypeName(undefined), 'Other');
});
