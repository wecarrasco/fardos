/**
 * Pure index-diffing helpers, kept out of build-index.ts so they can be tested
 * without running a scrape.
 */
import { createHash } from 'node:crypto';

export interface DiffCard {
  name: string;
  quantity: number;
  foil: boolean;
  setId: string | null;
  collectorNumber: string | null;
  firstSeen?: string;
}

export interface DiffDeck {
  id: string;
  cards: DiffCard[];
}

export interface PreviousIndex {
  generatedAt?: string;
  decks?: DiffDeck[];
}

/**
 * Identity of a printing, catalogue-wide.
 *
 * Deliberately excludes the deck: a card the seller moves from one deck to
 * another is not new stock and must not resurface as an arrival.
 */
export const printingKey = (c: DiffCard) =>
  `${c.name}|${c.setId ?? ''}|${c.collectorNumber ?? ''}|${c.foil ? 'F' : ''}`;

/** Order-independent fingerprint of a deck's contents, for change detection. */
export function deckHash(deck: DiffDeck): string {
  const rows = deck.cards
    .map((c) => `${c.name}|${c.quantity}|${c.foil ? 1 : 0}|${c.setId ?? ''}|${c.collectorNumber ?? ''}`)
    .sort();
  return createHash('sha1').update(rows.join('\n')).digest('hex');
}

/** Deck-level change counts, for the commit message. */
export function diffDecks(decks: DiffDeck[], prev: PreviousIndex | null) {
  if (!prev?.decks) return { added: decks.length, removed: 0, changed: 0, first: true };

  const before = new Map(prev.decks.map((d) => [d.id, deckHash(d)]));
  const after = new Map(decks.map((d) => [d.id, deckHash(d)]));

  let added = 0, changed = 0;
  for (const [id, hash] of after) {
    if (!before.has(id)) added++;
    else if (before.get(id) !== hash) changed++;
  }
  const removed = [...before.keys()].filter((id) => !after.has(id)).length;
  return { added, removed, changed, first: false };
}

/**
 * Stamp each card with the date its printing first appeared in the catalogue.
 *
 * Printings already present keep the date they were given before. Printings the
 * previous index did not have are dated today -- those are the arrivals.
 *
 * On a first build nothing is dated. With no history there is no way to tell a
 * genuine arrival from a card that has been in stock for months, and announcing
 * the entire catalogue as new would be worse than announcing none of it.
 *
 * Mutates `decks` in place.
 *
 * @returns the keys of printings that arrived in this build. Returned rather
 *   than merely counted so the site can offer an exact "since the last update"
 *   window: comparing dates alone cannot separate two builds on the same day.
 */
export function stampArrivals(
  decks: DiffDeck[],
  prev: PreviousIndex | null,
  today: string,
): string[] {
  if (!prev?.decks) return [];

  const known = new Map<string, string | undefined>();
  for (const deck of prev.decks) {
    for (const card of deck.cards) {
      const key = printingKey(card);
      const seen = known.get(key);
      // Keep the earliest date when one printing sits in several decks.
      if (!known.has(key) || (card.firstSeen && (!seen || card.firstSeen < seen))) {
        known.set(key, card.firstSeen);
      }
    }
  }

  const arrived = new Set<string>();
  for (const deck of decks) {
    for (const card of deck.cards) {
      const key = printingKey(card);
      if (known.has(key)) {
        // Already in stock: carry the date forward. It may be undefined for
        // cards that predate arrival tracking, which stay undated.
        const previouslySeen = known.get(key);
        if (previouslySeen) card.firstSeen = previouslySeen;
      } else {
        card.firstSeen = today;
        arrived.add(key);
      }
    }
  }
  return [...arrived];
}
