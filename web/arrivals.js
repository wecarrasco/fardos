/**
 * "New arrivals": printings that entered the catalogue recently.
 *
 * A printing is identified catalogue-wide, not per deck, so a card the seller
 * moves between decks does not resurface as new. Cards that were already in
 * stock when arrival tracking began carry no date and are never counted --
 * "unknown", not "new".
 *
 * Results use the same shape `search()` returns so the UI can render both with
 * one code path.
 */

/**
 * @typedef {import('./search.js').IndexCard} IndexCard
 * @typedef {import('./search.js').IndexDeck} IndexDeck
 *
 * @typedef {object} ArrivalGroup
 * @property {string} deckId
 * @property {string} deckName
 * @property {string} deckUrl
 * @property {string|null} category
 * @property {string|null} deckUpdatedAt
 * @property {string|undefined} newestArrival
 * @property {number} totalQuantity
 * @property {IndexCard[]} cards
 *
 * @typedef {object} ArrivalsResult
 * @property {string|null} cutoff null for the exact-build window
 * @property {boolean} available false when the index cannot answer this window
 * @property {number} deckCount
 * @property {number} hitCount
 * @property {number} totalCopies
 * @property {number} printingCount distinct printings, so one card in two decks counts once
 * @property {ArrivalGroup[]} decks
 *
 * @typedef {object} ArrivalsIndex
 * @property {string} [generatedAt]
 * @property {string|null} [previousGeneratedAt]
 * @property {{newPrintings: string[]}} [lastUpdate] exactly what the most recent build added
 * @property {IndexDeck[]} [decks]
 */

/** Local calendar date N days ago, as YYYY-MM-DD. */
function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Earliest date that still counts as new.
 *
 * @param {ArrivalsIndex | null | undefined} index
 * @param {{days?: number, sinceLastUpdate?: boolean}} opts
 * @returns {string|null} YYYY-MM-DD, or null when there is nothing to compare against
 */
export function arrivalCutoff(index, opts = {}) {
  if (opts.sinceLastUpdate) {
    // Not a date: "the last update" is a specific build, and two builds run on
    // the same day. See lastUpdateKeys().
    return null;
  }
  return daysAgoDate(opts.days ?? 7);
}

/**
 * Printings the most recent build added, or null when the index predates this
 * field (nothing to show rather than a wrong answer).
 *
 * @param {ArrivalsIndex | null | undefined} index
 * @returns {Set<string>|null}
 */
export function lastUpdateKeys(index) {
  const keys = index?.lastUpdate?.newPrintings;
  return Array.isArray(keys) ? new Set(keys) : null;
}

/**
 * Identity of a printing, matching the key the build script writes.
 * @param {IndexCard} c
 */
export const printingKey = (c) =>
  `${c.name}|${c.setId ?? ''}|${c.collectorNumber ?? ''}|${c.foil ? 'F' : ''}`;

/**
 * @param {IndexCard} card
 * @param {string|null} cutoff
 * @returns {boolean} whether this card arrived on or after the cutoff
 */
export function isNewCard(card, cutoff) {
  return Boolean(cutoff && card.firstSeen && card.firstSeen >= cutoff);
}

/**
 * Cards that arrived on or after the cutoff, grouped by deck.
 *
 * @param {ArrivalsIndex | null | undefined} index
 * @param {{days?: number, sinceLastUpdate?: boolean, limit?: number}} [opts]
 * @returns {ArrivalsResult}
 */
export function newArrivals(index, opts = {}) {
  const cutoff = arrivalCutoff(index, opts);
  const keys = opts.sinceLastUpdate ? lastUpdateKeys(index) : null;
  const available = opts.sinceLastUpdate ? keys !== null : cutoff !== null;

  const empty = {
    cutoff, deckCount: 0, hitCount: 0, totalCopies: 0, printingCount: 0,
    available, decks: [],
  };
  if (!available || !index?.decks) return empty;

  /** Membership for the exact-build window, date range otherwise. */
  const matchesWindow = keys
    ? (c) => keys.has(printingKey(c))
    : (c) => isNewCard(c, cutoff);

  const limit = opts.limit ?? 2000;
  /** @type {ArrivalGroup[]} */
  const groups = [];
  const printings = new Set();
  let hitCount = 0;
  let totalCopies = 0;

  for (const deck of index.decks) {
    const matches = deck.cards.filter(matchesWindow);
    if (!matches.length) continue;

    // Newest first within a deck, then alphabetically for a stable order.
    matches.sort((a, b) => (b.firstSeen ?? '').localeCompare(a.firstSeen ?? '') ||
                           a.name.localeCompare(b.name));

    for (const c of matches) printings.add(printingKey(c));
    hitCount += matches.length;
    totalCopies += matches.reduce((n, c) => n + c.quantity, 0);

    groups.push({
      deckId: deck.id,
      deckName: deck.name,
      deckUrl: deck.url,
      category: deck.category,
      deckUpdatedAt: deck.updatedAt,
      newestArrival: matches[0].firstSeen,
      totalQuantity: matches.reduce((n, c) => n + c.quantity, 0),
      cards: matches.slice(0, limit),
    });

    if (hitCount >= limit) break;
  }

  // Decks with the freshest additions first.
  groups.sort((a, b) => (b.newestArrival ?? '').localeCompare(a.newestArrival ?? ''));

  return {
    cutoff,
    available,
    deckCount: groups.length,
    hitCount,
    totalCopies,
    printingCount: printings.size,
    decks: groups,
  };
}
