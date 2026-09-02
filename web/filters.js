/**
 * Narrowing a result set.
 *
 * The available options are derived from the results in hand rather than from
 * the whole catalogue, so a search for lands never offers to filter by
 * "Creature", and a control appears only when it would actually change what is
 * shown. A filter bar full of dead options is worse than no filter bar.
 */

/**
 * @typedef {import('./search.js').IndexCard} IndexCard
 * @typedef {import('./search.js').DeckHits} DeckHits
 * @typedef {{deckCount: number, hitCount: number, totalCopies: number, decks: DeckHits[]}} Narrowable
 *
 * @typedef {object} Filters
 * @property {'all'|'foil'|'nonfoil'} foil
 * @property {string|null} rarity
 * @property {string|null} typeName
 * @property {string|null} setId
 * @property {number|null} minDiscount
 */

/** @returns {Filters} */
export const emptyFilters = () => ({
  foil: 'all', rarity: null, typeName: null, setId: null, minDiscount: null,
});

/** @param {Filters} f */
export const isFiltered = (f) =>
  f.foil !== 'all' || f.rarity !== null || f.typeName !== null ||
  f.setId !== null || f.minDiscount !== null;

/**
 * Options worth offering, each with the number of matching entries.
 *
 * Counts are computed against everything the search returned, not against the
 * currently filtered view, so the numbers do not shift as choices are made.
 *
 * @param {Narrowable | null | undefined} result
 */
export function facetsFor(result) {
  const rarity = new Map();
  const typeName = new Map();
  const sets = new Map();
  const discounts = new Map();
  let foil = 0;
  let nonfoil = 0;

  const bump = (map, key, label) => {
    if (key === null || key === undefined || key === '') return;
    const row = map.get(key);
    row ? row.count++ : map.set(key, { value: key, label: label ?? String(key), count: 1 });
  };

  for (const deck of result?.decks ?? []) {
    for (const c of deck.cards) {
      c.foil ? foil++ : nonfoil++;
      bump(rarity, c.rarity);
      bump(typeName, c.typeName);
      if (c.setId) bump(sets, c.setId, c.setName ?? c.setId.toUpperCase());
      if (deck.discount) bump(discounts, deck.discount, `${deck.discount}% off`);
    }
  }

  const byCount = (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label));

  return {
    // Only worth showing when the results actually contain both.
    foil: foil > 0 && nonfoil > 0 ? { foil, nonfoil } : null,
    rarity: rarity.size > 1 ? [...rarity.values()].sort(byCount) : [],
    typeName: typeName.size > 1 ? [...typeName.values()].sort(byCount) : [],
    setId: sets.size > 1 ? [...sets.values()].sort(byCount) : [],
    discount: discounts.size > 1
      ? [...discounts.values()].sort((a, b) => Number(b.value) - Number(a.value))
      : [],
  };
}

/**
 * Apply a selection, returning the same shape with corrected totals.
 *
 * Decks left holding nothing are dropped rather than shown empty.
 *
 * @template {Narrowable} T
 * @param {T} result
 * @param {Filters} filters
 * @returns {T}
 */
export function applyFilters(result, filters) {
  if (!result?.decks || !isFiltered(filters)) return result;

  const keepsCard = (c) =>
    (filters.foil === 'all' || (filters.foil === 'foil' ? c.foil : !c.foil)) &&
    (filters.rarity === null || c.rarity === filters.rarity) &&
    (filters.typeName === null || c.typeName === filters.typeName) &&
    (filters.setId === null || c.setId === filters.setId);

  /** @type {DeckHits[]} */
  const decks = [];
  let hitCount = 0;
  let totalCopies = 0;

  for (const deck of result.decks) {
    // Discount is a property of the deck, so it removes the whole group.
    if (filters.minDiscount !== null && (deck.discount ?? 0) < filters.minDiscount) continue;

    const cards = deck.cards.filter(keepsCard);
    if (!cards.length) continue;

    const totalQuantity = cards.reduce((n, c) => n + c.quantity, 0);
    hitCount += cards.length;
    totalCopies += totalQuantity;
    decks.push({ ...deck, cards, totalQuantity });
  }

  return { ...result, decks, deckCount: decks.length, hitCount, totalCopies };
}

/**
 * Drop choices that the new results cannot satisfy, so a stale filter never
 * leaves someone staring at an empty page after changing their search.
 *
 * @param {Filters} filters
 * @param {ReturnType<typeof facetsFor>} facets
 * @returns {Filters}
 */
export function pruneFilters(filters, facets) {
  const has = (list, value) => list.some((o) => String(o.value) === String(value));
  return {
    foil: facets.foil ? filters.foil : 'all',
    rarity: filters.rarity !== null && has(facets.rarity, filters.rarity) ? filters.rarity : null,
    typeName: filters.typeName !== null && has(facets.typeName, filters.typeName) ? filters.typeName : null,
    setId: filters.setId !== null && has(facets.setId, filters.setId) ? filters.setId : null,
    minDiscount: filters.minDiscount !== null && has(facets.discount, filters.minDiscount)
      ? filters.minDiscount : null,
  };
}
