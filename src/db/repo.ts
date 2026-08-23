import { createHash } from 'node:crypto';
import { getDb } from './index.js';
import { normalizeCardName } from './normalize.js';
import type { LinktreeDeckLink } from '../scrapers/linktree.js';
import type { DeckSnapshot } from '../scrapers/manabox.js';

const nowIso = () => new Date().toISOString();

/**
 * Content hash of a deck's card rows. Order-independent, so a reordering by
 * ManaBox does not read as a change; any quantity, foil, or printing edit does.
 */
export function hashCards(deck: DeckSnapshot): string {
  const rows = deck.cards
    .map((c) => `${c.name}|${c.quantity}|${c.foil ? 1 : 0}|${c.setId ?? ''}|${c.collectorNumber ?? ''}`)
    .sort();
  return createHash('sha1').update(rows.join('\n')).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Deck upserts
 * ------------------------------------------------------------------ */

/**
 * Record what the Linktree page currently lists. Inserts unseen decks, refreshes
 * the link metadata of known ones, and reports both brand-new ids and ids that
 * were previously retired and have now reappeared -- a deck coming back is a
 * change worth logging, not a silent reactivation.
 */
export function upsertLinktreeLinks(
  links: LinktreeDeckLink[],
): { newDeckIds: string[]; reactivatedDeckIds: string[] } {
  const db = getDb();
  const seenAt = nowIso();

  const priorState = new Map<string, number>(
    db
      .prepare('SELECT deck_id, active FROM decks')
      .all()
      .map((r) => {
        const row = r as { deck_id: string; active: number };
        return [row.deck_id, row.active];
      }),
  );

  const stmt = db.prepare(`
    INSERT INTO decks (deck_id, url, name, link_text, category, position,
                       last_seen_on_linktree, active)
    VALUES (@deckId, @url, @name, @linkText, @category, @position, @seenAt, 1)
    ON CONFLICT(deck_id) DO UPDATE SET
      url                   = excluded.url,
      link_text             = excluded.link_text,
      category              = excluded.category,
      position              = excluded.position,
      last_seen_on_linktree = excluded.last_seen_on_linktree,
      -- A deck that reappears on Linktree is reactivated; its name is left to
      -- the deck-page scrape, which is authoritative.
      active                = 1,
      inactive_reason       = NULL
  `);

  db.transaction(() => {
    for (const l of links) {
      stmt.run({
        deckId: l.deckId,
        url: l.url,
        // Placeholder until the deck page is scraped; ON CONFLICT leaves the
        // real title untouched for decks we already know.
        name: l.linkText || l.deckId,
        linkText: l.linkText,
        category: l.category,
        position: l.position,
        seenAt,
      });
    }
  })();

  return {
    newDeckIds: links.filter((l) => !priorState.has(l.deckId)).map((l) => l.deckId),
    reactivatedDeckIds: links
      .filter((l) => priorState.get(l.deckId) === 0)
      .map((l) => l.deckId),
  };
}

/**
 * Store a freshly scraped deck. The deck's card rows are deleted and re-inserted
 * inside one transaction, so search always reflects the latest scrape rather
 * than an accumulation of past ones.
 *
 * Returns whether the card list differs from what was stored before.
 */
export function saveDeckSnapshot(deck: DeckSnapshot): { changed: boolean; cardCount: number } {
  const db = getDb();
  const scrapedAt = nowIso();
  const hash = hashCards(deck);
  const parsedCount = deck.cards.reduce((n, c) => n + c.quantity, 0);

  const prev = db.prepare('SELECT cards_hash FROM decks WHERE deck_id = ?').get(deck.deckId) as
    | { cards_hash: string | null }
    | undefined;
  const changed = prev?.cards_hash !== undefined && prev.cards_hash !== null && prev.cards_hash !== hash;

  const insertCard = db.prepare(`
    INSERT INTO deck_cards (deck_id, internal_id, card_name, card_name_norm, quantity, foil,
                            set_name, set_id, collector_number, rarity, type_name, mana_value, scraped_at)
    VALUES (@deckId, @internalId, @name, @nameNorm, @quantity, @foil,
            @setName, @setId, @collectorNumber, @rarity, @typeName, @manaValue, @scrapedAt)
  `);

  const updateDeck = db.prepare(`
    UPDATE decks SET
      name                = @name,
      url                 = @url,
      last_scraped_at     = @scrapedAt,
      deck_updated_at     = @deckUpdatedAt,
      declared_card_count = @declaredCount,
      parsed_card_count   = @parsedCount,
      cards_hash          = @hash,
      active              = 1,
      inactive_reason     = NULL
    WHERE deck_id = @deckId
  `);

  db.transaction(() => {
    // Replace, never accumulate.
    db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(deck.deckId);
    for (const c of deck.cards) {
      insertCard.run({
        deckId: deck.deckId,
        internalId: c.internalId,
        name: c.name,
        nameNorm: normalizeCardName(c.name),
        quantity: c.quantity,
        foil: c.foil ? 1 : 0,
        setName: c.setName,
        setId: c.setId,
        collectorNumber: c.collectorNumber,
        rarity: c.rarity,
        typeName: c.typeName,
        manaValue: c.manaValue,
        scrapedAt: scrapedAt,
      });
    }
    updateDeck.run({
      deckId: deck.deckId,
      name: deck.name,
      url: deck.url,
      scrapedAt,
      deckUpdatedAt: deck.lastUpdated,
      declaredCount: deck.declaredCardCount,
      parsedCount,
      hash,
    });
  })();

  return { changed, cardCount: parsedCount };
}

/**
 * Deactivate a deck and drop its cards, so a removed or dead deck stops showing
 * up in search results immediately.
 */
export function deactivateDeck(deckId: string, reason: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(deckId);
    db.prepare(
      'UPDATE decks SET active = 0, inactive_reason = ?, cards_hash = NULL WHERE deck_id = ?',
    ).run(reason, deckId);
  })();
}

