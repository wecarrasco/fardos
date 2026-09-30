import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ageInDays, parseDeckList, STALE_AFTER_DAYS } from '../src/decks.js';
import { parseLinktree, deckDiscount } from '../src/scrapers/linktree.js';
import { readFixture, LINKTREE_FIXTURE } from './fixture-manifest.js';

const root = resolve(import.meta.dirname, '..');

const entry = (over: Record<string, unknown> = {}) => ({
  deckId: 'AZ_RG1TNdsG5sWmkbXJ3gA',
  url: 'https://manabox.app/decks/AZ_RG1TNdsG5sWmkbXJ3gA',
  linkText: 'Artifacts III',
  category: null,
  position: 0,
  discount: null,
  ...over,
});
const list = (decks: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ capturedAt: '2026-09-27', source: 'https://linktr.ee/x', decks, ...over });

/* ---------------------------------------------------------------- *
 * Validation — the list must never half-load
 * ---------------------------------------------------------------- */

test('a well-formed list parses', () => {
  const out = parseDeckList(list([entry(), entry({ deckId: 'other', position: 1 })]));
  assert.equal(out.decks.length, 2);
  assert.equal(out.capturedAt, '2026-09-27');
});

test('an empty list is refused, not returned', () => {
  // Building from an empty list would publish an index with no decks and wipe
  // a working site.
  assert.throws(() => parseDeckList(list([])), /empty/);
});

test('a malformed list is refused rather than partially loaded', () => {
  assert.throws(() => parseDeckList('not json'), /not valid JSON/);
  assert.throws(() => parseDeckList('{}'), /no "decks" array/);
  assert.throws(() => parseDeckList(list([{ url: 'x' }])), /no deckId/);
  assert.throws(() => parseDeckList(list([entry({ url: undefined })])), /no url/);
});

test('duplicate deck ids are refused', () => {
  // Two entries for one deck would scrape it twice and double its cards.
  assert.throws(() => parseDeckList(list([entry(), entry({ position: 1 })])), /duplicate/);
});

test('a missing capturedAt does not throw, it reads as unknown age', () => {
  const out = parseDeckList(JSON.stringify({ decks: [entry()] }));
  assert.equal(out.capturedAt, '');
  assert.equal(ageInDays(out.capturedAt), Number.POSITIVE_INFINITY);
});

/* ---------------------------------------------------------------- *
 * Staleness
 * ---------------------------------------------------------------- */

test('age is whole days, and never negative', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  assert.equal(ageInDays('2026-09-30', now), 0);
  assert.equal(ageInDays('2026-09-27', now), 3);
  // A capture dated in the future is odd but must not read as ancient.
  assert.equal(ageInDays('2026-12-01', now), 0);
});

test('an unparseable date counts as infinitely stale, so it warns', () => {
  assert.equal(ageInDays('not a date'), Number.POSITIVE_INFINITY);
  assert.ok(ageInDays('not a date') >= STALE_AFTER_DAYS);
});

/* ---------------------------------------------------------------- *
 * The shipped list
 * ---------------------------------------------------------------- */

test('the committed deck list is valid and non-trivial', () => {
  const shipped = parseDeckList(readFileSync(resolve(root, 'decks.json'), 'utf8'));
  assert.ok(shipped.decks.length > 20, `only ${shipped.decks.length} decks`);
  assert.ok(shipped.decks.every((d) => d.url.startsWith('https://manabox.app/decks/')));
  assert.ok(shipped.decks.some((d) => d.discount !== null), 'no discounts recorded at all');
  assert.ok(
    shipped.decks.every((d) => d.discount === null || (d.discount > 0 && d.discount < 100)),
    'a discount outside 1-99%',
  );
});

/* ---------------------------------------------------------------- *
 * The capture path still uses the tested parser
 * ---------------------------------------------------------------- */

test('a saved page produces entries the build can consume', () => {
  // This is what `npm run decks:update` does: the same parseLinktree() the
  // scraper always used, fed from a file instead of a fetch.
  const links = parseLinktree(readFixture(LINKTREE_FIXTURE));
  const entries = links.map((l) => ({ ...l, discount: deckDiscount(l) }));

  assert.ok(entries.length > 0);
  const parsed = parseDeckList(list(entries));
  assert.equal(parsed.decks.length, entries.length);
  assert.ok(parsed.decks.every((d) => d.deckId && d.url));
});

test('capture resolves discounts once, so the build need not re-derive them', () => {
  const links = parseLinktree(readFixture(LINKTREE_FIXTURE));
  const entries = links.map((l) => ({ ...l, discount: deckDiscount(l) }));
  const discounted = entries.filter((e) => e.discount !== null);

  assert.ok(discounted.length > 0, 'the fixture should carry discounts');
  // Every resolved value matches what the parser would say on demand.
  for (const e of entries) assert.equal(e.discount, deckDiscount(e));
});
