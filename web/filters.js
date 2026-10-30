/**
 * Narrowing a result set.
 *
 * The available options are derived from the results in hand rather than from
 * the whole catalogue, so a search for lands never offers to filter by
 * "Creature", and a control appears only when it would actually change what is
 * shown. A filter bar full of dead options is worse than no filter bar.
 */

import { cardPrice } from './prices.js';

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
 * @property {number|null} maxPrice reference price ceiling, from the primary vendor
 * @property {number|null} manaValue bucket, where 7 means "7 or more"
 * @property {string[]} colours ticked colours: letters of WUBRG, and "C"
 * @property {ColourMode} colourMode how `colours` is compared to a card's own
 * @property {string|null} format a format the card must be legal in
 *
 * @typedef {'including'|'exactly'|'at-most'} ColourMode
 */

/** How ticked colours are compared when nobody has chosen. */
export const DEFAULT_COLOUR_MODE = 'including';

/** @returns {Filters} */
export const emptyFilters = () => ({
  foil: 'all', rarity: null, typeName: null, setId: null, minDiscount: null, maxPrice: null,
  manaValue: null, colours: [], colourMode: DEFAULT_COLOUR_MODE, format: null,
});

/** @param {Filters} f */
export const isFiltered = (f) =>
  f.foil !== 'all' || f.rarity !== null || f.typeName !== null ||
  f.setId !== null || f.minDiscount !== null || f.maxPrice !== null ||
  f.manaValue !== null || f.colours.length > 0 || f.format !== null;

/**
 * Mana values above six are one bucket.
 *
 * The tail is thin and nobody searching it cares whether the thing costs nine
 * or eleven -- a separate option per value would be a dozen near-empty rows.
 */
export const MANA_CAP = 7;

/** The bucket a card falls in, or null when its mana value is unknown. */
export const manaBucket = (mv) =>
  typeof mv !== 'number' || !Number.isFinite(mv) ? null : Math.min(MANA_CAP, Math.max(0, Math.floor(mv)));

export const manaLabel = (bucket) => (bucket >= MANA_CAP ? `${MANA_CAP}+` : String(bucket));

/**
 * The colour options, in the order Magic prints them.
 *
 * "C" is a real value in the index rather than the absence of one: a colourless
 * card carries "C", and a card whose identity we never learned carries nothing
 * and answers to no colour at all.
 */
export const COLOURS = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'],
  ['R', 'Red'], ['G', 'Green'], ['C', 'Colorless'],
];

/**
 * How the ticked colours are compared with a card's own.
 *
 * `including` first because it is what one tick most obviously means -- "show
 * me the blue ones" -- and because the other two only start to differ once you
 * have ticked more than one.
 */
export const COLOUR_MODES = [
  ['including', 'including these'],
  ['exactly', 'exactly these'],
  ['at-most', 'at most these'],
];

/** "pioneer" -> "Pioneer". Derived rather than tabulated, so adding a format
 * to the index needs no matching edit here. */
export const formatLabel = (f) => String(f).charAt(0).toUpperCase() + String(f).slice(1);

/** A card's colours as a set. Colourless is `['C']`, unknown is empty. */
const colourSet = (ci) => (typeof ci === 'string' && ci ? [...ci] : []);

/**
 * Is a card legal in this format?
 *
 * `formats` comes from the index rather than from here, so the bit positions
 * are always the ones the file was written with. A card with no mask is one
 * we have no legality for -- a token, or a card printed since the table was
 * refreshed -- and it fails, rather than being guessed either way.
 *
 * @param {number|undefined} lg
 * @param {string|null} format
 * @param {readonly string[]} formats
 */
export function isLegalIn(lg, format, formats) {
  if (!format) return true;
  const i = (formats ?? []).indexOf(format);
  return i >= 0 && ((lg ?? 0) & (1 << i)) !== 0;
}

/**
 * Does one card answer to this selection?
 *
 * The one special case is `at-most` and colourless. A colourless card has no
 * colours, and nothing is outside any selection, so it belongs in every "at
 * most" answer -- that is the question people are really asking, which is
 * whether a card can go in a deck of those colours, and a Sol Ring can go in
 * all of them.
 *
 * @param {string|undefined} ci
 * @param {string[]} picked
 * @param {ColourMode} mode
 */
export function matchesColours(ci, picked, mode) {
  if (!picked.length) return true;
  const own = colourSet(ci);
  // Never guess at a card we know nothing about, the same way an unpriced card
  // fails a ceiling rather than slipping under it.
  if (!own.length) return false;

  const has = (c) => own.includes(c);
  if (mode === 'exactly') return own.length === picked.length && picked.every(has);
  if (mode === 'at-most') return own.includes('C') || own.every((c) => picked.includes(c));
  return picked.every(has);   // including
}

/**
 * Ceilings worth offering. A round ladder rather than quantiles, because
 * "under $5" is a thought someone actually has and "under $4.73" is not.
 */
const PRICE_STEPS = [1, 2, 5, 10, 25, 50, 100];

