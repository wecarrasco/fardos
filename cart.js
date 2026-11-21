/**
 * A cart of cards to ask the seller for.
 *
 * Not a checkout. Nothing here reserves stock, takes payment, or tells the
 * seller what anything costs. It collects the cards you want so you can send
 * one message instead of typing a list out card by card.
 *
 * A line is a printing *in a particular deck*, never a card on its own. The
 * same Sol Ring sits in ten of these decks across four discount tiers, so "add
 * Sol Ring" has no answer -- which deck it comes from is half the identity, and
 * it is the half the seller needs in order to find it.
 *
 * Lines store identity and a wanted quantity and nothing else. Names, prices
 * and availability are resolved against the current index every time the cart
 * is drawn, so a rebuild that reprices a card, thins a deck or drops one is
 * reflected at once rather than remembered wrongly. A cart that quietly
 * promises stock that sold last week is worse than no cart.
 */

import { printingKey } from './cards.js';

/**
 * @typedef {import('./search.js').IndexCard} IndexCard
 * @typedef {import('./prices.js').PriceSource} PriceSource
 *
 * @typedef {object} CartLine
 * @property {string} key      deck + printing, the line's identity
 * @property {string} deckId
 * @property {string} printing printingKey of the card
 * @property {number} want     copies asked for
 * @property {string} name     kept only so a vanished card can still be named
 *
 * @typedef {object} CartItem
 * @property {CartLine} line
 * @property {IndexCard|null} card   null when the printing has left the deck
 * @property {number} want
 * @property {number} available
 * @property {'gone'|'fewer'|null} issue
 */

export const CART_KEY = 'cart';

/** One line's identity. The deck is part of it, deliberately. */
export const lineKey = (deckId, card) => `${deckId}::${printingKey(card)}`;

/** @returns {CartLine[]} */
export const emptyCart = () => [];

/** Copies in the cart, not lines: three Sol Rings are three cards. */
export const cartCount = (lines) => (lines ?? []).reduce((n, l) => n + (l.want || 0), 0);

/**
 * Add copies of a printing from one deck, capped at what that deck holds.
 *
 * Asking for more than exists would put a number in the seller's message that
 * they cannot fill, so the cap is applied here rather than apologised for
 * later.
 *
 * @param {CartLine[]} lines
 * @param {string} deckId
 * @param {IndexCard} card
 * @param {number} [delta]
 * @returns {CartLine[]} a new array; the input is untouched
 */
export function addToCart(lines, deckId, card, delta = 1) {
  const key = lineKey(deckId, card);
  const cap = Math.max(0, card?.quantity ?? 0);
  if (cap === 0) return lines ?? [];

  const found = (lines ?? []).find((l) => l.key === key);
  const want = Math.min(cap, Math.max(0, (found?.want ?? 0) + delta));

  if (want === 0) return removeLine(lines, key);
  if (found) return (lines ?? []).map((l) => (l.key === key ? { ...l, want } : l));

  return [...(lines ?? []), { key, deckId, printing: printingKey(card), want, name: card.name }];
}

/**
 * @param {CartLine[]} lines
 * @param {string} key
 * @param {number} want
 * @param {number} cap
 */
export function setQuantity(lines, key, want, cap = Infinity) {
  const n = Math.min(cap, Math.max(0, Math.floor(want) || 0));
  if (n === 0) return removeLine(lines, key);
  return (lines ?? []).map((l) => (l.key === key ? { ...l, want: n } : l));
}

/** @param {CartLine[]} lines */
export const removeLine = (lines, key) => (lines ?? []).filter((l) => l.key !== key);

/** How many of this printing, from this deck, are already in the cart. */
export const wantedFrom = (lines, deckId, card) =>
  (lines ?? []).find((l) => l.key === lineKey(deckId, card))?.want ?? 0;

/* ------------------------------------------------------------------ *
 * Reconciling against the current index
 * ------------------------------------------------------------------ */

/**
 * Match stored lines to what the catalogue holds right now.
 *
 * Nothing is silently dropped or silently reduced. A line whose deck is gone,
 * or whose printing has left that deck, comes back marked so the reader is
 * told rather than left with a shorter list than they built.
 *
 * @param {CartLine[]} lines
 * @param {{decks: any[]} | null | undefined} index
 */
