import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinktree, parseDeckId, LINKTREE_SELECTORS } from '../src/scrapers/linktree.js';
import { readFixture, LINKTREE_FIXTURE } from './fixture-manifest.js';
import { captureLogs, hasAnomaly } from './helpers.js';

const html = readFixture(LINKTREE_FIXTURE);

test('extracts every deck link from the saved page', () => {
  const links = parseLinktree(html);
  assert.equal(links.length, 63);
  assert.equal(new Set(links.map((l) => l.deckId)).size, 63, 'deck ids must be unique');
});

test('groups links under their section headings', () => {
  const counts = new Map<string, number>();
  for (const l of parseLinktree(html)) {
    const k = l.category ?? '(ungrouped)';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), {
    '(ungrouped)': 3,
    'MARVEL — 10% OFF': 8,
    'LINKS 20% de DESCUENTO': 9,
    'LINKS CLÁSICOS DE SAF 📎 (30% OFF)': 26,
    'SAF STANDARD 🎲 (20% OFF)': 17,
  });
});

test('links above the first section are ungrouped, not mis-assigned', () => {
  const links = parseLinktree(html);
  assert.equal(links[0]?.category, null);
  assert.equal(links[2]?.category, null);
  assert.equal(links[3]?.category, 'MARVEL — 10% OFF');
});

test('preserves page order and link text', () => {
  const links = parseLinktree(html);
  assert.deepEqual(links.map((l) => l.position).slice(0, 5), [0, 1, 2, 3, 4]);
  assert.equal(links[0]?.linkText, 'SAF/ON THE ROAD 🛣️');
});

test('canonicalises deck urls', () => {
  for (const l of parseLinktree(html)) {
    assert.equal(l.url, `https://manabox.app/decks/${l.deckId}`);
  }
});

test('falls back to href matching when the testid attribute disappears', () => {
  // Simulate Linktree renaming its test ids; the anchors themselves survive.
  const stripped = html.replaceAll('data-testid="LinkClickTriggerLink"', 'data-testid="Renamed"');
  let links: ReturnType<typeof parseLinktree> = [];
  const logs = captureLogs(() => { links = parseLinktree(stripped); });

  assert.equal(links.length, 63, 'fallback selector must still find every deck');
  assert.ok(hasAnomaly(logs), 'the degraded path must announce itself');
});

test('reports zero decks as an anomaly rather than an empty page', () => {
  let links: ReturnType<typeof parseLinktree> = [];
  const logs = captureLogs(() => { links = parseLinktree('<html><body><p>nothing</p></body></html>'); });
  assert.equal(links.length, 0);
  assert.ok(hasAnomaly(logs));
});

test('ignores non-ManaBox links on the page', () => {
  // The real page carries Instagram and WhatsApp links; none should appear.
  assert.ok(html.includes('instagram.com'));
  assert.ok(parseLinktree(html).every((l) => l.url.startsWith('https://manabox.app/decks/')));
});

test('parseDeckId accepts real url shapes and rejects everything else', () => {
  assert.equal(parseDeckId('https://manabox.app/decks/ABC_123-xyz'), 'ABC_123-xyz');
  assert.equal(parseDeckId('http://www.manabox.app/decks/ABC?utm=x'), 'ABC');
  assert.equal(parseDeckId('  https://manabox.app/decks/ABC  '), 'ABC');
  assert.equal(parseDeckId('https://manabox.app/cards/ABC'), null);
  assert.equal(parseDeckId('https://example.com/decks/ABC'), null);
  assert.equal(parseDeckId('not a url'), null);
});

test('selectors are exposed for patching', () => {
  assert.ok(LINKTREE_SELECTORS.linkAnchor.length > 0);
  assert.ok(LINKTREE_SELECTORS.linkAnchorFallback.includes('manabox.app/decks'));
});