/**
 * Options worth offering, each with the number of matching entries.
 *
 * Counts are computed against everything the search returned, not against the
 * currently filtered view, so the numbers do not shift as choices are made.
 *
 * @param {Narrowable | null | undefined} result
 * @param {import('./prices.js').PriceSource | null} [source] absent when the index carries no prices
 * @param {readonly string[]} [formats] the index's own legality bit order
 */
export function facetsFor(result, source, formats = []) {
  const rarity = new Map();
  const typeName = new Map();
  const sets = new Map();
  const discounts = new Map();
  const manaValues = new Map();
  const colours = new Map();
  const legalIn = new Map();
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

      const mb = manaBucket(c.mv);
      if (mb !== null) bump(manaValues, mb, manaLabel(mb));
      // A card belongs to every colour in its identity, so these counts
      // overlap by design -- a Golgari card is both black and green.
      for (const [code, label] of COLOURS) {
        if ((c.ci ?? '').includes(code)) bump(colours, code, label);
      }
      for (const f of formats) {
        if (isLegalIn(c.lg, f, formats)) bump(legalIn, f, formatLabel(f));
      }
    }
  }

  const byCount = (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label));

  // How many entries each ceiling would leave. A step that keeps everything
  // narrows nothing, and one that keeps nothing empties the page, so neither
  // is offered.
  let entries = 0;
  const prices = [];
  for (const deck of result?.decks ?? []) {
    for (const c of deck.cards) {
      entries++;
      const p = cardPrice(c, source);
      if (p !== null) prices.push(p);
    }
  }
  const maxPrice = prices.length
    ? PRICE_STEPS
        .map((step) => ({ value: step, label: `Under $${step}`, count: prices.filter((p) => p <= step).length }))
        .filter((o) => o.count > 0 && o.count < entries)
    : [];

  return {
    // Only worth showing when the results actually contain both.
    foil: foil > 0 && nonfoil > 0 ? { foil, nonfoil } : null,
    rarity: rarity.size > 1 ? [...rarity.values()].sort(byCount) : [],
    typeName: typeName.size > 1 ? [...typeName.values()].sort(byCount) : [],
    setId: sets.size > 1 ? [...sets.values()].sort(byCount) : [],
    discount: discounts.size > 1
      ? [...discounts.values()].sort((a, b) => Number(b.value) - Number(a.value))
      : [],
    // Ascending, not by count: a mana curve read out of order is unreadable.
    manaValue: manaValues.size > 1
      ? [...manaValues.values()].sort((a, b) => Number(a.value) - Number(b.value))
      : [],
    // Every colour present is offered, with no "narrows nothing" gate: once
    // there is a mode, even a colour every card shares still cuts -- "exactly
    // green" drops the green-white cards from an all-green pile. The control
    // as a whole is hidden below, when only one colour is in play.
    colour: colours.size > 1
      ? COLOURS.map(([code]) => colours.get(code)).filter(Boolean)
      : [],
    // A format everything is legal in narrows nothing, which is the ceilings'
    // rule again -- and it quietly retires Commander and Legacy from most
    // searches, where they sit above 98%.
    format: formats
      .map((f) => legalIn.get(f))
      .filter((o) => o && o.count < foil + nonfoil),
    maxPrice,
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
 * @param {import('./prices.js').PriceSource | null} [source] absent when the index carries no prices
 * @param {readonly string[]} [formats] the index's own legality bit order
 * @returns {T}
 */
export function applyFilters(result, filters, source, formats = []) {
  if (!result?.decks || !isFiltered(filters)) return result;

  // A card nobody prices is dropped by a ceiling rather than kept: an unknown
  // price is not evidence of a low one, and letting it through would put cards
  // that might cost anything under a heading that promises they do not.
  const underCeiling = (c) => {
    if (filters.maxPrice === null) return true;
    const p = cardPrice(c, source);
    return p !== null && p <= filters.maxPrice;
  };

  const keepsCard = (c) =>
    (filters.foil === 'all' || (filters.foil === 'foil' ? c.foil : !c.foil)) &&
    (filters.rarity === null || c.rarity === filters.rarity) &&
    (filters.typeName === null || c.typeName === filters.typeName) &&
    (filters.setId === null || c.setId === filters.setId) &&
    // Both drop a card whose data is missing, for the reason the ceiling does:
    // an unrecorded mana value is not a zero, and a card with no colour
    // identity recorded is not thereby colourless.
    (filters.manaValue === null || manaBucket(c.mv) === filters.manaValue) &&
    matchesColours(c.ci, filters.colours, filters.colourMode) &&
    isLegalIn(c.lg, filters.format, formats) &&
    underCeiling(c);

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
    maxPrice: filters.maxPrice !== null && has(facets.maxPrice, filters.maxPrice)
      ? filters.maxPrice : null,
    manaValue: filters.manaValue !== null && has(facets.manaValue, filters.manaValue)
      ? filters.manaValue : null,
    // Ticks the new results cannot satisfy are dropped one by one, so changing
    // the search narrows the selection rather than emptying the page.
    colours: filters.colours.filter((c) => has(facets.colour, c)),
    colourMode: filters.colourMode,
    format: filters.format !== null && has(facets.format, filters.format)
      ? filters.format : null,
  };
}