export function resolveCart(lines, index) {
  const byDeck = new Map((index?.decks ?? []).map((d) => [d.id, d]));
  /** @type {Map<string, any>} */
  const groups = new Map();
  /** @type {CartItem[]} */
  const unavailable = [];

  for (const line of lines ?? []) {
    const deck = byDeck.get(line.deckId);
    const card = deck?.cards?.find((c) => printingKey(c) === line.printing) ?? null;
    const available = card?.quantity ?? 0;

    if (!deck || !card) {
      unavailable.push({ line, card: null, want: line.want, available: 0, issue: 'gone' });
      continue;
    }

    if (!groups.has(deck.id)) {
      groups.set(deck.id, {
        deckId: deck.id, deckName: deck.name, deckUrl: deck.url,
        discount: deck.discount ?? null, items: [],
      });
    }
    groups.get(deck.id).items.push({
      line, card, want: line.want, available,
      issue: line.want > available ? 'fewer' : null,
    });
  }

  const groupList = [...groups.values()];
  // Totals count what can actually be supplied. Asking for four when two remain
  // is a two-card total and a warning, never a four-card one.
  const supplied = (items) =>
    items.map((i) => ({ prices: i.card?.prices, quantity: Math.min(i.want, i.available) }));

  for (const g of groupList) g.supplied = supplied(g.items);

  return {
    groups: groupList,
    unavailable,
    supplied: groupList.flatMap((g) => g.supplied),
    copies: groupList.reduce((n, g) => n + g.items.reduce((m, i) => m + Math.min(i.want, i.available), 0), 0),
    entries: groupList.reduce((n, g) => n + g.items.length, 0),
    deckCount: groupList.length,
    shortfalls: groupList.flatMap((g) => g.items.filter((i) => i.issue === 'fewer')),
  };
}

/* ------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------ */

/**
 * The list, as plain text to send to the seller.
 *
 * Grouped by deck because that is how the seller's stock is organised: a list
 * sorted by card name would make them hunt through every deck for each line.
 *
 * Prices are left out by default. The message is a request -- "do you have
 * these?" -- and a column of third-party figures beside it reads as an offer,
 * stating what the buyer intends to pay against prices the seller never quoted.
 *
 * @param {ReturnType<typeof resolveCart>} resolved
 * @param {{includePrices?: boolean, sources?: PriceSource[], formatPrice?: Function}} [opts]
 */
export function cartMessage(resolved, opts = {}) {
  const { includePrices = false, sources = [], formatPrice } = opts;
  if (!resolved?.groups?.length) return '';

  const lines = ['Cards I\'d like:', ''];

  for (const g of resolved.groups) {
    lines.push(`${g.deckName}${g.discount ? ` (${g.discount}% off)` : ''}`);

    for (const item of g.items) {
      const c = item.card;
      const n = Math.min(item.want, item.available);
      const set = c?.setId ? ` (${c.setId.toUpperCase()})` : '';
      const cn = c?.collectorNumber ? ` #${c.collectorNumber}` : '';
      const foil = c?.foil ? ' [foil]' : '';

      let row = `  ${n}x ${item.line.name}${set}${cn}${foil}`;
      if (includePrices && formatPrice && sources.length) {
        const money = sources
          .map((s) => {
            const each = c?.prices?.[s.vendor];
            return typeof each === 'number' ? `${formatPrice(each * n, s)} ${s.label}` : null;
          })
          .filter(Boolean);
        if (money.length) row += `  --  ${money.join(' / ')}`;
      }
      lines.push(row);
    }
    lines.push('');
  }

  const { copies, deckCount } = resolved;
  lines.push(`${copies} ${copies === 1 ? 'card' : 'cards'} from ${deckCount} ${deckCount === 1 ? 'deck' : 'decks'}.`);

  if (includePrices) {
    // Said plainly inside the message itself, because once it is pasted into a
    // chat it travels without any of the page's context.
    lines.push('(Figures are market reference prices, not your prices.)');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * Anything unreadable is treated as an empty cart rather than thrown: a
 * corrupt entry must not stop the whole page from loading.
 *
 * @param {Storage} [store]
 * @returns {CartLine[]}
 */
export function loadCart(store = globalThis.localStorage) {
  try {
    const raw = store?.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return emptyCart();
    return parsed.filter(
      (l) => l && typeof l.key === 'string' && typeof l.deckId === 'string' &&
             typeof l.printing === 'string' && Number.isFinite(l.want) && l.want > 0,
    );
  } catch {
    return emptyCart();
  }
}

/** @param {CartLine[]} lines */
export function saveCart(lines, store = globalThis.localStorage) {
  try {
    if (!lines?.length) store?.removeItem(CART_KEY);
    else store?.setItem(CART_KEY, JSON.stringify(lines));
    return true;
  } catch {
    return false;   // private mode, or the quota is full
  }
}
