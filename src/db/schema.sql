-- Schema is applied idempotently on every boot; see src/db/index.ts.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS decks (
  deck_id                TEXT PRIMARY KEY,          -- ManaBox deck id from the URL
  url                    TEXT NOT NULL,
  name                   TEXT NOT NULL,             -- deck title from ManaBox
  link_text              TEXT,                      -- button text on Linktree
  category               TEXT,                      -- Linktree section heading, NULL if ungrouped
  position               INTEGER,                   -- ordering on the Linktree page
  last_seen_on_linktree  TEXT,                      -- ISO ts, last refresh that saw this link
  last_scraped_at        TEXT,                      -- ISO ts, last successful deck-page parse
  deck_updated_at        TEXT,                      -- ISO ts, ManaBox's own editDate
  declared_card_count    INTEGER,                   -- "N cards" from the page header
  parsed_card_count      INTEGER,                   -- sum of quantities we stored
  cards_hash             TEXT,                      -- content hash, for cheap change detection
  active                 INTEGER NOT NULL DEFAULT 1,-- 0 once the deck 404s or leaves Linktree
  inactive_reason        TEXT
);

CREATE TABLE IF NOT EXISTS deck_cards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id           TEXT NOT NULL REFERENCES decks(deck_id) ON DELETE CASCADE,
  internal_id       INTEGER,      -- ManaBox per-deck entry id; NULL in DOM-fallback mode
  card_name         TEXT NOT NULL,
  -- Lowercased, de-accented, punctuation-flattened copy of card_name. Search
  -- matches against this so "seance" finds "Séance" and "jace beleren" finds
  -- "Jace, Beleren".
  card_name_norm    TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  foil              INTEGER NOT NULL DEFAULT 0,
  set_name          TEXT,
  set_id            TEXT,
  collector_number  TEXT,
  rarity            TEXT,
  type_name         TEXT,
  mana_value        REAL,
  scraped_at        TEXT NOT NULL
);

-- Search is a substring match over card_name_norm; this index serves the
-- prefix case and the frequent "group results by deck" lookups.
CREATE INDEX IF NOT EXISTS idx_deck_cards_norm ON deck_cards(card_name_norm);
CREATE INDEX IF NOT EXISTS idx_deck_cards_deck ON deck_cards(deck_id);

-- One row per refresh run, so anomalies have a history rather than only a log line.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
  decks_found    INTEGER DEFAULT 0,
  decks_added    INTEGER DEFAULT 0,
  decks_removed  INTEGER DEFAULT 0,
  decks_changed  INTEGER DEFAULT 0,
  decks_failed   INTEGER DEFAULT 0,
  cards_total    INTEGER DEFAULT 0,
  notes          TEXT
);

-- Individual change events, so "what did the seller do since yesterday" is queryable.
CREATE TABLE IF NOT EXISTS deck_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
  deck_id     TEXT NOT NULL,
  change_type TEXT NOT NULL,   -- added | removed | cards_changed | failed | restored
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deck_changes_run ON deck_changes(run_id);

-- ---------------------------------------------------------------------------
-- Usage metrics
--
-- Deliberately free of personal data: no IP addresses, no user agents, no
-- cookies. `visitor` is a truncated hash of (ip + user-agent + a per-install
-- salt + today's date), so it distinguishes people within a day and becomes
-- meaningless the next -- enough for "how many searched today", useless for
-- tracking anyone across time.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  query          TEXT NOT NULL,     -- as the visitor typed it
  query_norm     TEXT NOT NULL,     -- folded, so variants group together
  result_decks   INTEGER NOT NULL,
  result_entries INTEGER NOT NULL,
  total_copies   INTEGER NOT NULL,
  visitor        TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at);
CREATE INDEX IF NOT EXISTS idx_search_log_norm    ON search_log(query_norm);
CREATE INDEX IF NOT EXISTS idx_search_log_visitor ON search_log(visitor, created_at);

CREATE TABLE IF NOT EXISTS deck_click (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id    TEXT NOT NULL,
  card_name  TEXT,                  -- the card the visitor was looking at
  query      TEXT,                  -- what they had searched for
  visitor    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deck_click_created ON deck_click(created_at);
CREATE INDEX IF NOT EXISTS idx_deck_click_deck    ON deck_click(deck_id);
