import type { SearchHit } from '../db/repo.js';

export interface DeckGroup {
  deckId: string;
  deckName: string;
  deckUrl: string;
  category: string | null;
  deckUpdatedAt: string | null;
  lastScrapedAt: string | null;
  /** Total copies of all matching cards in this deck. */
  totalQuantity: number;
  cards: Array<{
    cardName: string;
    quantity: number;
    foil: boolean;
    setName: string | null;
    setId: string | null;
    collectorNumber: string | null;
    rarity: string | null;
    typeName: string | null;
  }>;
}

/**
 * Collapse flat search hits into one entry per deck, preserving the order the
 * query returned them in (best name match first).
 */
export function groupByDeck(hits: SearchHit[]): DeckGroup[] {
  const groups = new Map<string, DeckGroup>();

  for (const h of hits) {
    let g = groups.get(h.deckId);
    if (!g) {
      g = {
        deckId: h.deckId,
        deckName: h.deckName,
        deckUrl: h.deckUrl,
        category: h.category,
        deckUpdatedAt: h.deckUpdatedAt,
        lastScrapedAt: h.lastScrapedAt,
        totalQuantity: 0,
        cards: [],
      };
      groups.set(h.deckId, g);
    }
    g.cards.push({
      cardName: h.cardName,
      quantity: h.quantity,
      foil: h.foil,
      setName: h.setName,
      setId: h.setId,
      collectorNumber: h.collectorNumber,
      rarity: h.rarity,
      typeName: h.typeName,
    });
    g.totalQuantity += h.quantity;
  }

  return [...groups.values()];
}
