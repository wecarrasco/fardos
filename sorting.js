/**
 * Ordering a result set.
 *
 * Search returns cards in match order, which is right when you are still
 * finding the card and useless once you have found it. With fifty copies of a
 * staple spread over ten decks, the question stops being "which decks have
 * this" and becomes "where is it cheapest" -- and that is a different order.
 *
 * Sorting is deliberately kept apart from the discounts. Multiplying a
 * third-party reference price by the seller's percentage off would produce a
 * number that is neither: it assumes this shop prices against that vendor,
 * which nothing here establishes. Discount is offered as its own order instead,
 * so the two facts stay side by side rather than blended into a fiction.
 */

import { cardPrice } from './prices.js';

/**
 * @typedef {import('./search.js').IndexCard} IndexCard
 * @typedef {import('./search.js').DeckHits} DeckHits
 * @typedef {import('./prices.js').PriceSource} PriceSource
 * @typedef {{decks: DeckHits[]}} Sortable
 * @typedef {'match'|'priceAsc'|'priceDesc'|'discount'} Sort
 */

/** The order search itself produced. */
export const DEFAULT_SORT = 'match';

/** @type {Record<Sort, string>} */
export const SORT_LABELS = {
  match: 'Best match',
  priceAsc: 'Cheapest first',
  priceDesc: 'Most valuable first',
  discount: 'Biggest discount first',
};

/** Orders that need a price to mean anything. */
const PRICE_SORTS = new Set(['priceAsc', 'priceDesc']);

/** @param {string} sort */
export const isSorted = (sort) => sort !== DEFAULT_SORT && sort in SORT_LABELS;

/**
 * Which orders this result set can actually offer.
 *
 * A price order with no prices behind it would silently do nothing, so it is
 * not offered at all -- the same rule the filter bar follows.
 *
 * @param {Sortable|null|undefined} result
 * @param {PriceSource|null} [source]
 * @returns {Sort[]}
 */
export function availableSorts(result, source) {
  const decks = result?.decks ?? [];
  const hasPrice = decks.some((d) => d.cards.some((c) => cardPrice(c, source) !== null));
  const hasDiscount = decks.some((d) => d.discount);
  // Two decks at the same discount are already in that order; offering it would
  // reorder nothing.
  const discountVaries = new Set(decks.map((d) => d.discount ?? 0)).size > 1;

  return /** @type {Sort[]} */ ([
    'match',
    ...(hasPrice ? ['priceAsc', 'priceDesc'] : []),
    ...(hasDiscount && discountVaries ? ['discount'] : []),
  ]);
}

/**
 * Fall back to match order when the chosen one cannot be honoured, so a stale
 * choice never leaves the results in an order nobody asked for.
 *
 * @param {string} sort
 * @param {Sort[]} available
 * @returns {Sort}
 */
export const pruneSort = (sort, available) =>
  available.includes(/** @type {Sort} */ (sort)) ? /** @type {Sort} */ (sort) : DEFAULT_SORT;

/**
 * Reorder cards within each deck, and the decks by their best card.
 *
 * A card the vendor does not price sorts last whichever way the list runs. An
 * unknown price is not a cheap one and not an expensive one, so it must not
 * lead either direction.
 *
 * @template {Sortable} T
 * @param {T} result
 * @param {string} sort
 * @param {PriceSource|null} [source]
 * @returns {T}
 */
export function sortResult(result, sort, source) {
  if (!result?.decks || !isSorted(sort)) return result;

  if (sort === 'discount') {
    // A deck-level fact, so only the groups move; the cards inside keep the
    // order the search gave them.
    return { ...result, decks: [...result.decks].sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0)) };
  }
  if (!PRICE_SORTS.has(sort)) return result;

  const dir = sort === 'priceDesc' ? -1 : 1;

  const byPrice = (a, b) => {
    const pa = cardPrice(a, source);
    const pb = cardPrice(b, source);
    if (pa === null && pb === null) return a.name.localeCompare(b.name);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return (pa - pb) * dir || a.name.localeCompare(b.name);
  };

  const decks = result.decks.map((deck) => ({ ...deck, cards: [...deck.cards].sort(byPrice) }));

  // A deck is worth as much as the card you would come for: its cheapest when
  // hunting cheap, its dearest when hunting value. Reduced rather than spread,
  // since browsing a whole deck can hand this a thousand cards.
  const deckKey = (deck) => {
    let best = null;
    for (const c of deck.cards) {
      const p = cardPrice(c, source);
      if (p === null) continue;
      if (best === null) best = p;
      else best = dir === 1 ? Math.min(best, p) : Math.max(best, p);
    }
    return best;
  };

  const keys = new Map(decks.map((d) => [d, deckKey(d)]));
  decks.sort((a, b) => {
    const ka = keys.get(a);
    const kb = keys.get(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return (ka - kb) * dir;
  });

  return { ...result, decks };
}
