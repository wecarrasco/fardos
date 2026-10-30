import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ageInDays } from './decks.js';
import { log } from './logger.js';

/**
 * Format legality, read from a committed file rather than fetched.
 *
 * ManaBox does not publish legality at all, so this is the one thing on a card
 * that has to come from somewhere else. Scryfall allows it -- their robots.txt
 * grants everything outside /admin, and they publish bulk files precisely so
 * that projects stop hammering the API -- but the build still does not fetch
 * it, for a different reason to Linktree's.
 *
 * Each regeneration of that bulk file gets its own timestamped URL served
 * immutable, so there is no cheap "nothing changed" request: a refresh is
 * always the full 25MB. Meanwhile what we take out of it -- a name and six
 * bits -- moves only when Wizards bans something or a set is released, a
 * handful of times a year. Downloading 25MB on every build to re-derive a
 * table that changed ten times in a year is not a trade worth making, and it
 * would hand every build a third-party dependency that can fail at 3am.
 *
 * So `npm run legality:update` does it on a laptop, on purpose, and commits
 * the result. The build reads a file. Nothing to fail, nothing to guard.
 *
 * The cost is staleness rather than wrongness: a card printed since the last
 * refresh has no legality recorded, and a filter leaves it out rather than
 * guessing.
 */

/**
 * The formats offered, and -- critically -- their bit positions.
 *
 * The order is the encoding. Changing it reinterprets every number in the
 * committed file, so `parseLegalityTable` refuses a file whose own list
 * disagrees rather than quietly reading black as white.
 *
 * Which six: these are the ones that actually narrow this catalogue. Vintage
 * and Oathbreaker sit above 98% legal, which is a control that does nothing.
 */
export const LEGAL_FORMATS = [
  'standard', 'pioneer', 'modern', 'legacy', 'pauper', 'commander',
] as const;

export type LegalFormat = (typeof LEGAL_FORMATS)[number];

/** Human labels, for the filter control. */
export const FORMAT_LABELS: Record<LegalFormat, string> = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern',
  legacy: 'Legacy', pauper: 'Pauper', commander: 'Commander',
};

export const LEGALITY_PATH = 'legality.json';

/**
 * Bans land a few times a year and sets about eight times, so a table four
 * months old is behind on both. Longer than the deck list's 30 days because
 * the deck list goes stale every time the seller adds a deck, and this does
 * not.
 */
export const STALE_AFTER_DAYS = 120;

/** Statuses that mean you may put the card in a deck. */
const PLAYABLE = new Set(['legal', 'restricted']);

export interface LegalityTable {
  /** ISO date the bulk file was processed. */
  capturedAt: string;
  /** The exact bulk file it came from, for provenance. */
  source: string;
  /** Must equal LEGAL_FORMATS: the bit positions are this list's order. */
  formats: string[];
  /** Card name -> bitmask. A card legal in nothing is simply absent. */
  legalities: Record<string, number>;
}

/**
 * The join key: case and accents folded, punctuation kept.
 *
 * Deliberately not `normalizeCardName()`, which also strips punctuation. That
 * is right for a search box, where someone typing "krrik" should find
 * K'rrik -- and wrong here, because it merges "Rampant Growth" with the
 * playtest card "Rampant, Growth", which is legal in nothing. One is in this
 * seller's stock. A fuzzy key is a feature when matching what a person typed
 * and a defect when joining two datasets.
 *
 * Measured: this key is unique across all 35,224 non-token cards Scryfall
 * knows, where the search key collides on 13 of them.
 */
export const legalityKey = (name: string): string =>
  String(name ?? '').normalize('NFC').trim().toLowerCase();

/** The front face of a double-faced name; ManaBox stores only that half. */
export const frontFaceName = (name: string): string =>
  String(name ?? '').split(' // ')[0]!;

/**
 * Pack one card's legality statuses into a bitmask.
 *
 * @param statuses Scryfall's `legalities` object
 */
export function legalityBits(
  statuses: Record<string, string> | null | undefined,
  formats: readonly string[] = LEGAL_FORMATS,
): number {
  let bits = 0;
  formats.forEach((f, i) => {
    if (PLAYABLE.has(statuses?.[f] ?? '')) bits |= 1 << i;
  });
  return bits;
}

/** Is a card with this mask legal in this format? */
export function isLegalIn(
  bits: number | null | undefined,
  format: string,
  formats: readonly string[] = LEGAL_FORMATS,
): boolean {
  const i = formats.indexOf(format);
  return i >= 0 && ((bits ?? 0) & (1 << i)) !== 0;
}

