import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LEGAL_FORMATS, LEGALITY_PATH, STALE_AFTER_DAYS, buildLegalityLookup, frontFaceName,
  isLegalIn, legalityBits, legalityKey, parseLegalityTable,
} from '../src/legality.js';
import { normalizeCardName } from '../web/normalize.js';
import { ageInDays } from '../src/decks.js';

const root = resolve(import.meta.dirname, '..');

const table = (legalities: Record<string, number>, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    capturedAt: '2026-10-30',
    source: 'https://data.scryfall.io/oracle-cards/x.jsonl.gz',
    formats: [...LEGAL_FORMATS],
    legalities,
    ...over,
  });

const shipped = () =>
  buildLegalityLookup(parseLegalityTable(readFileSync(resolve(root, LEGALITY_PATH), 'utf8')));

/* ---------------------------------------------------------------- *
 * The mask
 * ---------------------------------------------------------------- */

test('a status of legal or restricted means you may play it', () => {
  // Restricted is "one copy", which is still a card you can own and the
  // seller can sell.
  const bits = legalityBits({
    standard: 'not_legal', pioneer: 'banned', modern: 'legal',
    legacy: 'restricted', pauper: 'not_legal', commander: 'legal',
  });
  assert.equal(isLegalIn(bits, 'modern'), true);
  assert.equal(isLegalIn(bits, 'legacy'), true, 'restricted is playable');
  assert.equal(isLegalIn(bits, 'pioneer'), false, 'banned is not');
  assert.equal(isLegalIn(bits, 'standard'), false);
});

test('an unknown mask or format is never legal, and never throws', () => {
  assert.equal(isLegalIn(null, 'modern'), false);
  assert.equal(isLegalIn(undefined, 'modern'), false);
  assert.equal(isLegalIn(63, 'yugioh'), false);
  assert.equal(legalityBits(null), 0);
  assert.equal(legalityBits({}), 0);
});

test('the bit order is the format list, positionally', () => {
  LEGAL_FORMATS.forEach((f, i) => {
    assert.equal(legalityBits({ [f]: 'legal' }), 1 << i, f);
  });
});

/* ---------------------------------------------------------------- *
 * The join key
 * ---------------------------------------------------------------- */

test('the join key folds case and keeps punctuation', () => {
  assert.equal(legalityKey('Sol Ring'), 'sol ring');
  assert.equal(legalityKey('  Sol Ring  '), 'sol ring');
  assert.equal(legalityKey("K'rrik, Son of Yawgmoth"), "k'rrik, son of yawgmoth");
});

test('the join key is deliberately not the search key', () => {
  // normalizeCardName also strips punctuation, which is right for a search box
  // -- someone typing "krriks" should find K'rrik's -- and wrong here: it
  // merges Rampant Growth with the playtest card "Rampant, Growth", which is
  // legal in nothing. Rampant Growth is in this seller's stock.
  assert.equal(normalizeCardName('Rampant Growth'), normalizeCardName('Rampant, Growth'));
  assert.notEqual(legalityKey('Rampant Growth'), legalityKey('Rampant, Growth'));
});

test('a double-faced name yields its front face', () => {
  assert.equal(frontFaceName('Fire // Ice'), 'Fire');
  assert.equal(frontFaceName('Sol Ring'), 'Sol Ring');
});

/* ---------------------------------------------------------------- *
 * Validation -- the table must never half-load
 * ---------------------------------------------------------------- */

test('a well-formed table parses', () => {
  const t = parseLegalityTable(table({ 'Sol Ring': 32 }));
  assert.equal(t.legalities['Sol Ring'], 32);
  assert.equal(t.capturedAt, '2026-10-30');
});

test('a malformed table is refused rather than partially loaded', () => {
  assert.throws(() => parseLegalityTable('not json'), /not valid JSON/);
  assert.throws(() => parseLegalityTable('{}'), /no "legalities" object/);
  assert.throws(() => parseLegalityTable(table({})), /empty/);
});

