import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The database path is read from the environment when config.ts loads, so it
// must be set before any module that touches the db is imported.
const dir = mkdtempSync(join(tmpdir(), 'mtg-test-'));
process.env['DB_PATH'] = join(dir, 'test.db');

const { parseDeckPage } = await import('../src/scrapers/manabox.js');
const { parseLinktree } = await import('../src/scrapers/linktree.js');
const repo = await import('../src/db/repo.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { readFixture, FIXTURES, LINKTREE_FIXTURE } = await import('./fixture-manifest.js');

const links = parseLinktree(readFixture(LINKTREE_FIXTURE));
const mixed = parseDeckPage(readFixture(FIXTURES.mixed.file), FIXTURES.mixed.deckId);
const small = parseDeckPage(readFixture(FIXTURES.small.file), FIXTURES.small.deckId);

const rowsFor = (deckId: string) =>
  getDb()
    .prepare('SELECT COUNT(*) n, COALESCE(SUM(quantity),0) q FROM deck_cards WHERE deck_id = ?')
    .get(deckId) as { n: number; q: number };

before(() => { getDb(); });
after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- *
 * Deck upserts
 * ---------------------------------------------------------------- */

test('first upsert reports every link as new', () => {
  const { newDeckIds, reactivatedDeckIds } = repo.upsertLinktreeLinks(links);
  assert.equal(newDeckIds.length, 63);
  assert.equal(reactivatedDeckIds.length, 0);
});

test('re-upserting the same links reports nothing new', () => {
  const { newDeckIds, reactivatedDeckIds } = repo.upsertLinktreeLinks(links);
  assert.equal(newDeckIds.length, 0);
  assert.equal(reactivatedDeckIds.length, 0);
});

test('saving a snapshot stores its cards', () => {
  const { changed, cardCount } = repo.saveDeckSnapshot(mixed);
  assert.equal(cardCount, 108);
  // No prior hash existed, so the first save is not reported as a change.
  assert.equal(changed, false);
  assert.deepEqual(rowsFor(mixed.deckId), { n: 57, q: 108 });
});

test('re-saving identical cards replaces rather than accumulates', () => {
  const { changed } = repo.saveDeckSnapshot(mixed);
  assert.equal(changed, false, 'identical content is not a change');
  assert.deepEqual(rowsFor(mixed.deckId), { n: 57, q: 108 }, 'row count must not grow');
});

test('an edited card list is detected and fully replaces the old rows', () => {
  const edited = structuredClone(mixed);
  edited.cards[0]!.quantity = 99;
  edited.cards.push({
    internalId: 9999, name: 'Injected Test Card', quantity: 7, foil: true,
    setName: 'Fake', setId: 'fak', collectorNumber: '1', rarity: 'Mythic',
    typeName: 'Creature', manaValue: 3,
  });

  const { changed } = repo.saveDeckSnapshot(edited);
  assert.equal(changed, true);
  assert.equal(rowsFor(mixed.deckId).n, 58);
  assert.equal(repo.searchCards('injected test').length, 1);

  // Reverting must remove the injected row entirely, not leave it behind.
  assert.equal(repo.saveDeckSnapshot(mixed).changed, true);
  assert.deepEqual(rowsFor(mixed.deckId), { n: 57, q: 108 });
  assert.equal(repo.searchCards('injected test').length, 0);
});

test('the content hash ignores ordering but not content', () => {
  const reordered = structuredClone(mixed);
  reordered.cards.reverse();
  assert.equal(repo.hashCards(reordered), repo.hashCards(mixed), 'reorder is not a change');

  const foilFlipped = structuredClone(mixed);
  foilFlipped.cards[0]!.foil = !foilFlipped.cards[0]!.foil;
  assert.notEqual(repo.hashCards(foilFlipped), repo.hashCards(mixed), 'foil flip is a change');
});

/* ---------------------------------------------------------------- *
 * Retirement and return
 * ---------------------------------------------------------------- */

test('deactivating a deck drops its cards but keeps the deck row', () => {
  repo.saveDeckSnapshot(small);
  assert.ok(rowsFor(small.deckId).n > 0);

  repo.deactivateDeck(small.deckId, 'test removal');
  assert.deepEqual(rowsFor(small.deckId), { n: 0, q: 0 });

  const row = getDb()
    .prepare('SELECT active, inactive_reason FROM decks WHERE deck_id = ?')
    .get(small.deckId) as { active: number; inactive_reason: string };
  assert.equal(row.active, 0);
  assert.equal(row.inactive_reason, 'test removal');
});

test('a returning deck is reported as reactivated exactly once', () => {
  const first = repo.upsertLinktreeLinks(links);
  assert.deepEqual(first.reactivatedDeckIds, [small.deckId]);

  const second = repo.upsertLinktreeLinks(links);
  assert.deepEqual(second.reactivatedDeckIds, [], 'reactivation must not be sticky');

  repo.saveDeckSnapshot(small);
});

test('decks missing from the current Linktree are identified', () => {
  assert.equal(repo.findDecksMissingFromLinktree(links.map((l) => l.deckId)).length, 0);
  assert.equal(repo.findDecksMissingFromLinktree([]).length, 63, 'all active decks are missing');

  const withoutOne = links.filter((l) => l.deckId !== mixed.deckId).map((l) => l.deckId);
  assert.deepEqual(repo.findDecksMissingFromLinktree(withoutOne), [mixed.deckId]);
});

/* ---------------------------------------------------------------- *
 * Search
 * ---------------------------------------------------------------- */

test('search is case, accent and punctuation insensitive', () => {
  assert.ok(repo.searchCards('SEEDBORN MUSE').length > 0);
  assert.ok(repo.searchCards('seedborn muse').length > 0);
  assert.ok(repo.searchCards('anhelo, the painter').length > 0);
  assert.ok(repo.searchCards('anhelo the painter').length > 0);
});

test('search returns one row per entry, keeping distinct printings apart', () => {
  const hits = repo.searchCards('seedborn muse');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.setId).sort(), ['10e', 'bbd']);
  assert.equal(hits.reduce((n, h) => n + h.quantity, 0), 4);
});

