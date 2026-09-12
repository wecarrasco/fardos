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
