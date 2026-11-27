import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_NAMES_PATH, closestName, editDistance, loadCardNames, resetCardNames, suggestNames,
} from '../web/cardnames.js';

const NAMES = [
  'Sol Ring', 'Solemn Simulacrum', 'Solitude', 'Arcane Signet', 'Black Lotus',
  'Ancestral Recall', 'Lightning Bolt', 'Ragavan, Nimble Pilferer',
  // All real cards, chosen for "ring": one starting with it, one where it
  // starts a later word, and one where it is buried inside "Springleaf".
  'Ring of Three Wishes', 'Springleaf Drum',
];

/* ---------------------------------------------------------------- *
 * Suggesting
 * ---------------------------------------------------------------- */

test('an exact name comes before the ones merely starting with it', () => {
  assert.equal(suggestNames(NAMES, 'sol ring', { limit: 3 })[0], 'Sol Ring');
});

test('the match tiers are ordered: start of the name, start of a word, inside one', () => {
  const out = suggestNames(NAMES, 'ring', { limit: 5 });
  assert.deepEqual(out.slice(0, 3), ['Ring of Three Wishes', 'Sol Ring', 'Springleaf Drum']);
});

test('names starting with the query come first', () => {
  const out = suggestNames(NAMES, 'sol', { limit: 5 });
  assert.equal(out[0], 'Sol Ring');
  assert.ok(out.includes('Solitude'));
  assert.ok(out.includes('Solemn Simulacrum'));
});

test('a word inside the name is matched, not just the start', () => {
  assert.ok(suggestNames(NAMES, 'bolt').includes('Lightning Bolt'));
  assert.ok(suggestNames(NAMES, 'nimble').includes('Ragavan, Nimble Pilferer'));
});

test('cards the seller stocks are offered first within a tier', () => {
  // Both start with "soli"; the one you can actually buy today is the better
  // first answer, and a native dropdown has no other way to say so.
  const stocked = new Set(['solitude']);
  assert.equal(suggestNames(NAMES, 'soli', { stocked })[0], 'Solitude');
});

test('an empty query suggests nothing rather than everything', () => {
  for (const q of ['', '   ', null, undefined]) {
    assert.deepEqual(suggestNames(NAMES, q as any), []);
  }
  assert.deepEqual(suggestNames(null as any, 'sol'), []);
});

test('the limit is honoured', () => {
  assert.equal(suggestNames(NAMES, 's', { limit: 2 }).length, 2);
});

/* ---------------------------------------------------------------- *
 * Edit distance
 * ---------------------------------------------------------------- */

test('distance counts single-character slips', () => {
  assert.equal(editDistance('sol ring', 'sol ring'), 0);
  assert.equal(editDistance('sol ring', 'sol rign'), 2);   // a transposition is two edits
  assert.equal(editDistance('sol ring', 'sol rng'), 1);    // a dropped letter
  assert.equal(editDistance('sol ring', 'soll ring'), 1);  // a doubled letter
  assert.equal(editDistance('sol ring', 'sol rang'), 1);   // a wrong letter
});

test('the cap stops the measurement instead of finishing it', () => {
  // The exact value past the cap is never used; only that it exceeds it.
  assert.ok(editDistance('lightning bolt', 'ancestral recall', 2) > 2);
  assert.ok(editDistance('abc', 'abcdefghij', 2) > 2);
});

test('distance is symmetric and handles an empty side', () => {
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('sitting', 'kitten'), 3);
});

/* ---------------------------------------------------------------- *
 * Catching a slip -- the point of the thing
 * ---------------------------------------------------------------- */

test('one letter wrong finds the card that was meant', () => {
  assert.equal(closestName(NAMES, 'Sol Rang'), 'Sol Ring');
  assert.equal(closestName(NAMES, 'Black Lotos'), 'Black Lotus');
  assert.equal(closestName(NAMES, 'Lightnig Bolt'), 'Lightning Bolt');
  assert.equal(closestName(NAMES, 'Arcane Signett'), 'Arcane Signet');
});

test('a real card is never corrected', () => {
  // There is nothing to ask about, and asking would make the common case the
  // one that needs a second press.
  for (const n of NAMES) assert.equal(closestName(NAMES, n), null);
  assert.equal(closestName(NAMES, '  sol ring  '), null);
});

test('something far from every card is not forced onto one', () => {
  assert.equal(closestName(NAMES, 'Qwertyuiop Asdfgh'), null);
  assert.equal(closestName(NAMES, 'My Own Invented Card'), null);
});

test('a query too short to judge is left alone', () => {
  // At three letters a single change is a different card, not a slip.
  assert.equal(closestName(NAMES, 'sol'), null);
  assert.equal(closestName(NAMES, 'ab'), null);
});

test('the distance limit is respected', () => {
  assert.equal(closestName(NAMES, 'Sol Rang', 1), 'Sol Ring');
  assert.equal(closestName(NAMES, 'Sol Rangg', 1), null);     // two edits away
  assert.equal(closestName(NAMES, 'Sol Rangg', 2), 'Sol Ring');
});

test('an empty list corrects nothing rather than failing', () => {
  assert.equal(closestName([], 'Sol Rang'), null);
  assert.equal(closestName(null as any, 'Sol Rang'), null);
});

/* ---------------------------------------------------------------- *
 * Loading
 * ---------------------------------------------------------------- */

test('the list is fetched once however many callers ask', async () => {
  resetCardNames();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => NAMES } as any;
  };

  const [a, b] = await Promise.all([
    loadCardNames(fetchImpl, 'x.json'), loadCardNames(fetchImpl, 'x.json'),
  ]);
  const c = await loadCardNames(fetchImpl, 'x.json');

  assert.equal(calls, 1, 'concurrent callers must share one download');
  assert.deepEqual(a, NAMES);
  assert.equal(b, a);
  assert.equal(c, a);
});

test('a failed download leaves the box working, and can be retried', async () => {
  resetCardNames();
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return { ok: true, json: async () => NAMES } as any;
  };

  assert.deepEqual(await loadCardNames(flaky, 'x.json'), []);
  // Not latched: a dropped connection on the first keystroke must not disable
  // suggestions for the rest of the visit.
  assert.deepEqual(await loadCardNames(flaky, 'x.json'), NAMES);
});

test('a non-OK response and junk content are both an empty list', async () => {
  for (const res of [
    { ok: false, status: 404 },
    { ok: true, json: async () => ({ not: 'an array' }) },
    { ok: true, json: async () => null },
  ]) {
    resetCardNames();
    assert.deepEqual(await loadCardNames((async () => res) as any, 'x.json'), []);
  }
});

test('non-string entries are dropped rather than suggested', async () => {
  resetCardNames();
  const res = { ok: true, json: async () => ['Sol Ring', 42, null, '', 'Black Lotus'] };
  assert.deepEqual(await loadCardNames((async () => res) as any, 'x.json'),
    ['Sol Ring', 'Black Lotus']);
});

test('the published path is the one the build copies', () => {
  assert.equal(CARD_NAMES_PATH, 'card-names.json');
});