/**
 * Parse and validate a legality table.
 *
 * Throws rather than returning something partial, for the reason the deck list
 * does: an index built from half a table would mark real cards illegal, and a
 * filter that hides cards the seller has is worse than no filter.
 */
export function parseLegalityTable(json: string): LegalityTable {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`legality table is not valid JSON: ${String(err)}`);
  }

  const table = raw as Partial<LegalityTable>;
  if (!table?.legalities || typeof table.legalities !== 'object' || Array.isArray(table.legalities)) {
    throw new Error('legality table has no "legalities" object');
  }

  // The masks are positional, so a file listing different formats -- or the
  // same ones in a different order -- would be read as a different question
  // entirely, silently and on every card.
  if (!Array.isArray(table.formats) || table.formats.join(',') !== LEGAL_FORMATS.join(',')) {
    throw new Error(
      `legality table lists formats [${table.formats?.join(', ') ?? ''}] but this build ` +
      `expects [${LEGAL_FORMATS.join(', ')}]. Re-run: npm run legality:update`,
    );
  }

  const entries = Object.entries(table.legalities);
  if (entries.length === 0) throw new Error('legality table is empty');

  const max = (1 << LEGAL_FORMATS.length) - 1;
  for (const [name, bits] of entries) {
    if (!Number.isInteger(bits) || bits < 0 || bits > max) {
      throw new Error(`legality table entry "${name}" is not a ${LEGAL_FORMATS.length}-bit mask: ${bits}`);
    }
  }

  return {
    capturedAt: typeof table.capturedAt === 'string' ? table.capturedAt : '',
    source: typeof table.source === 'string' ? table.source : '',
    formats: [...LEGAL_FORMATS],
    legalities: table.legalities as Record<string, number>,
  };
}

export interface LegalityLookup {
  readonly formats: readonly string[];
  readonly capturedAt: string;
  readonly size: number;
  /** The mask for a card name, or null when the table has never heard of it. */
  bitsFor(name: string): number | null;
}

/**
 * Index a table for lookup by card name.
 *
 * Two passes, because an exact name must always beat a front-face guess: if
 * the seller stocks a card actually called "Fire", it should not pick up the
 * legality of "Fire // Ice".
 */
export function buildLegalityLookup(table: LegalityTable): LegalityLookup {
  const exact = new Map<string, number>();
  for (const [name, bits] of Object.entries(table.legalities)) exact.set(legalityKey(name), bits);

  const front = new Map<string, number | null>();
  for (const [name, bits] of Object.entries(table.legalities)) {
    const face = frontFaceName(name);
    if (face === name) continue;
    const key = legalityKey(face);
    if (exact.has(key)) continue;
    // Two different split cards sharing a front face cannot be told apart, so
    // neither answers -- a wrong legality is worse than an absent one.
    front.set(key, front.has(key) ? null : bits);
  }

  return {
    formats: table.formats,
    capturedAt: table.capturedAt,
    size: exact.size,
    bitsFor(name) {
      const key = legalityKey(name);
      const hit = exact.get(key);
      if (hit !== undefined) return hit;
      return front.get(key) ?? null;
    },
  };
}

/**
 * Read the legality table from disk, warning when it is old.
 *
 * @param root repository root
 */
export function loadLegality(root: string, now = new Date()): LegalityLookup {
  const path = resolve(root, LEGALITY_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `${LEGALITY_PATH} not found. It is committed to the repository; if it is ` +
      `genuinely missing, rebuild it with: npm run legality:update`,
    );
  }

  const table = parseLegalityTable(readFileSync(path, 'utf8'));
  const lookup = buildLegalityLookup(table);
  const age = ageInDays(table.capturedAt, now);

  log.info('legality table loaded', {
    cards: lookup.size,
    capturedAt: table.capturedAt || '(unknown)',
    ageInDays: Number.isFinite(age) ? age : '(unknown)',
  });

  // Said out loud, because the symptom is invisible: cards printed since the
  // last refresh simply never appear under a format filter, and the build
  // otherwise looks entirely healthy.
  if (age >= STALE_AFTER_DAYS) {
    log.warn(
      `legality table is ${Number.isFinite(age) ? `${age} days` : 'of unknown age'} -- ` +
      `recent cards and bans will be missing until it is refreshed`,
      { capturedAt: table.capturedAt || '(unknown)' },
    );
  }

  return lookup;
}
