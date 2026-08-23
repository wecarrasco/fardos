import * as cheerio from 'cheerio';
import { fetchHtml } from './http.js';
import { linktreeUrl } from '../config.js';
import { log } from '../logger.js';

/**
 * Every Linktree-specific selector lives in this one object. When Linktree ships a
 * markup change, this is the only block that should need editing.
 */
export const LINKTREE_SELECTORS = {
  /** Preferred: Linktree tags each real link button with this testid. */
  linkAnchor: 'a[data-testid="LinkClickTriggerLink"]',
  /** Fallback used when the testid disappears: any anchor pointing at a deck. */
  linkAnchorFallback: 'a[href*="manabox.app/decks/"]',
  /** Wrapper element around a titled group of links. */
  sectionStack: '[data-testid="LinkCollectionStack"]',
  /** The heading inside a stack that names the group. */
  sectionHeading: 'h1, h2, h3, h4',
} as const;

const DECK_URL_RE = /^https?:\/\/(?:www\.)?manabox\.app\/decks\/([A-Za-z0-9_-]+)/;

export interface LinktreeDeckLink {
  /** ManaBox deck id, e.g. "AZ_RG1TNdsG5sWmkbXJ3gA". Primary key for a deck. */
  deckId: string;
  /** Canonical deck URL, query strings and trailing slashes stripped. */
  url: string;
  /** Visible button text on Linktree (emoji and discount notes included). */
  linkText: string;
  /** Section heading this link sits under, or null when it is ungrouped. */
  category: string | null;
  /** Zero-based position on the page, so the UI can preserve the seller's ordering. */
  position: number;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Pull the deck id out of a ManaBox URL. Returns null for anything else. */
export function parseDeckId(href: string): string | null {
  return DECK_URL_RE.exec(href.trim())?.[1] ?? null;
}

/**
 * Parse deck links out of a Linktree page's HTML.
 *
 * Kept pure (HTML in, data out) so it can be unit-tested against a saved fixture
 * without touching the network.
 */
export function parseLinktree(html: string): LinktreeDeckLink[] {
  const $ = cheerio.load(html);

  let anchors = $(LINKTREE_SELECTORS.linkAnchor);
  if (anchors.length === 0) {
    log.anomaly(
      `no anchors matched "${LINKTREE_SELECTORS.linkAnchor}" -- falling back to href matching`,
    );
    anchors = $(LINKTREE_SELECTORS.linkAnchorFallback);
  }

  const out: LinktreeDeckLink[] = [];
  const seen = new Set<string>();

  anchors.each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (!href) return;

    const deckId = parseDeckId(href);
    if (!deckId) return; // non-ManaBox link (socials, WhatsApp, etc.)
    if (seen.has(deckId)) return; // same deck listed twice on the page
    seen.add(deckId);

    // Walk up to the enclosing collection stack to find this link's section heading.
    const stack = $a.closest(LINKTREE_SELECTORS.sectionStack);
    const heading = stack.length
      ? clean(stack.find(LINKTREE_SELECTORS.sectionHeading).first().text())
      : '';

    out.push({
      deckId,
      url: `https://manabox.app/decks/${deckId}`,
      linkText: clean($a.text()),
      category: heading || null,
      position: out.length,
    });
  });

  if (out.length === 0) {
    log.anomaly('Linktree parse produced 0 deck links -- the page layout likely changed');
  }
  return out;
}

/** Fetch and parse the configured Linktree page. */
export async function scrapeLinktree(username?: string): Promise<LinktreeDeckLink[]> {
  const url = linktreeUrl(username);
  log.info(`fetching Linktree page`, { url });
  const links = parseLinktree(await fetchHtml(url));
  log.info(`found ${links.length} ManaBox deck links`, {
    categories: new Set(links.map((l) => l.category ?? '(ungrouped)')).size,
  });
  return links;
}
