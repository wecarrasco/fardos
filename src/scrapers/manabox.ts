import * as cheerio from 'cheerio';
import { fetchHtml, HttpError } from './http.js';
import { log } from '../logger.js';

/**
 * Every ManaBox-specific selector lives here. Patch this block first when the
 * site's markup changes.
 */
export const MANABOX_SELECTORS = {
  /** Astro hydration wrapper; its `props` attribute holds the whole deck as JSON. */
  island: 'astro-island[props]',
  /** Fallback DOM parsing -- see the note on duplicate rows below. */
  deckTitle: 'h1',
  /**
   * Each card is rendered twice: once in a desktop wrapper and once in a mobile
   * one. Selecting only the desktop wrapper yields exactly one row per entry,
   * which is safer than deduping by card name (a deck can legitimately hold the
   * same card in two different printings).
   */
  cardRowDesktop: 'div.hidden.md\\:block',
  cardQuantity: '.text-sm.font-semibold',
  cardName: '.truncate.whitespace-nowrap',
  foilBadge: '.text-\\(--foil\\)',
} as const;

/**
 * ManaBox serialises card types as integers. Mapping established empirically
 * across all 63 decks:
 *   - 1-5 and 7 verified by matching per-type quantity totals to the rendered
 *     group headings ("Creatures 32", "Instants 33", "Lands 4", ...).
 *   - 0 identified from its members (Chandra, Vraska, Nissa, Garruk, ...).
 *   - 6 identified from its members (the "Invasion of ..." battles).
 *   - 8 is ManaBox's own catch-all; the token decks render under a group
 *     literally headed "Other", so it is reproduced rather than renamed.
 * Unknown values fall through to "Other (n)" rather than dropping the card.
 */
const CARD_TYPE_NAMES: Record<number, string> = {
  0: 'Planeswalker',
  1: 'Creature',
  2: 'Artifact',
  3: 'Instant',
  4: 'Sorcery',
  5: 'Enchantment',
  6: 'Battle',
  7: 'Land',
  8: 'Other',
};

export const cardTypeName = (t: unknown): string =>
  typeof t === 'number' ? (CARD_TYPE_NAMES[t] ?? `Other (${t})`) : 'Other';

export interface DeckCard {
  /** Stable per-deck entry id. Distinguishes two printings of the same card. */
  internalId: number | null;
  name: string;
  quantity: number;
  foil: boolean;
  setName: string | null;
  setId: string | null;
  collectorNumber: string | null;
  rarity: string | null;
  typeName: string;
  manaValue: number | null;
}

export interface DeckSnapshot {
  deckId: string;
  url: string;
  name: string;
  /** Last edit time reported by ManaBox, as an ISO string. */
  lastUpdated: string | null;
  /** Total card count declared by the page header ("108 cards"), if present. */
  declaredCardCount: number | null;
  cards: DeckCard[];
}

/* ------------------------------------------------------------------ *
 * Astro props decoding
 * ------------------------------------------------------------------ */

/**
 * Astro serialises island props as `[typeTag, value]` pairs. Tag 0 is a plain
 * value (objects nest further encoded pairs), tag 1 is an array of encoded
 * values. Other tags carry exotic types we do not use, so they decode as-is.
 */
function decodeAstroProps(node: unknown): unknown {
  if (!Array.isArray(node) || node.length === 0) return node;
  const [tag, value] = node as [number, unknown];

  if (tag === 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, decodeAstroProps(v)]),
      );
    }
    return value;
  }
  if (tag === 1 && Array.isArray(value)) return value.map(decodeAstroProps);
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pull the deck object out of whichever astro-island carries it. */
function extractDeckPayload($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const islands = $(MANABOX_SELECTORS.island).toArray();

  for (const el of islands) {
    const rawProps = $(el).attr('props');
    if (!rawProps || !rawProps.includes('"cards"')) continue;
    try {
      const decoded = decodeAstroProps([0, JSON.parse(rawProps)]) as Record<string, unknown>;
      const deck = decoded?.['deck'];
      if (deck && typeof deck === 'object' && Array.isArray((deck as any).cards)) {
        return deck as Record<string, unknown>;
      }
    } catch (err) {
      log.warn('failed to decode an astro-island props blob', { err: String(err) });
    }
  }
  return null;
}

