import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LinktreeDeckLink } from './scrapers/linktree.js';
import { log } from './logger.js';

/**
 * The deck list, read from a file rather than fetched.
 *
 * linktr.ee's robots.txt refuses every unnamed agent (`User-agent: *` ->
 * `Disallow: /`), and in September 2026 it began enforcing that with HTTP 406
 * to datacentre traffic. So the build no longer fetches that page from
 * anywhere, and deck discovery is a human step: a person opens the public
 * profile in their own browser, saves it, and `npm run decks:update` runs the
 * saved HTML through the same `parseLinktree()` the scraper always used.
 *
 * manabox.app is the opposite case -- its robots.txt is `Disallow:` with an
 * empty value, permitting everything -- so the per-deck card data is still
 * fetched on every build. Only discovery moved.
 *
 * The practical consequence is that this list goes stale rather than wrong:
 * decks it knows about keep updating, and a deck added since the last capture
 * is simply invisible until someone refreshes it.
 */

/** A deck link plus the discount resolved when the list was captured. */
export interface DeckListEntry extends LinktreeDeckLink {
  /** Percentage off, resolved at capture time by `deckDiscount()`. */
  discount: number | null;
}

export interface DeckList {
  /** ISO date the profile page was saved. Drives the staleness warning. */
  capturedAt: string;
  /** The page the list was read from, for provenance. */
  source: string;
  decks: DeckListEntry[];
}

/** Days after which the build says out loud that the list needs refreshing. */
export const STALE_AFTER_DAYS = 30;

export const DECK_LIST_PATH = 'decks.json';

/** Whole days between a capture date and now. Negative dates read as 0. */
export function ageInDays(capturedAt: string, now = new Date()): number {
  const then = Date.parse(capturedAt);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * Parse and validate a deck list.
 *
 * Throws rather than returning a partial list: publishing an index built from
 * half a deck list would silently drop decks from the site, which is the
 * failure this whole file exists to avoid.
 */
export function parseDeckList(json: string): DeckList {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`deck list is not valid JSON: ${String(err)}`);
  }

  const list = raw as Partial<DeckList>;
  if (!Array.isArray(list?.decks)) throw new Error('deck list has no "decks" array');
  if (list.decks.length === 0) throw new Error('deck list is empty');

  for (const [i, d] of list.decks.entries()) {
    if (!d?.deckId || typeof d.deckId !== 'string') {
      throw new Error(`deck list entry ${i} has no deckId`);
    }
    if (!d.url || typeof d.url !== 'string') {
      throw new Error(`deck list entry ${i} (${d.deckId}) has no url`);
    }
  }

  const seen = new Set<string>();
  for (const d of list.decks) {
    if (seen.has(d.deckId)) throw new Error(`deck list has a duplicate deckId: ${d.deckId}`);
    seen.add(d.deckId);
  }

  return {
    capturedAt: typeof list.capturedAt === 'string' ? list.capturedAt : '',
    source: typeof list.source === 'string' ? list.source : '',
    decks: list.decks as DeckListEntry[],
  };
}

/**
 * Read the deck list from disk, warning when it is old.
 *
 * @param root repository root
 */
export function loadDeckList(root: string, now = new Date()): DeckList {
  const path = resolve(root, DECK_LIST_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `${DECK_LIST_PATH} not found. Save the seller's Linktree page from your ` +
      `browser and run: npm run decks:update -- <saved-page.html>`,
    );
  }

  const list = parseDeckList(readFileSync(path, 'utf8'));
  const age = ageInDays(list.capturedAt, now);

  log.info(`deck list loaded`, {
    decks: list.decks.length,
    capturedAt: list.capturedAt || '(unknown)',
    ageInDays: Number.isFinite(age) ? age : '(unknown)',
  });

  // Said out loud rather than silently tolerated: a list nobody refreshes stops
  // finding new decks, and the build would otherwise look entirely healthy.
  if (age >= STALE_AFTER_DAYS) {
    log.warn(
      `deck list is ${Number.isFinite(age) ? `${age} days` : 'of unknown age'} -- ` +
      `new decks will be missing until it is refreshed`,
      { capturedAt: list.capturedAt || '(unknown)' },
    );
  }

  return list;
}
