import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'mtg-metrics-'));
process.env['DB_PATH'] = join(dir, 'test.db');

const metrics = await import('../src/db/metrics.js');
const repo = await import('../src/db/repo.js');
const { createApp } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { parseDeckPage } = await import('../src/scrapers/manabox.js');
const { parseLinktree } = await import('../src/scrapers/linktree.js');
const { readFixture, FIXTURES, LINKTREE_FIXTURE } = await import('./fixture-manifest.js');

let server: Server;
let base: string;

before(() => {
  repo.upsertLinktreeLinks(parseLinktree(readFixture(LINKTREE_FIXTURE)));
  repo.saveDeckSnapshot(parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

const countRows = (t: string) =>
  (getDb().prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

/* ---------------------------------------------------------------- *
 * Visitor identity
 * ---------------------------------------------------------------- */

test('visitor hashes are stable per input and leak nothing', () => {
  const a = metrics.visitorHash('203.0.113.7', 'Mozilla/5.0');
  const b = metrics.visitorHash('203.0.113.7', 'Mozilla/5.0');
  const c = metrics.visitorHash('203.0.113.8', 'Mozilla/5.0');

  assert.equal(a, b, 'same visitor, same day, same hash');
  assert.notEqual(a, c, 'different address, different hash');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes('203'), 'the address must not survive into the hash');
});

test('missing request metadata still yields a usable hash', () => {
  assert.match(metrics.visitorHash(undefined, undefined), /^[0-9a-f]{16}$/);
});

/* ---------------------------------------------------------------- *
 * Search logging
 * ---------------------------------------------------------------- */

test('a search is recorded with its outcome', () => {
  metrics.logSearch('Sol Ring', { resultDecks: 3, resultEntries: 4, totalCopies: 9 }, 'visitor-a');

  const row = getDb().prepare('SELECT * FROM search_log ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(row.query, 'Sol Ring');
  assert.equal(row.query_norm, 'sol ring');
  assert.equal(row.result_decks, 3);
  assert.equal(row.total_copies, 9);
  assert.equal(row.visitor, 'visitor-a');
});

test('typing a query letter by letter records one search, not five', () => {
  const before = countRows('search_log');
  for (const q of ['s', 'se', 'see', 'seed', 'seedborn'])
    metrics.logSearch(q, { resultDecks: 1, resultEntries: 2, totalCopies: 4 }, 'visitor-typing');

  assert.equal(countRows('search_log') - before, 1, 'refinements collapse into one row');
  const row = getDb()
    .prepare(`SELECT query_norm FROM search_log WHERE visitor = 'visitor-typing'`)
    .get() as any;
  assert.equal(row.query_norm, 'seedborn', 'the final query is what is kept');
});

test('backspacing to a shorter query also collapses', () => {
  const before = countRows('search_log');
  metrics.logSearch('lightning bolt', { resultDecks: 1, resultEntries: 1, totalCopies: 1 }, 'visitor-back');
  metrics.logSearch('lightning', { resultDecks: 2, resultEntries: 2, totalCopies: 2 }, 'visitor-back');
  assert.equal(countRows('search_log') - before, 1);
});

test('an unrelated query starts a new row', () => {
  const before = countRows('search_log');
  metrics.logSearch('goblin', { resultDecks: 1, resultEntries: 1, totalCopies: 1 }, 'visitor-b');
  metrics.logSearch('island', { resultDecks: 1, resultEntries: 1, totalCopies: 1 }, 'visitor-b');
  assert.equal(countRows('search_log') - before, 2);
});

test('blank queries are not recorded', () => {
  const before = countRows('search_log');
  for (const q of ['', '   ', '---'])
    metrics.logSearch(q, { resultDecks: 0, resultEntries: 0, totalCopies: 0 }, 'visitor-c');
  assert.equal(countRows('search_log'), before);
});

/* ---------------------------------------------------------------- *
 * Reporting
 * ---------------------------------------------------------------- */

test('zero-result searches surface as the restock list', () => {
  metrics.logSearch('black lotus', { resultDecks: 0, resultEntries: 0, totalCopies: 0 }, 'visitor-d');
  metrics.logSearch('black lotus', { resultDecks: 0, resultEntries: 0, totalCopies: 0 }, 'visitor-e');

  const missed = metrics.getMetrics(30).missedSearches;
  const lotus = missed.find((m) => m.query === 'black lotus');
  assert.ok(lotus, 'a card nobody stocks should appear');
  assert.equal(lotus!.searches, 2);
  assert.ok(!missed.some((m) => m.query === 'sol ring'), 'found searches must not appear here');
});

test('deck clicks are recorded and reported', () => {
  metrics.logDeckClick(FIXTURES.mixed.deckId, 'Sol Ring', 'sol ring', 'visitor-f');
  metrics.logDeckClick(FIXTURES.mixed.deckId, 'Sol Ring', 'sol ring', 'visitor-g');

  const m = metrics.getMetrics(30);
  assert.equal(m.topClickedDecks[0]?.clicks, 2);
  assert.equal(m.topClickedDecks[0]?.deckName, 'SAF/ON THE ROAD 🛣️');
  assert.equal(m.topClickedCards[0]?.cardName, 'Sol Ring');
});

test('inventory metrics come from the index, not from visitor activity', () => {
  const inv = metrics.getMetrics(30).inventory;
  assert.equal(inv.entries, 57);
  assert.equal(inv.copies, 108);
  assert.equal(inv.names, 56, 'two printings of one card count once by name');
  assert.equal(inv.foilCopies, 40);
  assert.ok(inv.byRarity.length > 0);
  assert.ok(inv.byType.some((t) => t.typeName === 'Creature'));
  assert.ok(inv.topSets.some((s) => s.setId === 'sld'));
});

test('activity totals and miss rate are computed', () => {
  const a = metrics.getMetrics(30).activity;
  assert.ok(a.searches > 0);
  assert.ok(a.visitors > 0);
  assert.ok(a.clicks >= 2);
  assert.ok(a.missRate !== null && a.missRate > 0, 'some searches found nothing');
});

test('an empty window reports zeros rather than throwing', () => {
  const m = metrics.getMetrics(0);
  assert.equal(m.activity.searches, 0);
  assert.deepEqual(m.missedSearches, []);
  // Inventory is not time-bound, so it still reports.
  assert.equal(m.inventory.entries, 57);
});

/* ---------------------------------------------------------------- *
 * HTTP surface
 * ---------------------------------------------------------------- */

test('searching over HTTP records a search', async () => {
  const before = countRows('search_log');
  await fetch(base + '/api/search?q=barrowgoyf');
  assert.equal(countRows('search_log'), before + 1);
});

test('an empty query is not recorded', async () => {
  const before = countRows('search_log');
  await fetch(base + '/api/search?q=');
  assert.equal(countRows('search_log'), before);
});

test('POST /api/track/click records a click and ignores junk', async () => {
  const before = countRows('deck_click');

  const ok = await fetch(base + '/api/track/click', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deckId: FIXTURES.mixed.deckId, cardName: 'Baleful Strix', query: 'strix' }),
  });
  assert.equal(ok.status, 204);
  assert.equal(countRows('deck_click'), before + 1);

  for (const body of ['{}', '{"deckId":""}', '{"deckId":123}']) {
    const res = await fetch(base + '/api/track/click', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(res.status, 204, 'malformed beacons are ignored, not errors');
  }
  assert.equal(countRows('deck_click'), before + 1, 'junk must not create rows');
});

test('GET /api/metrics returns the full report', async () => {
  const res = await fetch(base + '/api/metrics?days=30');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  for (const key of ['activity', 'perDay', 'perHour', 'topSearches', 'missedSearches',
                     'topClickedDecks', 'topClickedCards', 'inventory', 'runs', 'recentChanges']) {
    assert.ok(key in body, `missing ${key}`);
  }
  assert.equal(body.windowDays, 30);
});

test('the stats page is served', async () => {
  for (const p of ['/stats.html', '/stats.js', '/stats.css']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
});
