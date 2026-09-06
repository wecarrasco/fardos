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
 * @typedef {import('./search.js').IndexCard} IndexCard
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
 * Total reference value of a set of cards, counting quantities.
 *
 * Cards the vendor does not price are reported separately rather than counted
 * as zero, because a total that silently omits them reads as complete.
 *
 * @param {{price?: number, quantity?: number}[] | null | undefined} cards
 * @returns {{total: number, priced: number, unpriced: number}}
 */
export function referenceTotal(cards) {
  let total = 0;
  let priced = 0;
  let unpriced = 0;

  for (const c of cards ?? []) {
    if (typeof c.price === 'number' && c.price >= 0) {
      total += c.price * (c.quantity ?? 1);
      priced++;
    } else {
      unpriced++;
    }
  }
  return { total: Math.round(total * 100) / 100, priced, unpriced };
}

/**
 * A total phrased so it cannot be mistaken for the seller's asking price.
 *
 * @param {{price?: number, quantity?: number}[] | null | undefined} cards
 * @param {PriceSource|null|undefined} source
 * @returns {string|null}
 */
export function describeTotal(cards, source) {
  const { total, priced, unpriced } = referenceTotal(cards);
  if (!priced) return null;

  const money = formatPrice(total, source);
  const vendor = source?.label ?? 'market';
  const caveat = unpriced ? `, ${unpriced} unpriced` : '';
  return `${money} at ${vendor}${caveat}`;
}
