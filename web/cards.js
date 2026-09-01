/**
 * Card-level helpers shared by the search view and the hover preview.
 */

/**
 * @typedef {import('./search.js').IndexCard} IndexCard
 * @typedef {import('./search.js').IndexDeck} IndexDeck
 */

/**
 * Identity of a printing, catalogue-wide. Matches the key the build script
 * writes, so the two views of "the same card" agree.
 *
 * @param {IndexCard} c
 */
export const printingKey = (c) =>
  `${c.name}|${c.setId ?? ''}|${c.collectorNumber ?? ''}|${c.foil ? 'F' : ''}`;

/**
 * Picture of this exact printing.
 *
 * Scryfall resolves a set code and collector number to the right image, so the
 * URL is derived rather than stored -- carrying an image id on every card would
 * add ~214 KB to a 149 KB index for something only fetched on demand.
 *
 * @param {{setId: string|null, collectorNumber: string|null}} card
 * @param {'small'|'normal'|'large'} [version]
 * @returns {string|null} null when the printing is unknown (DOM-fallback data)
 */
export function cardImageUrl(card, version = 'normal') {
  if (!card?.setId || !card?.collectorNumber) return null;
  const set = encodeURIComponent(card.setId.toLowerCase());
  const num = encodeURIComponent(card.collectorNumber);
  return `https://api.scryfall.com/cards/${set}/${num}?format=image&version=${version}`;
}

/** Link to this printing's page on Scryfall, for prices and rulings. */
export function scryfallPageUrl(card) {
  if (!card?.setId || !card?.collectorNumber) return null;
  return `https://scryfall.com/card/${encodeURIComponent(card.setId.toLowerCase())}/${encodeURIComponent(card.collectorNumber)}`;
}

/**
 * Other decks stocking the same printing.
 *
 * Answers the question the search results cannot: this deck has two, but is
 * there more of it elsewhere? Matches on the printing, so a different set or
 * finish is deliberately not counted as the same card.
 *
 * @param {{decks?: IndexDeck[]}|null|undefined} index
 * @param {IndexCard} card
 * @param {string} excludeDeckId
 * @returns {{deckId: string, deckName: string, deckUrl: string, quantity: number, discount: number|null}[]}
 */
export function otherDecksWithCard(index, card, excludeDeckId) {
  if (!index?.decks || !card) return [];
  const key = printingKey(card);
  const out = [];

  for (const deck of index.decks) {
    if (deck.id === excludeDeckId) continue;
    let quantity = 0;
    for (const c of deck.cards) if (printingKey(c) === key) quantity += c.quantity;
    if (quantity > 0) {
      out.push({
        deckId: deck.id, deckName: deck.name, deckUrl: deck.url, quantity,
        discount: deck.discount ?? null,
      });
    }
  }
  // Best discount first: the reason to look at this list at all is usually to
  // find the cheaper copy.
  out.sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1));
  return out;
}

/**
 * The same printing offered at a bigger discount somewhere else.
 *
 * The seller files a handful of decks under a section whose heading states one
 * discount while the deck's own label states another, so identical cards do sit
 * at different prices. This is what surfaces that.
 *
 * @param {{decks?: IndexDeck[]}|null|undefined} index
 * @param {IndexCard} card
 * @param {{id: string, discount?: number|null}} currentDeck
 * @returns {{deckId: string, deckName: string, deckUrl: string, quantity: number, discount: number|null}|null}
 */
export function betterDealFor(index, card, currentDeck) {
  const here = currentDeck?.discount ?? 0;
  const others = otherDecksWithCard(index, card, currentDeck?.id ?? '');
  const best = others.find((o) => (o.discount ?? 0) > here);
  return best ?? null;
}

/**
 * Every copy of this card by name, whatever the printing, across the catalogue.
 * Used for the "N copies in total" line, where a buyer cares about the card
 * rather than which set it came from.
 *
 * @returns {{copies: number, printings: number, decks: number}}
 */
export function totalsForName(index, name) {
  const printings = new Set();
  const decks = new Set();
  let copies = 0;

  for (const deck of index?.decks ?? []) {
    for (const c of deck.cards) {
      if (c.name !== name) continue;
      copies += c.quantity;
      printings.add(printingKey(c));
      decks.add(deck.id);
    }
  }
  return { copies, printings: printings.size, decks: decks.size };
}

/**
 * Section label with its discount phrase removed, for when the percentage is
 * already shown as its own badge.
 *
 * The seller writes it several ways -- "MARVEL - 10% OFF",
 * "LINKS 10% de DESCUENTO", "SAF STANDARD (10% OFF)" -- so this strips the
 * phrase and tidies whatever separator it leaves behind. If that would leave
 * nothing meaningful, the original is kept: a slightly redundant label beats an
 * empty one.
 *
 * @param {string|null} category
 * @returns {string|null}
 */
export function categoryLabel(category) {
  if (!category) return category ?? null;

  const stripped = category
    // "(20% OFF)" or "( 20 % de descuento )"
    .replace(/\(\s*\d{1,2}\s*%[^)]*\)/gi, '')
    // a trailing "20% OFF" / "20% de DESCUENTO" with no brackets
    .replace(/\d{1,2}\s*%\s*(?:off|de\s+descuento|descuento)?/gi, '')
    // whatever separator now dangles
    .replace(/[\s\u2013\u2014:,-]+$/u, '')
    .replace(/^[\s\u2013\u2014:,-]+/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return stripped.length >= 3 ? stripped : category;
}
