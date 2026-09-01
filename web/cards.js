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
 * @returns {{deckId: string, deckName: string, deckUrl: string, quantity: number}[]}
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
      out.push({ deckId: deck.id, deckName: deck.name, deckUrl: deck.url, quantity });
    }
  }
  return out;
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
