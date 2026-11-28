/**
 * Market reference prices.
 *
 * These come from a third-party vendor through ManaBox and say nothing about
 * what this seller charges. Everything here is named after that: `reference`,
 * not `price`, and every figure is rendered with the vendor beside it so a
 * number never appears as if it were the shop's own.
 */

/**
 * @typedef {{vendor: string, label: string, currency: string}} PriceSource
 * @typedef {{prices?: Record<string, number>, quantity?: number}} Priced
 */

/** Formatters are expensive to build, so keep one per currency. */
const formatters = new Map();

function formatterFor(currency) {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 2,
    }));
  }
  return formatters.get(currency);
}

/**
 * @param {number|null|undefined} amount
 * @param {PriceSource|null|undefined} source
 * @returns {string|null} null when there is nothing to show
 */
export function formatPrice(amount, source) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const currency = source?.currency ?? 'USD';
  try {
    return formatterFor(currency).format(amount);
  } catch {
    // An unknown currency code should not blank the page.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * One vendor's price for one card, or null when that vendor does not list it.
 *
 * Coverage differs between vendors -- one may price a card the other skips --
 * so this is asked per vendor rather than once per card.
 *
 * @param {Priced|null|undefined} card
 * @param {PriceSource|null|undefined} source
 * @returns {number|null}
 */
export function cardPrice(card, source) {
  const v = source?.vendor ? card?.prices?.[source.vendor] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Total reference value of a set of cards from one vendor, counting quantities.
 *
 * Cards that vendor does not price are reported separately rather than counted
 * as zero, because a total that silently omits them reads as complete.
 *
 * @param {Priced[] | null | undefined} cards
 * @param {PriceSource|null|undefined} source
 * @returns {{total: number, priced: number, unpriced: number}}
 */
export function referenceTotal(cards, source) {
  let total = 0;
  let priced = 0;
  let unpriced = 0;

  for (const c of cards ?? []) {
    const p = cardPrice(c, source);
    if (p !== null) {
      total += p * (c.quantity ?? 1);
      priced++;
    } else {
      unpriced++;
    }
  }
  return { total: Math.round(total * 100) / 100, priced, unpriced };
}

/**
 * Totals across every published vendor, phrased so they cannot be mistaken for
 * the seller's asking price.
 *
 * Each vendor's gaps are its own, so the count of unpriced cards is stated per
 * vendor when they disagree and once at the end when they do not -- repeating
 * an identical figure for every vendor is noise.
 *
 * @param {Priced[] | null | undefined} cards
 * @param {PriceSource[]|null|undefined} sources
 * @returns {string|null}
 */
/**
 * @typedef {object} DiscountGroup
 * @property {Priced[]} cards        the copies coming from one deck
 * @property {number|null} discount  that deck's percentage off, if it has one
 */

/**
 * What the deck discounts come to, one vendor at a time.
 *
 * The discount belongs to a deck, not to a card, so the arithmetic runs per
 * deck and is summed. A single blended percentage over a mixed cart would be
 * wrong wherever the decks differ, which is most carts.
 *
 * Each deck's discounted subtotal is rounded to cents before being summed,
 * because every one of them is shown on its own row. Rounding only at the end
 * is arithmetically closer but leaves the rows not adding up to the total --
 * $6.32 and $6.85 under a total of $13.18 -- and a reader checking the sum by
 * hand is right to distrust it.
 *
 * This is still built on reference prices. The seller's discount comes off the
 * seller's own price, which this site never sees, so the result estimates what
 * they would charge if they priced at these references. Callers must say so;
 * `describeDiscounted` does not say it for them.
 *
 * @param {DiscountGroup[] | null | undefined} groups
 * @param {PriceSource|null|undefined} source
 * @returns {{total: number, full: number, saved: number, priced: number, unpriced: number}}
 */
export function discountedTotal(groups, source) {
  const round = (n) => Math.round(n * 100) / 100;
  let total = 0, full = 0, priced = 0, unpriced = 0;

  for (const group of groups ?? []) {
    const sub = referenceTotal(group.cards, source);
    priced += sub.priced;
    unpriced += sub.unpriced;
    full += sub.total;

    // Anything outside 0-100 is not a discount that can be applied; a deck
    // with none contributes its full subtotal rather than dropping out.
    const off = Number.isFinite(group.discount) && group.discount > 0 && group.discount < 100
      ? group.discount : 0;
    total += round(sub.total * (1 - off / 100));
  }

  return { total: round(total), full: round(full), saved: round(full - total), priced, unpriced };
}

/**
 * The discounted totals as a line of text, or null when there is nothing to
 * say -- no prices at all, or no deck here offering a discount. Printing the
 * same figure twice under two labels would read as a second, confirming
 * source rather than as the identical number.
 *
 * @param {DiscountGroup[] | null | undefined} groups
 * @param {PriceSource[]|null|undefined} sources
 * @returns {string|null}
 */
export function describeDiscounted(groups, sources) {
  const parts = [];
  let discounted = false;

  for (const source of sources ?? []) {
    const r = discountedTotal(groups, source);
    if (!r.priced) continue;
    if (r.saved > 0) discounted = true;
    parts.push(`${formatPrice(r.total, source)} at ${source.label}`);
  }

  return parts.length && discounted ? parts.join(' · ') : null;
}

export function describeTotals(cards, sources) {
  const parts = [];

  for (const source of sources ?? []) {
    const { total, priced, unpriced } = referenceTotal(cards, source);
    if (!priced) continue;
    parts.push({ text: `${formatPrice(total, source)} at ${source.label}`, unpriced });
  }
  if (!parts.length) return null;

  const shared = parts.every((p) => p.unpriced === parts[0].unpriced);
  if (shared) {
    const caveat = parts[0].unpriced ? `, ${parts[0].unpriced} unpriced` : '';
    return parts.map((p) => p.text).join(' \u00b7 ') + caveat;
  }
  return parts
    .map((p) => p.text + (p.unpriced ? ` (${p.unpriced} unpriced)` : ''))
    .join(' \u00b7 ');
}