test('search carries deck context and freshness', () => {
  const hit = repo.searchCards('seedborn muse')[0]!;
  assert.equal(hit.deckId, mixed.deckId);
  assert.equal(hit.deckName, mixed.name);
  assert.equal(hit.deckUrl, `https://manabox.app/decks/${mixed.deckId}`);
  assert.equal(hit.deckUpdatedAt, mixed.lastUpdated);
  assert.ok(hit.lastScrapedAt);
});

test('exact matches rank above prefix matches above substring matches', () => {
  const names = repo.searchCards('bloodghast').map((h) => h.cardName);
  assert.ok(names.length > 0);
  assert.equal(names[0], 'Bloodghast');
});

test('inactive decks are excluded from search', () => {
  const before = repo.searchCards('seedborn muse').length;
  assert.ok(before > 0);

  repo.deactivateDeck(mixed.deckId, 'test');
  assert.equal(repo.searchCards('seedborn muse').length, 0);

  repo.saveDeckSnapshot(mixed);
  assert.equal(repo.searchCards('seedborn muse').length, before);
});

test('empty and no-match queries return nothing without throwing', () => {
  assert.deepEqual(repo.searchCards(''), []);
  assert.deepEqual(repo.searchCards('   '), []);
  assert.deepEqual(repo.searchCards('---'), []);
  assert.deepEqual(repo.searchCards('zzzznotacard'), []);
});

test('query text is parameterised, not interpolated', () => {
  assert.deepEqual(repo.searchCards("' OR 1=1 --"), []);
  // The table must still be there afterwards.
  assert.ok(repo.searchCards('seedborn').length > 0);
});

test('the limit is honoured', () => {
  assert.equal(repo.searchCards('a', 5).length, 5);
});

test('suggestions are distinct names, prefix matches first', () => {
  const names = repo.suggestCardNames('seedborn', 10);
  assert.deepEqual(names, ['Seedborn Muse'], 'two printings collapse to one suggestion');
  assert.deepEqual(repo.suggestCardNames(''), []);
});

/* ---------------------------------------------------------------- *
 * Run bookkeeping
 * ---------------------------------------------------------------- */

test('runs record their totals and changes', () => {
  const runId = repo.startRun();
  repo.recordChange(runId, mixed.deckId, 'cards_changed', '108 cards');
  repo.finishRun(runId, 'ok', {
    decksFound: 63, decksAdded: 0, decksRemoved: 0, decksChanged: 1, decksFailed: 0, cardsTotal: 108,
  });

  const run = getDb().prepare('SELECT * FROM scrape_runs WHERE id = ?').get(runId) as any;
  assert.equal(run.status, 'ok');
  assert.equal(run.decks_changed, 1);
  assert.ok(run.finished_at);

  const change = getDb()
    .prepare('SELECT * FROM deck_changes WHERE run_id = ?').get(runId) as any;
  assert.equal(change.change_type, 'cards_changed');
});

test('runs left open by a killed process are reconciled', () => {
  const orphan = repo.startRun();
  assert.equal(repo.reconcileInterruptedRuns(), 1);

  const row = getDb().prepare('SELECT status, finished_at FROM scrape_runs WHERE id = ?')
    .get(orphan) as any;
  assert.equal(row.status, 'interrupted');
  assert.ok(row.finished_at);

  assert.equal(repo.reconcileInterruptedRuns(), 0, 'nothing left to reconcile');
});

test('stats reflect what is stored', () => {
  const s = repo.getStats();
  assert.equal(s.activeDecks, 63);
  assert.ok(s.cardEntries > 0);
  assert.ok(s.uniqueNames > 0);
  assert.ok(s.lastRun);
});