/** Active deck ids that the latest Linktree scrape did not list. */
export function findDecksMissingFromLinktree(currentIds: string[]): string[] {
  const db = getDb();
  const all = db
    .prepare('SELECT deck_id FROM decks WHERE active = 1')
    .all()
    .map((r) => (r as { deck_id: string }).deck_id);
  const present = new Set(currentIds);
  return all.filter((id) => !present.has(id));
}

/* ------------------------------------------------------------------ *
 * Run bookkeeping
 * ------------------------------------------------------------------ */

/**
 * Mark runs still flagged 'running' as interrupted. A process killed mid-refresh
 * leaves its row open forever otherwise, which makes the run history misleading.
 * Safe to call on boot because runRefresh() guards against concurrent runs
 * within a process, and two processes sharing one database is not a supported
 * deployment.
 */
export function reconcileInterruptedRuns(): number {
  const res = getDb()
    .prepare(
      `UPDATE scrape_runs SET status = 'interrupted', finished_at = ?,
              notes = COALESCE(notes, 'process exited before the run completed')
        WHERE status = 'running'`,
    )
    .run(nowIso());
  return res.changes;
}

export function startRun(): number {
  const db = getDb();
  return Number(db.prepare('INSERT INTO scrape_runs (started_at) VALUES (?)').run(nowIso()).lastInsertRowid);
}

export interface RunTotals {
  decksFound: number;
  decksAdded: number;
  decksRemoved: number;
  decksChanged: number;
  decksFailed: number;
  cardsTotal: number;
}

export function finishRun(runId: number, status: string, t: RunTotals, notes?: string): void {
  getDb()
    .prepare(
      `UPDATE scrape_runs SET finished_at = ?, status = ?, decks_found = ?, decks_added = ?,
         decks_removed = ?, decks_changed = ?, decks_failed = ?, cards_total = ?, notes = ?
       WHERE id = ?`,
    )
    .run(nowIso(), status, t.decksFound, t.decksAdded, t.decksRemoved, t.decksChanged,
         t.decksFailed, t.cardsTotal, notes ?? null, runId);
}

