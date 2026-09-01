import { normalizeCardName } from './normalize.js';

/**
 * Search the static index in the browser.
 *
 * Matching tries the query as a phrase first, then falls back to requiring every
 * word somewhere in the name. Folded card names are computed on first use and
 * cached on the card object.
 * Shipping them in the index instead would add ~57 KB to every page load to
 * save 4 ms of work, so the browser does it.
 *
 * Over ~8,700 entries a linear scan takes well under a millisecond, which is
 * why there is no inverted index here -- more code and more bytes for no
 * perceptible gain.
 */

/**
 * @typedef {object} IndexCard
 * @property {string} name
 * @property {string} [norm] populated lazily by cardNorm()
 * @property {string} [firstSeen] YYYY-MM-DD; absent when the arrival date is unknown
 * @property {number} quantity
 * @property {boolean} foil
 * @property {string|null} setName
 * @property {string|null} setId
 * @property {string|null} collectorNumber
 * @property {string|null} rarity
 * @property {string} typeName
 *
 * @typedef {object} IndexDeck
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string|null} category
 * @property {string|null} updatedAt
 * @property {number} cardCount
 * @property {IndexCard[]} cards
 *
 * @typedef {object} DeckHits
 * @property {string} deckId
 * @property {string} deckName
 * @property {string} deckUrl
 * @property {string|null} category
 * @property {string|null} deckUpdatedAt
 * @property {number} bestRank
 * @property {number} totalQuantity
 * @property {IndexCard[]} cards
 *
 * @typedef {object} SearchResult
 * @property {string} query
 * @property {number} deckCount
 * @property {number} hitCount
 * @property {number} totalCopies
 * @property {DeckHits[]} decks
 */

/**
 * @param {{decks: IndexDeck[]} | null | undefined} index
 * @param {string | null | undefined} query
 * @param {{limit?: number}} [opts]
 * @returns {SearchResult}
 */
const cardNorm = (card) => (card.norm ??= normalizeCardName(card.name));

/**
 * Rank a folded card name against a folded query.
 *
 * The whole query is tried as a phrase first, which is what most people type
 * and what gives the tightest ranking. Failing that, every word must appear
 * somewhere in the name, in any order -- so "bolt lightning" and "ancestry
 * path" find what the reader plainly meant.
 *
 * @param {string} norm folded card name
 * @param {string} q folded query
 * @param {string[]} words the query split on spaces
 * @returns {number} 0 exact, 1 phrase prefix, 2 phrase inside, 3 all words present, -1 no match
 */
export function rankMatch(norm, q, words) {
  const at = norm.indexOf(q);
  if (at === 0) return norm === q ? 0 : 1;
  if (at > 0) return 2;

  // A single word already failed as a phrase, so there is nothing else to try.
  if (words.length < 2) return -1;
  for (const w of words) if (!norm.includes(w)) return -1;
  return 3;
}

export function search(index, query, opts = {}) {
  const q = normalizeCardName(query ?? '');
  const empty = { query: query ?? '', deckCount: 0, hitCount: 0, totalCopies: 0, decks: [] };
  if (!q || !index?.decks) return empty;

  const words = q.split(' ').filter(Boolean);
  const limit = opts.limit ?? 2000;
  /** @type {DeckHits[]} */
  const groups = [];
  let hitCount = 0;
  let totalCopies = 0;

  for (const deck of index.decks) {
    /** @type {{card: IndexCard, rank: number}[] | null} */
    let matches = null;

    for (const card of deck.cards) {
      const rank = rankMatch(cardNorm(card), q, words);
      if (rank === -1) continue;

      (matches ??= []).push({ card, rank });

      hitCount++;
      totalCopies += card.quantity;
      if (hitCount >= limit) break;
    }

    if (matches) {
      matches.sort((a, b) => a.rank - b.rank || a.card.name.localeCompare(b.card.name));
      groups.push({
        deckId: deck.id,
        deckName: deck.name,
        deckUrl: deck.url,
        category: deck.category,
        deckUpdatedAt: deck.updatedAt,
        bestRank: matches[0].rank,
        totalQuantity: matches.reduce((n, m) => n + m.card.quantity, 0),
        cards: matches.map((m) => m.card),
      });
    }
    if (hitCount >= limit) break;
  }

  // Decks holding a better match float up; ties keep the seller's page order,
  // which `decks` is already in.
  groups.sort((a, b) => a.bestRank - b.bestRank);

  return { query: query ?? '', deckCount: groups.length, hitCount, totalCopies, decks: groups };
}

/**
 * Distinct card names for typeahead, prefix matches first.
 * @param {{decks: IndexDeck[]} | null | undefined} index
 * @param {string | null | undefined} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function suggest(index, query, limit = 10) {
  const q = normalizeCardName(query ?? '');
  if (!q || !index?.decks) return [];

  const words = q.split(' ').filter(Boolean);
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const deck of index.decks) {
    for (const card of deck.cards) {
      const rank = rankMatch(cardNorm(card), q, words);
      if (rank === -1) continue;
      const seen = best.get(card.name);
      if (seen === undefined || rank < seen) best.set(card.name, rank);
    }
  }

  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}