test('a table whose formats disagree with the build is refused', () => {
  // The masks are positional. A file listing different formats, or the same
  // ones reordered, would be read as a different question on every card --
  // silently, with no symptom but wrong answers.
  assert.throws(
    () => parseLegalityTable(table({ 'Sol Ring': 32 }, { formats: ['modern', 'standard'] })),
    /expects \[standard, pioneer/,
  );
  assert.throws(
    () => parseLegalityTable(table({ 'Sol Ring': 32 }, { formats: [...LEGAL_FORMATS].reverse() })),
    /expects/,
  );
  assert.throws(() => parseLegalityTable(table({ 'Sol Ring': 32 }, { formats: undefined })), /expects/);
});

test('a mask outside the format range is refused', () => {
  assert.throws(() => parseLegalityTable(table({ X: 64 })), /not a 6-bit mask/);
  assert.throws(() => parseLegalityTable(table({ X: -1 })), /not a 6-bit mask/);
  assert.throws(() => parseLegalityTable(table({ X: 1.5 })), /not a 6-bit mask/);
});

/* ---------------------------------------------------------------- *
 * Lookup
 * ---------------------------------------------------------------- */

test('names are matched regardless of case', () => {
  const l = buildLegalityLookup(parseLegalityTable(table({ 'Sol Ring': 32 })));
  assert.equal(l.bitsFor('sol ring'), 32);
  assert.equal(l.bitsFor('SOL RING'), 32);
  assert.equal(l.bitsFor('Mystery Card'), null);
});

test('a front face resolves to its split card', () => {
  // ManaBox stores only the front half of a double-faced name.
  const l = buildLegalityLookup(parseLegalityTable(table({ 'Fire // Ice': 12 })));
  assert.equal(l.bitsFor('Fire'), 12);
  assert.equal(l.bitsFor('Fire // Ice'), 12);
});

test('a real card beats a front face that happens to match it', () => {
  const l = buildLegalityLookup(parseLegalityTable(table({ 'Fire // Ice': 12, Fire: 3 })));
  assert.equal(l.bitsFor('Fire'), 3, 'the card actually called Fire wins');
});

test('a front face two split cards share answers for neither', () => {
  // "Start // Fire" and "Start // Finish" are both real cards. Guessing
  // between them puts a wrong legality on a card; declining only hides it.
  const l = buildLegalityLookup(
    parseLegalityTable(table({ 'Start // Fire': 12, 'Start // Finish': 3 })));
  assert.equal(l.bitsFor('Start'), null);
});

/* ---------------------------------------------------------------- *
 * The shipped table
 * ---------------------------------------------------------------- */

test('the committed legality table is valid and non-trivial', () => {
  const t = parseLegalityTable(readFileSync(resolve(root, LEGALITY_PATH), 'utf8'));
  assert.ok(Object.keys(t.legalities).length > 20_000, 'suspiciously few cards');
  assert.ok(t.source.includes('scryfall'), 'provenance should name where it came from');
  assert.ok(ageInDays(t.capturedAt) < STALE_AFTER_DAYS * 4, 'the committed table is very old');
});

test('cards whose legality is well known are right in the shipped table', () => {
  // A spot check against the real file. Every one of these would fail if the
  // Art Series rows had won their names, since an Art Series card is legal
  // nowhere.
  const l = shipped();
  const legal = (name: string) => LEGAL_FORMATS.filter((f) => isLegalIn(l.bitsFor(name), f));

  assert.deepEqual(legal('Sol Ring'), ['commander'], 'banned in the rest');
  assert.deepEqual(legal('Lightning Bolt'), ['modern', 'legacy', 'pauper', 'commander']);
  assert.deepEqual(legal('Mortify'), ['standard', 'pioneer', 'modern', 'legacy', 'commander'],
    'the Art Series collision: this card is not legal-nowhere');
  assert.ok(legal('Rampant Growth').includes('pauper'),
    'and not the playtest card it folds onto under the search key');
});

test('a card legal in none of the six is left out rather than stored as zero', () => {
  // Black Lotus is banned in Commander and restricted in Vintage, which is not
  // one of the six. Absent and zero read the same to every caller, and absent
  // is thirty bytes cheaper across thirty thousand cards.
  const l = shipped();
  assert.equal(l.bitsFor('Black Lotus'), null);
  assert.equal(isLegalIn(l.bitsFor('Black Lotus'), 'commander'), false);
});

test('tokens and art cards are absent from the shipped table', () => {
  const l = shipped();
  for (const t of ['Goblin Army', 'Bird Soldier', 'Human Soldier']) {
    assert.equal(l.bitsFor(t), null, `${t} should not be in a legality table`);
  }
});

test('a real card that shares a token name keeps its own legality', () => {
  // ManaBox files its Scarecrow token under typeName "Other", which is how
  // build-index knows not to ask about it. The real Scarecrow is still here.
  const l = shipped();
  assert.deepEqual(LEGAL_FORMATS.filter((f) => isLegalIn(l.bitsFor('Scarecrow'), f)),
    ['legacy', 'commander']);
});
