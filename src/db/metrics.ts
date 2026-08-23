import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './index.js';
import { normalizeCardName } from './normalize.js';

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Anonymous visitor identity
 * ------------------------------------------------------------------ */

/**
 * A random salt generated once per installation and kept in the database, so
 * visitor hashes cannot be reproduced by anyone who does not have the file --
 * and so they stay stable across restarts.
 */
function installSalt(): string {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'visitor_salt'`).get() as
    | { value: string }
    | undefined;
  if (row) return row.value;

  const salt = randomBytes(32).toString('hex');
  db.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('visitor_salt', ?)`).run(salt);
  return salt;
}

/**
 * Derive a per-day pseudonym from request metadata. The inputs are hashed and
 * truncated, and the day is part of the digest, so the value distinguishes
 * visitors within a day and cannot be linked across days or back to an IP.
 */
export function visitorHash(ip: string | undefined, userAgent: string | undefined): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256')
    .update(`${installSalt()}|${day}|${ip ?? ''}|${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

export interface SearchOutcome {
  resultDecks: number;
  resultEntries: number;
  totalCopies: number;
}

/**
 * Record a search.
 *
 * Live search fires as the visitor types, so "s", "so", "sol" and "sol ring"
 * would all be logged. When the previous search from the same visitor was a
 * prefix of this one and happened moments ago, that row is rewritten instead of
 * a new one being added -- the log converges on what they actually meant.
 */
export function logSearch(
  query: string,
  outcome: SearchOutcome,
  visitor: string | null,
): void {
  const db = getDb();
  const norm = normalizeCardName(query);
  if (!norm) return;

  const cutoff = new Date(Date.now() - 10_000).toISOString();
  const prev = visitor
    ? (db
        .prepare(
          `SELECT id, query_norm FROM search_log
            WHERE visitor = ? AND created_at >= ?
            ORDER BY id DESC LIMIT 1`,
        )
        .get(visitor, cutoff) as { id: number; query_norm: string } | undefined)
    : undefined;

  const isRefinement = prev && (norm.startsWith(prev.query_norm) || prev.query_norm.startsWith(norm));

  if (isRefinement) {
    db.prepare(
      `UPDATE search_log
          SET query = ?, query_norm = ?, result_decks = ?, result_entries = ?,
              total_copies = ?, created_at = ?
        WHERE id = ?`,
    ).run(query, norm, outcome.resultDecks, outcome.resultEntries, outcome.totalCopies,
          nowIso(), prev.id);
    return;
  }

  db.prepare(
    `INSERT INTO search_log (query, query_norm, result_decks, result_entries,
                             total_copies, visitor, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(query, norm, outcome.resultDecks, outcome.resultEntries, outcome.totalCopies,
        visitor, nowIso());
}

export function logDeckClick(
  deckId: string,
  cardName: string | null,
  query: string | null,
  visitor: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO deck_click (deck_id, card_name, query, visitor, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(deckId, cardName, query, visitor, nowIso());
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Everything the /stats page shows, in one query pass.
 *
 * Split into four groups: what people looked for, what they could not find,
 * what is actually in stock, and how the scraper has been behaving.
 */
export function getMetrics(days = 30) {
  const db = getDb();
  const since = daysAgo(days);
  const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;

  return {
    windowDays: days,

    /* ---- Activity ------------------------------------------------ */
    activity: {
      ...one<{ searches: number; uniqueQueries: number; visitors: number }>(
        `SELECT COUNT(*) AS searches,
                COUNT(DISTINCT query_norm) AS uniqueQueries,
                COUNT(DISTINCT visitor) AS visitors
           FROM search_log WHERE created_at >= ?`,
        since,
      ),
      ...one<{ searchesToday: number; visitorsToday: number }>(
        `SELECT COUNT(*) AS searchesToday, COUNT(DISTINCT visitor) AS visitorsToday
           FROM search_log WHERE created_at >= ?`,
        new Date().toISOString().slice(0, 10),
      ),
      ...one<{ clicks: number }>(
        `SELECT COUNT(*) AS clicks FROM deck_click WHERE created_at >= ?`,
        since,
      ),
      ...one<{ missRate: number | null }>(
        `SELECT ROUND(100.0 * SUM(result_decks = 0) / NULLIF(COUNT(*), 0), 1) AS missRate
           FROM search_log WHERE created_at >= ?`,
        since,
      ),
    },

    /** Searches per day, oldest first, for the sparkline. */
    perDay: all<{ day: string; searches: number; visitors: number; misses: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS searches,
              COUNT(DISTINCT visitor) AS visitors,
              SUM(result_decks = 0) AS misses
         FROM search_log WHERE created_at >= ?
        GROUP BY day ORDER BY day`,
      daysAgo(Math.min(days, 30)),
    ),

    /** Busiest hours, to hint when the seller should post updates. */
    perHour: all<{ hour: string; searches: number }>(
      `SELECT substr(created_at, 12, 2) AS hour, COUNT(*) AS searches
         FROM search_log WHERE created_at >= ?
        GROUP BY hour ORDER BY hour`,
      since,
    ),

    /* ---- Demand -------------------------------------------------- */
    topSearches: all<{ query: string; searches: number; avgDecks: number; misses: number }>(
      `SELECT query_norm AS query, COUNT(*) AS searches,
              ROUND(AVG(result_decks), 1) AS avgDecks,
              SUM(result_decks = 0) AS misses
         FROM search_log WHERE created_at >= ?
        GROUP BY query_norm ORDER BY searches DESC, query LIMIT 25`,
      since,
    ),

    /** The restock list: searched for, not stocked. */
    missedSearches: all<{ query: string; searches: number; lastSeen: string }>(
      `SELECT query_norm AS query, COUNT(*) AS searches, MAX(created_at) AS lastSeen
         FROM search_log
        WHERE created_at >= ? AND result_decks = 0
        GROUP BY query_norm ORDER BY searches DESC, lastSeen DESC LIMIT 25`,
      since,
    ),

    topClickedDecks: all<{ deckName: string; deckUrl: string; clicks: number }>(
      `SELECT COALESCE(d.name, c.deck_id) AS deckName, d.url AS deckUrl, COUNT(*) AS clicks
         FROM deck_click c LEFT JOIN decks d ON d.deck_id = c.deck_id
        WHERE c.created_at >= ?
        GROUP BY c.deck_id ORDER BY clicks DESC LIMIT 15`,
      since,
    ),

    topClickedCards: all<{ cardName: string; clicks: number }>(
      `SELECT card_name AS cardName, COUNT(*) AS clicks
         FROM deck_click WHERE created_at >= ? AND card_name IS NOT NULL
        GROUP BY card_name ORDER BY clicks DESC LIMIT 15`,
      since,
    ),

    /* ---- Inventory (needs no logging; derived from the index) ----- */
    inventory: {
      ...one<{ decks: number; entries: number; copies: number; names: number }>(
        `SELECT (SELECT COUNT(*) FROM decks WHERE active = 1) AS decks,
                COUNT(*) AS entries, COALESCE(SUM(quantity), 0) AS copies,
                COUNT(DISTINCT card_name) AS names
           FROM deck_cards`,
      ),
      ...one<{ foilCopies: number; foilPct: number | null }>(
        `SELECT COALESCE(SUM(CASE WHEN foil THEN quantity END), 0) AS foilCopies,
                ROUND(100.0 * SUM(CASE WHEN foil THEN quantity ELSE 0 END)
                      / NULLIF(SUM(quantity), 0), 1) AS foilPct
           FROM deck_cards`,
      ),
      byRarity: all<{ rarity: string; copies: number }>(
        `SELECT COALESCE(rarity, 'Unknown') AS rarity, SUM(quantity) AS copies
           FROM deck_cards GROUP BY rarity ORDER BY copies DESC`,
      ),
      byType: all<{ typeName: string; copies: number }>(
        `SELECT COALESCE(type_name, 'Unknown') AS typeName, SUM(quantity) AS copies
           FROM deck_cards GROUP BY type_name ORDER BY copies DESC`,
      ),
      topSets: all<{ setName: string; setId: string; copies: number }>(
        `SELECT set_name AS setName, set_id AS setId, SUM(quantity) AS copies
           FROM deck_cards WHERE set_id IS NOT NULL
          GROUP BY set_id ORDER BY copies DESC LIMIT 15`,
      ),
      mostStocked: all<{ cardName: string; copies: number; decks: number }>(
        `SELECT card_name AS cardName, SUM(quantity) AS copies,
                COUNT(DISTINCT deck_id) AS decks
           FROM deck_cards GROUP BY card_name ORDER BY copies DESC LIMIT 15`,
      ),
      biggestDecks: all<{ name: string; url: string; copies: number }>(
        `SELECT name, url, parsed_card_count AS copies FROM decks
          WHERE active = 1 ORDER BY parsed_card_count DESC LIMIT 10`,
      ),
    },

    /* ---- Operations ---------------------------------------------- */
    runs: all<Record<string, unknown>>(
      `SELECT id, started_at, finished_at, status, decks_found, decks_added,
              decks_removed, decks_changed, decks_failed, cards_total
         FROM scrape_runs ORDER BY id DESC LIMIT 10`,
    ),

    recentChanges: all<Record<string, unknown>>(
      `SELECT ch.change_type, ch.detail, ch.created_at,
              COALESCE(d.name, ch.deck_id) AS deck_name, d.url AS deck_url
         FROM deck_changes ch LEFT JOIN decks d ON d.deck_id = ch.deck_id
        ORDER BY ch.id DESC LIMIT 25`,
    ),
  };
}
