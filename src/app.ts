import express, { type Express } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './logger.js';
import { getDb } from './db/index.js';
import { searchCards, suggestCardNames, getStats } from './db/repo.js';
import { groupByDeck } from './api/search.js';
import { logSearch, logDeckClick, getMetrics, visitorHash } from './db/metrics.js';
import { runRefresh, getRefreshStatus, isRefreshRunning } from './jobs/refresh.js';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

/** Clamp a user-supplied limit into a sane range. */
const clampLimit = (raw: unknown, def: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

/**
 * Seams for the refresh controls. Defaults are the real implementation; tests
 * override them so the endpoints can be exercised without hitting the network.
 */
export interface AppDeps {
  startRefresh: () => void;
  isRefreshRunning: () => boolean;
  getRefreshStatus: () => unknown;
}

const defaultDeps: AppDeps = {
  startRefresh: () => {
    void runRefresh().catch((err) => log.error('manual refresh threw', { err: String(err) }));
  },
  isRefreshRunning,
  getRefreshStatus,
};

/**
 * Build the HTTP app. Kept separate from server.ts so tests can mount the API
 * without starting a real refresh.
 */
export function createApp(deps: Partial<AppDeps> = {}): Express {
  const { startRefresh, isRefreshRunning: isRunning, getRefreshStatus: getStatus } = {
    ...defaultDeps,
    ...deps,
  };
  const app = express();
  app.use(express.json());
  // Behind Fly/Render the client address arrives in X-Forwarded-For. It is only
  // ever hashed, never stored, but it has to be read correctly to be useful.
  app.set('trust proxy', true);

  /** Per-day pseudonym for the caller. See db/metrics.ts for what this is not. */
  const who = (req: import('express').Request) => {
    try {
      return visitorHash(req.ip, req.get('user-agent'));
    } catch {
      return null; // metrics must never break a request
    }
  };

  /**
   * Gate for surfaces that are not for the public: the update trigger and the
   * stats page. Open when no token is configured, which is the local default.
   */
  const authorised = (req: import('express').Request) => {
    if (!config.refreshToken) return true;
    const supplied = req.get('x-refresh-token') ?? String(req.query['token'] ?? '');
    return supplied === config.refreshToken;
  };

  app.get('/api/search', (req, res) => {
    const q = String(req.query['q'] ?? '').trim();
    if (!q) {
      return res.json({ query: '', deckCount: 0, hitCount: 0, totalCopies: 0, decks: [] });
    }

    // The row limit is generous because results are grouped by deck afterwards;
    // a popular staple can legitimately appear in most of the decks.
    const hits = searchCards(q, clampLimit(req.query['limit'], 1000, 5000));
    const decks = groupByDeck(hits);

    const totalCopies = hits.reduce((n, h) => n + h.quantity, 0);

    try {
      logSearch(q, { resultDecks: decks.length, resultEntries: hits.length, totalCopies }, who(req));
    } catch (err) {
      // Never let bookkeeping take down the thing people came for.
      log.warn('failed to log search', { err: String(err) });
    }

    res.json({ query: q, deckCount: decks.length, hitCount: hits.length, totalCopies, decks });
  });

  /** Beacon fired when a visitor opens a deck on ManaBox. */
  app.post('/api/track/click', (req, res) => {
    const { deckId, cardName, query } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof deckId === 'string' && deckId) {
      try {
        logDeckClick(
          deckId,
          typeof cardName === 'string' ? cardName.slice(0, 200) : null,
          typeof query === 'string' ? query.slice(0, 200) : null,
          who(req),
        );
      } catch (err) {
        log.warn('failed to log deck click', { err: String(err) });
      }
    }
    res.status(204).end();
  });

  app.get('/api/metrics', (req, res) => {
    if (!authorised(req)) {
      return res.status(401).json({ error: 'invalid or missing token' });
    }
    const days = clampLimit(req.query['days'], 30, 365);
    res.json(getMetrics(days));
  });

  app.get('/api/suggest', (req, res) => {
    const q = String(req.query['q'] ?? '').trim();
    res.json(q ? suggestCardNames(q, clampLimit(req.query['limit'], 10, 25)) : []);
  });

  app.get('/api/stats', (_req, res) =>
    res.json({ ...getStats(), refreshRequiresToken: Boolean(config.refreshToken) }));

  app.get('/api/decks', (_req, res) => {
    res.json(
      getDb()
        .prepare(
          `SELECT deck_id, name, url, category, position, deck_updated_at, last_scraped_at,
                  parsed_card_count
             FROM decks WHERE active = 1 ORDER BY position`,
        )
        .all(),
    );
  });

  /** Recent additions, removals, and content changes -- the seller's activity feed. */
  app.get('/api/changes', (req, res) => {
    res.json(
      getDb()
        .prepare(
          `SELECT ch.change_type, ch.detail, ch.created_at, ch.deck_id,
                  d.name AS deck_name, d.url AS deck_url
             FROM deck_changes ch
             LEFT JOIN decks d ON d.deck_id = ch.deck_id
            ORDER BY ch.id DESC LIMIT ?`,
        )
        .all(clampLimit(req.query['limit'], 50, 500)),
    );
  });

  /**
   * Start a refresh. Returns immediately -- a full run takes a couple of minutes,
   * so the client polls /api/refresh/status for progress rather than waiting.
   */
  app.post('/api/refresh', (req, res) => {
    if (!authorised(req)) {
      return res.status(401).json({ started: false, reason: 'invalid or missing refresh token' });
    }
    if (isRunning()) {
      return res.status(409).json({ started: false, reason: 'a refresh is already running' });
    }
    startRefresh();
    res.status(202).json({ started: true });
  });

  app.get('/api/refresh/status', (_req, res) => res.json(getStatus()));

  /**
   * Liveness. Always 200 while the process can serve, including before the
   * first update -- an empty index is a normal starting state, not a fault.
   * Platform health checks must point here, or a fresh deploy restart-loops.
   */
  app.get('/healthz', (_req, res) => {
    const s = getStats();
    res.json({ ok: true, hasData: (s.activeDecks ?? 0) > 0, ...s });
  });

  /** Readiness: 200 only once there is data to search. For monitoring. */
  app.get('/readyz', (_req, res) => {
    const s = getStats();
    const ready = (s.activeDecks ?? 0) > 0 && (s.cardEntries ?? 0) > 0;
    res.status(ready ? 200 : 503).json({ ready, ...s });
  });

  app.use(express.static(publicDir));
  return app;
}
