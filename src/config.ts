import 'dotenv/config';
import { PRICE_VENDORS, type PriceVendor } from './scrapers/manabox.js';

const DEFAULT_PRICE_VENDORS: PriceVendor[] = ['tcgplayer', 'cardKingdom'];

/**
 * An unknown vendor name is a typo, not a reason to publish an index with no
 * prices in it, so it fails loudly here rather than silently later.
 */
function parseVendors(raw: string | undefined): readonly PriceVendor[] {
  if (!raw?.trim()) return DEFAULT_PRICE_VENDORS;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(n in PRICE_VENDORS));
  if (bad.length) {
    throw new Error(
      `PRICE_VENDORS: unknown vendor ${bad.join(', ')}. ` +
      `Known: ${Object.keys(PRICE_VENDORS).join(', ')}`,
    );
  }
  return names as PriceVendor[];
}

/** All tunables live here so the target account is a one-line change. */
export const config = {
  /** Linktree username to scrape. Change this to point the app at a different seller. */
  linktreeUsername: process.env.LINKTREE_USERNAME ?? 'ChelitoSAF',

  /**
   * Whose market prices to publish, in the order they are shown. These are
   * third-party reference prices, never the seller's own.
   *
   * Two are published because they answer different questions. TCGplayer is a
   * marketplace, so it tracks the cheapest real listing; Card Kingdom is one
   * shop's asking price with a floor of a few cents per card. On bulk commons
   * that gap reaches 2.4x, which is worth being able to see rather than
   * having to pick one and hope.
   *
   * Any of: tcgplayer, cardKingdom, manapool, starcitygames, cardmarket.
   * Set PRICE_VENDORS to a comma-separated list to change it.
   */
  priceVendors: parseVendors(process.env.PRICE_VENDORS),

  /** Politeness: milliseconds to wait between consecutive deck-page fetches. */
  fetchDelayMs: Number(process.env.FETCH_DELAY_MS ?? 1200),

  /** Per-request timeout and retry budget. */
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 20_000),
  fetchRetries: Number(process.env.FETCH_RETRIES ?? 2),

  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
} as const;

export const linktreeUrl = (username = config.linktreeUsername) =>
  `https://linktr.ee/${username}`;