function cardsFromPayload(deck: Record<string, unknown>): DeckCard[] {
  const raw = (deck['cards'] ?? []) as Record<string, unknown>[];
  return raw.map((c) => ({
    internalId: num(c['internalId']),
    name: str(c['name']) ?? '(unknown)',
    quantity: num(c['quantity']) ?? 0,
    // ManaBox uses variant "Foil"/"Etched" for finishes, "Normal" otherwise.
    foil: typeof c['variant'] === 'string' && c['variant'].toLowerCase() !== 'normal',
    setName: str(c['setName']),
    setId: str(c['setId']),
    collectorNumber: str(c['collectorNumber']),
    rarity: str(c['rarity']),
    typeName: cardTypeName(c['type']),
    manaValue: num(c['manaValue']),
  }));
}

/* ------------------------------------------------------------------ *
 * DOM fallback
 * ------------------------------------------------------------------ */

/**
 * Used only when the JSON payload is missing. Yields name/quantity/foil but no
 * set or rarity detail, since the rendered rows do not carry it.
 */
function cardsFromDom($: cheerio.CheerioAPI): DeckCard[] {
  const out: DeckCard[] = [];

  $(MANABOX_SELECTORS.cardRowDesktop).each((_, el) => {
    const $row = $(el);
    const qty = Number($row.find(MANABOX_SELECTORS.cardQuantity).first().text().trim());
    const name = $row.find(MANABOX_SELECTORS.cardName).first().text().trim();
    if (!name || !Number.isFinite(qty)) return;

    out.push({
      internalId: null,
      name,
      quantity: qty,
      foil: $row.find(MANABOX_SELECTORS.foilBadge).length > 0,
      setName: null,
      setId: null,
      collectorNumber: null,
      rarity: null,
      typeName: 'Unknown',
      manaValue: null,
    });
  });

  return out;
}

/* ------------------------------------------------------------------ *
 * Public parser
 * ------------------------------------------------------------------ */

/** Parse a ManaBox deck page. Pure: HTML in, snapshot out. */
export function parseDeckPage(html: string, deckId: string): DeckSnapshot {
  const $ = cheerio.load(html);
  const url = `https://manabox.app/decks/${deckId}`;

  // The header renders the authoritative total, e.g. "108 cards". Adjacent
  // elements concatenate without whitespace ("108 cards8/22/2026"), so the
  // trailing boundary is a negative lookahead for letters rather than \b.
  const declaredCardCount = (() => {
    const text = $('body').clone().find('script, style').remove().end().text();
    const m = /(\d[\d,]*)\s*cards?(?![a-z])/i.exec(text);
    return m?.[1] ? Number(m[1].replace(/,/g, '')) : null;
  })();

  const payload = extractDeckPayload($);
  let name: string;
  let lastUpdated: string | null = null;
  let cards: DeckCard[];

  if (payload) {
    name =
      str(payload['name']) ?? ($(MANABOX_SELECTORS.deckTitle).first().text().trim() || deckId);
    const edit = num(payload['editDate']);
    lastUpdated = edit ? new Date(edit).toISOString() : null;
    cards = cardsFromPayload(payload);
  } else {
    log.anomaly(`no deck JSON payload found -- falling back to DOM parsing`, { deckId });
    name = $(MANABOX_SELECTORS.deckTitle).first().text().trim() || deckId;
    cards = cardsFromDom($);
  }

  if (cards.length === 0) {
    log.anomaly(`parsed 0 cards from deck page -- layout likely changed`, { deckId, url });
  } else {
    // Cross-check the parse against the count the page states for itself. A
    // mismatch means we are dropping or double-counting rows.
    const total = cards.reduce((n, c) => n + c.quantity, 0);
    if (declaredCardCount !== null && total !== declaredCardCount) {
      log.anomaly(`card total mismatch: parsed ${total}, page declares ${declaredCardCount}`, {
        deckId,
        url,
      });
    }
  }

  return { deckId, url, name, lastUpdated, declaredCardCount, cards };
}

/** Fetch and parse one deck. Returns null when the deck is gone (404/410). */
export async function scrapeDeck(deckId: string): Promise<DeckSnapshot | null> {
  const url = `https://manabox.app/decks/${deckId}`;
  try {
    return parseDeckPage(await fetchHtml(url), deckId);
  } catch (err) {
    if (err instanceof HttpError) {
      log.warn(`deck is gone (HTTP ${err.status}), marking inactive`, { deckId });
      return null;
    }
    throw err;
  }
}
