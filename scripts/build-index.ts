/**
 * Scrape the sites and write the static search index that GitHub Pages serves.
 *
 *   npm run build:index                 -- writes dist-site/index.json
 *   npm run build:index -- --out DIR
 *
 * This replaces the server and database entirely: GitHub Actions runs it, the
 * JSON it produces is the whole backend.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeLinktree } from '../src/scrapers/linktree.js';
import { scrapeDeck, type DeckSnapshot } from '../src/scrapers/manabox.js';
import { sleep } from '../src/scrapers/http.js';
import { config, linktreeUrl } from '../src/config.js';
import { log } from '../src/logger.js';
import { diffDecks, stampArrivals, type PreviousIndex } from './lib/diff.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const outDir = resolve(root, outFlag !== -1 ? argv[outFlag + 1]! : 'dist-site');

interface IndexCard {
  name: string;
  /**
   * Date this printing was first seen anywhere in the catalogue, YYYY-MM-DD.
   * Absent when it was already in stock before arrival tracking began, or when
   * the previous index could not be read -- "unknown", never "new".
   */
  firstSeen?: string;
  quantity: number;
  foil: boolean;
  setName: string | null;
  setId: string | null;
  collectorNumber: string | null;
  rarity: string | null;
  typeName: string;
}

interface IndexDeck {
  id: string;
  name: string;
  url: string;
  category: string | null;
  updatedAt: string | null;
  cardCount: number;
  cards: IndexCard[];
}

function toIndexDeck(snapshot: DeckSnapshot, category: string | null): IndexDeck {
  return {
    id: snapshot.deckId,
    name: snapshot.name,
    url: snapshot.url,
    category,
    updatedAt: snapshot.lastUpdated,
    cardCount: snapshot.cards.reduce((n, c) => n + c.quantity, 0),
    cards: snapshot.cards.map((c) => ({
      name: c.name,
      quantity: c.quantity,
      foil: c.foil,
      setName: c.setName,
      setId: c.setId,
      collectorNumber: c.collectorNumber,
      rarity: c.rarity,
      typeName: c.typeName,
    })),
  };
}

/** Read whatever was published last time, or null on a first build. */
function readPrevious(previousPath: string): PreviousIndex | null {
  if (!existsSync(previousPath)) return null;
  try {
    return JSON.parse(readFileSync(previousPath, 'utf8')) as PreviousIndex;
  } catch {
    log.warn('could not read the previous index; treating this as a first build');
    return null;
  }
}

/* ------------------------------------------------------------------ */

const links = await scrapeLinktree();

if (links.length === 0) {
  // Publishing an empty index would wipe a working site. Fail the build so the
  // previously published one stays up.
  log.anomaly('Linktree returned 0 decks -- refusing to publish an empty index');
  process.exit(1);
}

const decks: IndexDeck[] = [];
let failed = 0;
let gone = 0;

for (const [i, link] of links.entries()) {
  if (i > 0) await sleep(config.fetchDelayMs);
  try {
    const snapshot = await scrapeDeck(link.deckId);
    if (!snapshot) {
      gone++;
      log.warn(`skipping deck that is no longer available: ${link.linkText}`);
      continue;
    }
    decks.push(toIndexDeck(snapshot, link.category));
    process.stderr.write(`\r[${i + 1}/${links.length}] ${link.linkText.slice(0, 48).padEnd(50)}`);
  } catch (err) {
    // One bad deck must not lose the other sixty-two.
    failed++;
    log.error(`failed to scrape ${link.deckId}`, { err: String(err) });
  }
}
process.stderr.write('\n');

const entries = decks.reduce((n, d) => n + d.cards.length, 0);
const copies = decks.reduce((n, d) => n + d.cardCount, 0);
const names = new Set(decks.flatMap((d) => d.cards.map((c) => c.name))).size;

if (entries === 0) {
  log.anomaly('every deck parsed to zero cards -- refusing to publish an empty index');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const previousPath = resolve(outDir, 'index.json');
const previous = readPrevious(previousPath);
const diff = diffDecks(decks, previous);

const generatedAt = new Date().toISOString();
const arrivedKeys = stampArrivals(decks, previous, generatedAt.slice(0, 10));

const index = {
  generatedAt,
  /** Lets the site offer a "since the last update" window. */
  previousGeneratedAt: previous?.generatedAt ?? null,
  /**
   * Exactly what this build brought in. Stored as keys rather than inferred
   * from dates because two builds run on the same day, and a date comparison
   * would keep showing the morning's arrivals after a quiet evening build.
   */
  lastUpdate: { newPrintings: arrivedKeys },
  source: linktreeUrl(),
  stats: {
    decks: decks.length, entries, copies, names,
    newPrintings: arrivedKeys.length, skipped: gone, failed,
  },
  decks,
};

// Copy the static frontend alongside the data so the output directory is the
// complete site, ready to publish.
cpSync(resolve(root, 'web'), outDir, { recursive: true });
writeFileSync(previousPath, JSON.stringify(index));

const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(index)) / 1024);
log.info('index written', {
  out: previousPath, sizeKb,
  decks: decks.length, entries, copies, names, newPrintings: arrivedKeys.length,
  added: diff.added, removed: diff.removed, changed: diff.changed,
  skipped: gone, failed,
});

// Consumed by the workflow to write a meaningful commit message.
const summary = diff.first
  ? `${decks.length} decks, ${copies} cards (first build)`
  : [`${decks.length} decks, ${copies} cards`,
     diff.added ? `${diff.added} added` : null,
     diff.removed ? `${diff.removed} removed` : null,
     diff.changed ? `${diff.changed} changed` : null,
     arrivedKeys.length ? `${arrivedKeys.length} new cards` : null,
     failed ? `${failed} failed` : null,
    ].filter(Boolean).join(', ');
console.log(summary);
