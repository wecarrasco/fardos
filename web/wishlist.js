/**
 * A wishlist of cards to watch for.
 *
 * The cart's opposite. A cart line is a printing *in a particular deck*,
 * because you have chosen where to buy it. A wishlist line is a card *name* and
 * nothing more: you want the card, you do not care which deck it turns up in,
 * and most of the time it is not in any of them yet. That is the point -- the
 * wishlist is the only part of this site that can hold a card the seller does
 * not stock.
 *
 * Two questions it answers, and neither needs anything the index does not
 * already publish:
 *
 *   - Is it in stock, and where is it cheapest *right now*? `matchDecklist`
 *     already resolves a name to every deck holding it, sorted by discount, so
 *     this file matches nothing itself.
 *
 *   - Did it arrive *after* you asked for it? Every printing carries
 *     `firstSeen`, the date it entered the catalogue. Comparing that against
 *     the day the line was added is the whole mechanism: no "last visit"
 *     state, no mark-as-read, nothing to fall out of step. A card already in
 *     stock when you wished for it is not an arrival and never claims to be.
 *
 * Deliberately absent: any record of what a discount *used to be*. Deck
 * discounts come from a Linktree page robots.txt forbids fetching, so they
 * reach the index only when a human captures them. A "best discount ever"
 * built on that would miss every sale nobody captured and then state its wrong
 * answer with confidence. Only "best right now" is defensible, and it is exact.
 */

import { normalizeCardName } from './normalize.js';
import { matchDecklist } from './decklist.js';

/**
 * @typedef {object} WishLine
 * @property {string} key     normalised name, the line's identity
 * @property {string} name    as it was typed or clicked
 * @property {string} addedAt YYYY-MM-DD, the day you started waiting
 *
 * @typedef {object} WishRow
 * @property {WishLine} line
 * @property {'arrived'|'stocked'|'waiting'} state
 * @property {number} available       copies across every deck
 * @property {number|null} discount   the best on offer now, null when none is
 * @property {any} best               the deck offering it, null when not stocked
 * @property {any[]} sources          every deck holding it, best discount first
 * @property {string|null} arrivedAt  when it turned up, if after you asked
 */

export const WISHLIST_KEY = 'wishlist';

/** One entry per card, whatever its printing: the name is the identity. */
export const wishKey = (name) => normalizeCardName(name);

/** @returns {WishLine[]} */
export const emptyWishlist = () => [];

/** @param {WishLine[]} lines */
export const inWishlist = (lines, name) => {
  const key = wishKey(name);
  return (lines ?? []).some((l) => l.key === key);
};

/**
 * Add a card, or leave the list alone if it is already there.
 *
 * `addedAt` is never refreshed on a second add. It is the date the arrival
 * check measures against, and moving it forward would erase the evidence that
 * a card showed up while you were waiting.
 *
 * @param {WishLine[]} lines
 * @param {string} name
 * @param {string} today YYYY-MM-DD
 * @returns {WishLine[]} a new array; the input is untouched
 */
export function addToWishlist(lines, name, today) {
  const key = wishKey(name);
  if (!key || !/[a-z0-9]/.test(key)) return lines ?? [];
  if (inWishlist(lines, name)) return lines ?? [];
  return [...(lines ?? []), { key, name: String(name).trim(), addedAt: today }];
}

/** @param {WishLine[]} lines */
export const removeWish = (lines, key) => (lines ?? []).filter((l) => l.key !== key);

/**
 * The catalogue's own spelling of a name, or null when it has none.
 *
 * Only an exact match after normalising counts. "sol ring" becomes "Sol Ring"
 * so the list reads like the cards do, but "sol r" stays "sol r" rather than
 * being promoted to the nearest thing the seller happens to stock -- a
 * wishlist that quietly swaps in a different card is worse than one showing a
 * typo, because the typo is visible and a wrong card is not.
 *
 * @param {object} index
 * @param {string} name
 * @returns {string|null}
 */
export function catalogueName(index, name) {
  const key = wishKey(name);
  if (!key) return null;

  for (const deck of index?.decks ?? []) {
    for (const card of deck.cards) {
      if (wishKey(card.name) === key) return card.name;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Resolving against the current index
 * ------------------------------------------------------------------ */

/** The entry shape `matchDecklist` expects, for a line that names no printing. */
const asEntry = (line) => ({
  quantity: 1, name: line.name, norm: line.key,
  setId: null, collectorNumber: null, foil: false, line: 0,
});

/**
 * The newest arrival among these printings that postdates `addedAt`.
 *
 * Newest rather than oldest: if a card came, sold out and came back, the
 * interesting fact is that it is here now. Printings with no `firstSeen` --
 * cards that predate arrival tracking -- cannot be shown to have arrived after
 * anything, and are passed over rather than guessed about.
 */
function arrivedSince(sources, addedAt) {
  let newest = null;
  for (const source of sources) {
    for (const card of source.cards ?? []) {
      if (card.firstSeen && card.firstSeen > addedAt && (!newest || card.firstSeen > newest)) {
        newest = card.firstSeen;
      }
    }
  }
  return newest;
}

/** Arrivals first -- they are the news -- then what is in stock, then the wait. */
const RANK = { arrived: 0, stocked: 1, waiting: 2 };

/**
 * @param {WishLine[]} lines
 * @param {object} index
 * @returns {{rows: WishRow[], arrived: number, stocked: number, waiting: number}}
 */
export function resolveWishlist(lines, index) {
  const list = lines ?? [];
  const { matches } = matchDecklist(index ?? { decks: [] }, list.map(asEntry));

  /** @type {WishRow[]} */
  const rows = matches.map((m, i) => {
    const line = list[i];
    const arrivedAt = m.available > 0 ? arrivedSince(m.sources, line.addedAt) : null;

    return {
      line,
      state: m.available === 0 ? 'waiting' : arrivedAt ? 'arrived' : 'stocked',
      available: m.available,
      // `sources` arrives sorted by discount descending, so the head is the
      // best deal on offer -- not a figure this file computes or remembers.
      discount: m.sources[0]?.discount ?? null,
      best: m.sources[0] ?? null,
      sources: m.sources,
      arrivedAt,
    };
  });

  rows.sort((a, b) =>
    RANK[a.state] - RANK[b.state] ||
    (b.arrivedAt ?? '').localeCompare(a.arrivedAt ?? '') ||
    a.line.name.localeCompare(b.line.name));

  return {
    rows,
    arrived: rows.filter((r) => r.state === 'arrived').length,
    stocked: rows.filter((r) => r.state === 'stocked').length,
    waiting: rows.filter((r) => r.state === 'waiting').length,
  };
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * Anything unreadable is treated as an empty wishlist rather than thrown: a
 * corrupt entry must not stop the whole page from loading.
 *
 * @param {Storage} [store]
 * @returns {WishLine[]}
 */
export function loadWishlist(store = globalThis.localStorage) {
  try {
    const raw = store?.getItem(WISHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return emptyWishlist();
    return parsed.filter(
      (l) => l && typeof l.key === 'string' && l.key &&
             typeof l.name === 'string' && typeof l.addedAt === 'string',
    );
  } catch {
    return emptyWishlist();
  }
}

/** @param {WishLine[]} lines */
export function saveWishlist(lines, store = globalThis.localStorage) {
  try {
    if (!lines?.length) store?.removeItem(WISHLIST_KEY);
    else store?.setItem(WISHLIST_KEY, JSON.stringify(lines));
    return true;
  } catch {
    return false;   // private mode, or the quota is full
  }
}
