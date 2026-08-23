import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Saved copies of real pages, each chosen to pin down a specific parsing
 * behaviour. The seller edits these decks daily, so the expected values below
 * are a snapshot of the fixture, not of the live site.
 */
export const FIXTURES = {
  /** Foils, two printings of one card, and card types 1-5 and 7. */
  mixed: {
    file: 'deck-mixed.html.gz',
    deckId: 'AZ_RG1TNdsG5sWmkbXJ3gA',
    name: 'SAF/ON THE ROAD',
  },
  /** Small deck; keeps the cheap assertions fast to read. */
  small: {
    file: 'deck-small.html.gz',
    deckId: 'AZ_b7h_bfcuaP_uVxWarlg',
    name: 'Fetchs & Shocks',
  },
  /** Contains type 0 entries, which are Planeswalkers rather than unknowns. */
  planeswalkers: {
    file: 'deck-planeswalkers.html.gz',
    deckId: 'AZuTeFm6d4CvJaGQ5VrF9Q',
    name: 'SECRET LAIR',
  },
  /** Contains type 6 entries -- the March of the Machine battles. */
  battles: {
    file: 'deck-battles.html.gz',
    deckId: 'AZv3GQbCeLCUi0Gz993rKA',
    name: 'Enchantments II',
  },
  /** Entirely type 8, which ManaBox itself renders under an "Other" heading. */
  tokens: {
    file: 'deck-tokens.html.gz',
    deckId: 'AZuds7L2dtCi-pYNdTmzMg',
    name: 'TOKENS',
  },
} as const;

export const LINKTREE_FIXTURE = 'linktree.html.gz';

/** Read a gzipped fixture back as HTML. */
export function readFixture(file: string): string {
  return gunzipSync(readFileSync(resolve(FIXTURE_DIR, file))).toString('utf8');
}
