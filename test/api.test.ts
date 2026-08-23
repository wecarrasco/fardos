import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'mtg-api-test-'));
process.env['DB_PATH'] = join(dir, 'test.db');

const { groupByDeck } = await import('../src/api/search.js');
const { createApp } = await import('../src/app.js');
const repo = await import('../src/db/repo.js');
const { closeDb } = await import('../src/db/index.js');
const { parseDeckPage } = await import('../src/scrapers/manabox.js');
const { parseLinktree } = await import('../src/scrapers/linktree.js');
const { readFixture, FIXTURES, LINKTREE_FIXTURE } = await import('./fixture-manifest.js');

let server: Server;
let base: string;

before(() => {
  repo.upsertLinktreeLinks(parseLinktree(readFixture(LINKTREE_FIXTURE)));
  for (const key of ['mixed', 'small'] as const) {
    repo.saveDeckSnapshot(parseDeckPage(readFixture(FIXTURES[key].file), FIXTURES[key].deckId));
  }
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

/** Response bodies are asserted ad hoc, so `any` is the honest type here. */
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

/* ---------------------------------------------------------------- *
 * Grouping
 * ---------------------------------------------------------------- */

test('groupByDeck collapses hits per deck and sums quantities', () => {
  const groups = groupByDeck(repo.searchCards('seedborn muse'));
  assert.equal(groups.length, 1, 'both printings live in one deck');
  assert.equal(groups[0]!.cards.length, 2);
  assert.equal(groups[0]!.totalQuantity, 4);
});

test('groupByDeck preserves the order hits arrived in', () => {
  const hits = repo.searchCards('a', 200);
  const groups = groupByDeck(hits);
  const firstSeen = [...new Set(hits.map((h) => h.deckId))];
  assert.deepEqual(groups.map((g) => g.deckId), firstSeen);
});

test('groupByDeck handles an empty result', () => {
  assert.deepEqual(groupByDeck([]), []);
});

/* ---------------------------------------------------------------- *
 * HTTP endpoints
 * ---------------------------------------------------------------- */

test('GET /api/search returns grouped decks with totals', async () => {
  const { status, body } = await get('/api/search?q=seedborn%20muse');
  assert.equal(status, 200);
  assert.equal(body.query, 'seedborn muse');
  assert.equal(body.deckCount, 1);
  assert.equal(body.hitCount, 2);
  assert.equal(body.totalCopies, 4);

  const deck = body.decks[0];
  assert.equal(deck.deckUrl, `https://manabox.app/decks/${FIXTURES.mixed.deckId}`);
  assert.ok(deck.deckUpdatedAt, 'the UI needs a freshness timestamp');
  assert.deepEqual(deck.cards.map((c: any) => c.setId).sort(), ['10e', 'bbd']);
});

test('GET /api/search reports foil status per entry', async () => {
  const { body } = await get('/api/search?q=barrowgoyf');
  assert.equal(body.decks[0].cards[0].foil, true);
});

test('GET /api/search handles empty and unmatched queries', async () => {
  for (const q of ['', '%20%20', 'zzzznotacard']) {
    const { status, body } = await get(`/api/search?q=${q}`);
    assert.equal(status, 200);
    assert.deepEqual(body.decks, []);
    assert.equal(body.deckCount, 0);
  }
});

test('GET /api/search clamps an absurd limit instead of failing', async () => {
  for (const limit of ['999999', '-1', 'abc']) {
    const { status } = await get(`/api/search?q=a&limit=${limit}`);
    assert.equal(status, 200);
  }
});

test('GET /api/suggest returns distinct names', async () => {
  const { status, body } = await get('/api/suggest?q=seedborn');
  assert.equal(status, 200);
  assert.deepEqual(body, ['Seedborn Muse']);
  assert.deepEqual((await get('/api/suggest?q=')).body, []);
});

test('GET /api/decks lists active decks in page order', async () => {
  const { body } = await get('/api/decks');
  assert.equal(body.length, 63);
  assert.deepEqual(body.map((d: any) => d.position).slice(0, 3), [0, 1, 2]);
});

test('GET /api/stats and /healthz report index state', async () => {
  const stats = await get('/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.activeDecks, 63);

  const health = await get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.hasData, true);
});

test('GET /api/changes returns the change feed', async () => {
  const { status, body } = await get('/api/changes?limit=5');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('GET /api/refresh/status reports the real refresher as idle', async () => {
  const { status, body } = await get('/api/refresh/status');
  assert.equal(status, 200);
  assert.equal(body.running, false);
  assert.equal(body.phase, 'idle');
  assert.equal(body.decksDone, 0);
  assert.equal(body.decksTotal, 0);
});

test('POST /api/refresh starts a run when idle, and is refused while one runs', async () => {
  // A stubbed refresher keeps this offline; the real one would scrape for
  // minutes. Only the endpoint's own branching is under test here.
  let started = 0;
  let running = false;
  const stub = createApp({
    startRefresh: () => { started++; running = true; },
    isRefreshRunning: () => running,
    getRefreshStatus: () => ({ running, phase: running ? 'decks' : 'idle' }),
  });
  const srv = stub.listen(0);
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  try {
    const first = await fetch(at + '/api/refresh', { method: 'POST' });
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as any).started, true);
    assert.equal(started, 1);

    const second = await fetch(at + '/api/refresh', { method: 'POST' });
    assert.equal(second.status, 409, 'a concurrent request must be refused');
    assert.equal(((await second.json()) as any).started, false);
    assert.equal(started, 1, 'the refused request must not start a second run');

    const st = (await fetch(at + '/api/refresh/status').then((r) => r.json())) as any;
    assert.equal(st.running, true);
  } finally {
    srv.close();
  }
});

test('the frontend is served', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/app.css', 'css']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type')?.includes(type!), `${path} -> ${res.headers.get('content-type')}`);
  }
});
