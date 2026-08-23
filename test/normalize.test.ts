import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardName } from '../src/db/normalize.js';

test('lowercases and strips accents', () => {
  assert.equal(normalizeCardName('Séance Board'), 'seance board');
  assert.equal(normalizeCardName('Lim-Dûl the Necromancer'), 'lim dul the necromancer');
  assert.equal(normalizeCardName('JÖTUN'), 'jotun');
});

test('flattens punctuation to single spaces', () => {
  assert.equal(normalizeCardName('Jace, Beleren'), 'jace beleren');
  assert.equal(normalizeCardName('Invasion of Arcavios // Invocation of the Founders'),
    'invasion of arcavios invocation of the founders');
  assert.equal(normalizeCardName("Urza's Saga"), 'urza s saga');
});

test('trims and collapses whitespace', () => {
  assert.equal(normalizeCardName('   Sol   Ring   '), 'sol ring');
});

test('is idempotent', () => {
  const once = normalizeCardName('Séance, Board // Test');
  assert.equal(normalizeCardName(once), once);
});

test('handles input that folds away entirely', () => {
  assert.equal(normalizeCardName(''), '');
  assert.equal(normalizeCardName('---'), '');
});