export function recordChange(runId: number, deckId: string, changeType: string, detail?: string): void {
  getDb()
    .prepare(
      'INSERT INTO deck_changes (run_id, deck_id, change_type, detail, created_at) VALUES (?,?,?,?,?)',
    )
    .run(runId, deckId, changeType, detail ?? null, nowIso());
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export interface SearchHit {
  cardName: string;
  quantity: number;
  foil: boolean;
  setName: string | null;
  setId: string | null;
  collectorNumber: string | null;
  rarity: string | null;
  typeName: string | null;
  deckId: string;
  deckName: string;
  deckUrl: string;
  category: string | null;
  deckUpdatedAt: string | null;
  lastScrapedAt: string | null;
}

/**
 * Case- and accent-insensitive substring search over active decks.
 *
 * Ordering puts exact name matches first, then prefix matches, then the rest,
 * so searching "Bolt" surfaces "Bolt" above "Lightning Bolt Strike".
 */
export function searchCards(query: string, limit = 200): SearchHit[] {
  const q = normalizeCardName(query);
  if (!q) return [];

  const rows = getDb()
    .prepare(
      `SELECT c.card_name, c.quantity, c.foil, c.set_name, c.set_id, c.collector_number,
              c.rarity, c.type_name,
              d.deck_id, d.name AS deck_name, d.url AS deck_url, d.category,
              d.deck_updated_at, d.last_scraped_at
         FROM deck_cards c
         JOIN decks d ON d.deck_id = c.deck_id
        WHERE d.active = 1
          AND c.card_name_norm LIKE '%' || @q || '%'
        ORDER BY
          CASE WHEN c.card_name_norm = @q THEN 0
               WHEN c.card_name_norm LIKE @q || '%' THEN 1
               ELSE 2 END,
          c.card_name COLLATE NOCASE,
          d.position
        LIMIT @limit`,
    )
    .all({ q, limit }) as Record<string, any>[];

  return rows.map((r) => ({
    cardName: r['card_name'],
    quantity: r['quantity'],
    foil: !!r['foil'],
    setName: r['set_name'],
    setId: r['set_id'],
    collectorNumber: r['collector_number'],
    rarity: r['rarity'],
    typeName: r['type_name'],
    deckId: r['deck_id'],
    deckName: r['deck_name'],
    deckUrl: r['deck_url'],
    category: r['category'],
    deckUpdatedAt: r['deck_updated_at'],
    lastScrapedAt: r['last_scraped_at'],
  }));
}

/** Distinct card-name suggestions, for typeahead. */
export function suggestCardNames(query: string, limit = 10): string[] {
  const q = normalizeCardName(query);
  if (!q) return [];
  return getDb()
    .prepare(
      `SELECT c.card_name, MIN(CASE WHEN c.card_name_norm LIKE @q || '%' THEN 0 ELSE 1 END) AS rank
         FROM deck_cards c JOIN decks d ON d.deck_id = c.deck_id
        WHERE d.active = 1 AND c.card_name_norm LIKE '%' || @q || '%'
        GROUP BY c.card_name
        ORDER BY rank, c.card_name COLLATE NOCASE
        LIMIT @limit`,
    )
    .all({ q, limit })
    .map((r) => (r as { card_name: string }).card_name);
}

export function getStats() {
  const db = getDb();
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  return {
    ...one<{ activeDecks: number; inactiveDecks: number }>(
      `SELECT SUM(active = 1) AS activeDecks, SUM(active = 0) AS inactiveDecks FROM decks`,
    ),
    ...one<{ cardEntries: number; totalCards: number; uniqueNames: number }>(
      `SELECT COUNT(*) AS cardEntries, COALESCE(SUM(quantity),0) AS totalCards,
              COUNT(DISTINCT card_name) AS uniqueNames FROM deck_cards`,
    ),
    lastRun: db
      .prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined,
  };
}
