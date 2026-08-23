import { scrapeLinktree } from '../scrapers/linktree.js';
import { scrapeDeck } from '../scrapers/manabox.js';
import { sleep } from '../scrapers/http.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import {
  upsertLinktreeLinks,
  saveDeckSnapshot,
  deactivateDeck,
  findDecksMissingFromLinktree,
  startRun,
  finishRun,
  recordChange,
  type RunTotals,
} from '../db/repo.js';

export interface RefreshResult extends RunTotals {
  runId: number;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
}

export interface RefreshStatus {
  running: boolean;
  /** Coarse stage, so the UI can say something useful before deck counts exist. */
  phase: 'idle' | 'linktree' | 'decks' | 'done';
  decksDone: number;
  decksTotal: number;
  /** Name of the deck being fetched right now, for the progress line. */
  currentDeck: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastResult: RefreshResult | null;
  lastError: string | null;
}

/**
 * Live progress for the in-process refresh. A full run takes a couple of
 * minutes, so the UI polls this rather than waiting on the request.
 */
const status: RefreshStatus = {
  running: false,
  phase: 'idle',
  decksDone: 0,
  decksTotal: 0,
  currentDeck: null,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
};

export const getRefreshStatus = (): RefreshStatus => ({ ...status });
export const isRefreshRunning = (): boolean => status.running;

/**
 * One full refresh: re-read the Linktree page, then re-scrape every deck it
 * lists, replacing each deck's card rows.
 *
 * Guarded against overlapping runs, since a slow run could otherwise collide
 * with the next scheduled tick.
 */
export async function runRefresh(): Promise<RefreshResult> {
  if (status.running) {
    log.warn('refresh already in progress, ignoring this request');
    return { runId: -1, status: 'skipped', decksFound: 0, decksAdded: 0, decksRemoved: 0,
             decksChanged: 0, decksFailed: 0, cardsTotal: 0 };
  }

  Object.assign(status, {
    running: true,
    phase: 'linktree',
    decksDone: 0,
    decksTotal: 0,
    currentDeck: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
  } satisfies Partial<RefreshStatus>);

  const runId = startRun();
  const totals: RunTotals = { decksFound: 0, decksAdded: 0, decksRemoved: 0,
                              decksChanged: 0, decksFailed: 0, cardsTotal: 0 };
  try {
    const links = await scrapeLinktree();
    totals.decksFound = links.length;

    if (links.length === 0) {
      // Treat an empty Linktree as a scrape failure rather than as "the seller
      // deleted everything" -- wiping the index on a layout change would be far
      // worse than serving slightly stale data.
      log.anomaly('Linktree returned 0 decks -- keeping existing data untouched');
      finishRun(runId, 'failed', totals, 'linktree returned 0 decks');
      status.lastError = 'Linktree returned 0 decks; existing data was left untouched.';
      return record({ runId, status: 'failed', ...totals });
    }

    // 1. Record what Linktree lists now.
    const { newDeckIds, reactivatedDeckIds } = upsertLinktreeLinks(links);
    totals.decksAdded = newDeckIds.length;
    for (const id of newDeckIds) {
      const l = links.find((x) => x.deckId === id);
      recordChange(runId, id, 'added', l?.linkText);
      log.info(`new deck on Linktree: ${l?.linkText ?? id}`);
    }
    for (const id of reactivatedDeckIds) {
      const l = links.find((x) => x.deckId === id);
      recordChange(runId, id, 'restored', l?.linkText);
      log.info(`deck reappeared on Linktree: ${l?.linkText ?? id}`);
    }

    // 2. Retire decks that vanished from the page.
    const missing = findDecksMissingFromLinktree(links.map((l) => l.deckId));
    for (const id of missing) {
      deactivateDeck(id, 'removed from Linktree');
      recordChange(runId, id, 'removed', 'no longer listed on Linktree');
      log.info(`deck removed from Linktree: ${id}`);
    }
    totals.decksRemoved = missing.length;

    // 3. Re-scrape each deck, politely.
    status.phase = 'decks';
    status.decksTotal = links.length;

    for (const [i, l] of links.entries()) {
      if (i > 0) await sleep(config.fetchDelayMs);
      status.currentDeck = l.linkText;
      try {
        const snapshot = await scrapeDeck(l.deckId);
        if (!snapshot) {
          deactivateDeck(l.deckId, 'deck page returned 404/410');
          recordChange(runId, l.deckId, 'removed', 'deck page gone (404/410)');
          totals.decksRemoved++;
          continue;
        }
        const { changed, cardCount } = saveDeckSnapshot(snapshot);
        totals.cardsTotal += cardCount;
        if (changed) {
          totals.decksChanged++;
          recordChange(runId, l.deckId, 'cards_changed', `${cardCount} cards`);
          log.info(`deck contents changed: ${snapshot.name} (${cardCount} cards)`);
        }
      } catch (err) {
        totals.decksFailed++;
        recordChange(runId, l.deckId, 'failed', String(err));
        // A single bad deck must not abort the run.
        log.error(`failed to scrape deck ${l.deckId}`, { err: String(err) });
      } finally {
        status.decksDone = i + 1;
      }
    }

    const outcome = totals.decksFailed > 0 ? 'partial' : 'ok';
    finishRun(runId, outcome, totals);
    log.info(`refresh ${outcome}`, totals);
    return record({ runId, status: outcome, ...totals });
  } catch (err) {
    log.error('refresh failed', { err: String(err) });
    finishRun(runId, 'failed', totals, String(err));
    status.lastError = String(err);
    return record({ runId, status: 'failed', ...totals });
  } finally {
    status.running = false;
    status.phase = 'done';
    status.currentDeck = null;
    status.finishedAt = new Date().toISOString();
  }
}

/** Stash the outcome so the UI can report it after the run ends. */
function record(result: RefreshResult): RefreshResult {
  status.lastResult = result;
  return result;
}
