import { normalizeCardName } from './normalize.js';

/**
 * Paste a decklist, find out what the seller has.
 *
 * Deck sites all export slightly differently, so the parser is deliberately
 * forgiving: quantity optional, "4" or "4x", an optional "(SET) 123" tail from
 * Arena and Moxfield, an optional "*F*" foil marker, and section headings and
 * comments skipped.
 */

/** Headings that separate parts of a list rather than naming a card. */
const SECTION_WORDS = new Set([
  'deck', 'decklist', 'main', 'maindeck', 'mainboard',
  'sideboard', 'side', 'commander', 'companion', 'maybeboard', 'maybe',
  'tokens', 'token', 'about', 'name', 'considering',
]);

/**
 * One line of a pasted list.
 *
 * @typedef {object} DecklistEntry
 * @property {number} quantity
 * @property {string} name as typed
 * @property {string} norm folded, for lookup
 * @property {string|null} setId when the list names a printing
 * @property {string|null} collectorNumber
 * @property {boolean} foil when the list marks it foil
 * @property {number} line 1-based line number in the pasted text
 */

/** The front face is what people type for a double-faced card. */
export const frontFace = (name) => String(name ?? '').split('//')[0].trim();

/* ------------------------------------------------------------------ *
 * CSV, which is what ManaBox and Moxfield actually export
 * ------------------------------------------------------------------ */

/** Split one CSV row, honouring quoted fields and doubled quotes inside them. */
export function splitCsvRow(row) {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Column names the two apps use, in the order we prefer them.
 *
 * ManaBox writes "Name,Set code,Collector number,Foil,Quantity"; Moxfield
 * writes "Count,Name,Edition,Foil,Collector Number". Matching on a list of
 * aliases covers both without needing to know which app produced the file.
 */
const CSV_COLUMNS = {
  name: ['name', 'card name', 'card'],
  quantity: ['quantity', 'count', 'qty'],
  setId: ['set code', 'set', 'edition', 'setcode'],
  collectorNumber: ['collector number', 'collectornumber', 'card number', 'number'],
  foil: ['foil', 'finish', 'printing', 'foiling'],
};

/** Locate the columns we care about, by header name. */
function mapCsvHeader(headerCells) {
  const lower = headerCells.map((h) => h.toLowerCase().replace(/^"|"$/g, '').trim());
  /** @type {Record<string, number>} */
  const at = {};
  for (const [key, aliases] of Object.entries(CSV_COLUMNS)) {
    const i = lower.findIndex((h) => aliases.includes(h));
    if (i !== -1) at[key] = i;
  }
  return at;
}

/** A pasted blob is CSV if its first useful line is a header naming a card column. */
export function looksLikeCsv(text) {
  const first = String(text ?? '').split(/\r?\n/).find((l) => l.trim());
  if (!first || !first.includes(',')) return false;
  const at = mapCsvHeader(splitCsvRow(first));
  return at.name !== undefined;
}

/**
 * Foil is spelled several ways, so the negatives are listed and everything
 * else counts as a foil.
 *
 * "nonfoil" is the one that bites: it contains the word, and Card Kingdom
 * writes it on every ordinary card. Reading it as a positive marked a whole
 * list foil.
 */
const NOT_FOIL = new Set(['', 'normal', 'nonfoil', 'non-foil', 'false', 'no', '0', 'none', 'regular']);
const isFoilValue = (v) => !NOT_FOIL.has(String(v ?? '').toLowerCase().trim());

function parseCsv(text) {
  const rows = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  const at = mapCsvHeader(splitCsvRow(rows[0]));

  /** @type {DecklistEntry[]} */
  const entries = [];
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvRow(rows[i]);
    const name = (cells[at.name] ?? '').trim();
    const norm = normalizeCardName(name);
    if (!norm || !/[a-z]/.test(norm)) { skipped++; continue; }

    const rawQty = at.quantity !== undefined ? Number(cells[at.quantity]) : 1;
    const setId = at.setId !== undefined && cells[at.setId] ? cells[at.setId].toLowerCase() : null;

    entries.push({
      quantity: Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : 1,
      name,
      norm,
      setId,
      collectorNumber: at.collectorNumber !== undefined && cells[at.collectorNumber]
        ? cells[at.collectorNumber] : null,
      foil: at.foil !== undefined && isFoilValue(cells[at.foil]),
      line: i + 1,
    });
  }

  return { entries, skipped };
}

/* ------------------------------------------------------------------ */

/**
 * Parse pasted text into entries.
 *
 * Accepts a CSV export from ManaBox or Moxfield, or a plain decklist in any of
 * the shapes the deck sites emit. Blanks, comments and section headings are
 * skipped either way.
 *
 * @param {string} text
 * @returns {{entries: DecklistEntry[], skipped: number, format: 'csv'|'list'}}
 */
export function parseDecklist(text) {
  if (looksLikeCsv(text)) return { ...parseCsv(text), format: 'csv' };
  return { ...parseLines(text), format: 'list' };
}

/**
 * @param {string} text
 * @returns {{entries: DecklistEntry[], skipped: number}}
 */
function parseLines(text) {
  /** @type {DecklistEntry[]} */
  const entries = [];
  let skipped = 0;

  const lines = String(text ?? '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // Comments, in the styles the various exporters use.
    if (line.startsWith('//') || line.startsWith('#')) continue;

    // "SB:" and "MB:" prefixes from older MTGO exports.
    line = line.replace(/^(?:SB|MB):\s*/i, '');

    // A bare heading, with or without a trailing colon.
    const heading = line.replace(/:$/, '').toLowerCase();
    if (SECTION_WORDS.has(heading)) continue;

    const parsed = parseLine(line, i + 1);
    if (parsed) entries.push(parsed);
    else skipped++;
  }

  return { entries, skipped };
}

/**
 * @param {string} line
 * @param {number} lineNumber
 * @returns {DecklistEntry|null}
 */
function parseLine(line, lineNumber) {
  let rest = line;
  let foil = false;

  // Moxfield marks finishes with *F* (foil) or *E* (etched), always at the end.
  const finish = /\s*\*([FE])\*\s*$/i.exec(rest);
  if (finish) {
    foil = true;
    rest = rest.slice(0, finish.index).trim();
  }

  // Leading quantity: "4", "4x", "4 x". Without one, assume a single copy.
  let quantity = 1;
  const qty = /^(\d{1,4})\s*[xX]?\s+/.exec(rest);
  if (qty) {
    quantity = Number(qty[1]);
    rest = rest.slice(qty[0].length).trim();
  }

  // Trailing printing: "(MH3) 361", "(mh3)361", or just "(MH3)".
  let setId = null;
  let collectorNumber = null;
  const printing = /\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9–-]+)?\s*$/.exec(rest);
  if (printing) {
    setId = printing[1].toLowerCase();
    collectorNumber = printing[2] ?? null;
    rest = rest.slice(0, printing.index).trim();
  }

  const name = rest.trim();
  if (!name) return null;

  // A line of only digits or punctuation is not a card.
  const norm = normalizeCardName(name);
  if (!norm || !/[a-z]/.test(norm)) return null;

  return { quantity, name, norm, setId, collectorNumber, foil, line: lineNumber };
}

/* ------------------------------------------------------------------ *
 * Matching against the index
 * ------------------------------------------------------------------ */

/**
 * Group every card in the index by folded name, including the front face of
 * double-faced cards, because that is what decklists write.
 */
function buildNameIndex(index) {
  /** @type {Map<string, {card: object, deck: object}[]>} */
  const byName = new Map();

  const add = (key, value) => {
    if (!key) return;
    const list = byName.get(key);
    list ? list.push(value) : byName.set(key, [value]);
  };

  for (const deck of index?.decks ?? []) {
    for (const card of deck.cards) {
      const entry = { card, deck };
      const full = normalizeCardName(card.name);
      add(full, entry);

      const front = normalizeCardName(frontFace(card.name));
      if (front && front !== full) add(front, entry);
    }
  }
  return byName;
}

/**
 * @typedef {object} DecklistMatch
 * @property {DecklistEntry} entry
 * @property {'available'|'partial'|'missing'} status
 * @property {number} wanted
 * @property {number} available total copies across every deck
 * @property {{deckId: string, deckName: string, deckUrl: string, discount: number|null, quantity: number, cards: object[]}[]} sources
 */

/**
 * Look every entry up.
 *
 * Matching is on the exact folded name, not a substring: a list asking for
 * "Bolt" means the card called Bolt, and offering everything containing "bolt"
 * would bury the answer. A printing named in the list narrows the sources but
 * never hides the card -- if the exact printing is absent the other ones are
 * still worth seeing.
 *
 * @typedef {object} DecklistSummary
 * @property {number} lines cards asked for
 * @property {number} available fully in stock
 * @property {number} partial in stock, but not enough copies
 * @property {number} missing not stocked at all
 * @property {number} wantedCopies
 * @property {number} foundCopies capped at what was asked for
 * @property {{deckName: string, deckUrl: string, discount: number|null, cards: number}[]} topDecks
 *
 * @param {object} index
 * @param {DecklistEntry[]} entries
 * @returns {{matches: DecklistMatch[], summary: DecklistSummary}}
 */
/**
 * Is this card the printing the list asked for?
 *
 * The set may arrive as a code or as a full name: ManaBox exports "mh3", Card
 * Kingdom's edition column says "Modern Horizons 3", and someone typing a line
 * by hand uses whichever they have. Accepting both costs one comparison and
 * saves the preference from being silently dropped on every Card Kingdom list.
 */
function isNamedPrinting(card, entry) {
  const sameSet = card.setId === entry.setId ||
    (!!card.setName && normalizeCardName(card.setName) === normalizeCardName(entry.setId));
  return sameSet && (!entry.collectorNumber || card.collectorNumber === entry.collectorNumber);
}

export function matchDecklist(index, entries) {
  const byName = buildNameIndex(index);
  /** @type {DecklistMatch[]} */
  const matches = [];

  for (const entry of entries) {
    const found = byName.get(entry.norm) ?? [];

    // Narrow to the requested printing when the list names one and we have it.
    const wantsPrinting = entry.setId !== null;
    const exact = wantsPrinting
      ? found.filter((f) => isNamedPrinting(f.card, entry))
      : found;
    const pool = exact.length ? exact : found;

    /** @type {Map<string, any>} */
    const byDeck = new Map();
    for (const { card, deck } of pool) {
      const seen = byDeck.get(deck.id);
      // Every printing is kept, not just the first. One deck often holds the
      // same card twice -- a foil and a plain, or two sets -- and a message to
      // the seller naming only one of them asks for the wrong card.
      if (seen) { seen.quantity += card.quantity; seen.cards.push(card); }
      else byDeck.set(deck.id, {
        deckId: deck.id, deckName: deck.name, deckUrl: deck.url,
        discount: deck.discount ?? null, quantity: card.quantity, cards: [card],
      });
    }

    const sources = [...byDeck.values()]
      .sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1) || b.quantity - a.quantity);
    const available = sources.reduce((n, s) => n + s.quantity, 0);

    matches.push({
      entry,
      status: available === 0 ? 'missing' : available >= entry.quantity ? 'available' : 'partial',
      wanted: entry.quantity,
      available,
      sources,
    });
  }

  return { matches, summary: summarise(matches) };
}

/**
 * @param {DecklistMatch[]} matches
 * @returns {DecklistSummary}
 */
function summarise(matches) {
  const lines = matches.length;
  const available = matches.filter((m) => m.status === 'available').length;
  const partial = matches.filter((m) => m.status === 'partial').length;
  const missing = matches.filter((m) => m.status === 'missing').length;

  const wantedCopies = matches.reduce((n, m) => n + m.wanted, 0);
  const foundCopies = matches.reduce((n, m) => n + Math.min(m.wanted, m.available), 0);

  // Which decks cover the most of the list, so a buyer knows where to start.
  /** @type {Map<string, {deckName: string, deckUrl: string, discount: number|null, cards: number}>} */
  const coverage = new Map();
  for (const m of matches) {
    for (const s of m.sources) {
      const row = coverage.get(s.deckId);
      if (row) row.cards++;
      else coverage.set(s.deckId, {
        deckName: s.deckName, deckUrl: s.deckUrl, discount: s.discount, cards: 1,
      });
    }
  }
  const topDecks = [...coverage.values()]
    .sort((a, b) => b.cards - a.cards || (b.discount ?? -1) - (a.discount ?? -1))
    .slice(0, 8);

  return { lines, available, partial, missing, wantedCopies, foundCopies, topDecks };
}

/* ------------------------------------------------------------------ *
 * The message to the seller
 * ------------------------------------------------------------------ */

/** One card line: "2x Sol Ring (LTC) #284 [foil]". */
const cardLine = (n, name, card) =>
  `  ${n}x ${name}` +
  (card?.setId ? ` (${card.setId.toUpperCase()})` : '') +
  (card?.collectorNumber ? ` #${card.collectorNumber}` : '') +
  (card?.foil ? ' [foil]' : '');

/**
 * @typedef {object} Allocation
 * @property {string} deckId
 * @property {string} deckName
 * @property {string} deckUrl
 * @property {number|null} discount
 * @property {string} name   as the list wrote it
 * @property {object} card   the printing these copies come from
 * @property {number} quantity
 */

/**
 * Decide which copies come from which deck, and which printing within it.
 *
 * Unlike the cart, nobody has chosen where each card comes from -- the same
 * card sits in twenty of these decks. The best-discounted deck is emptied
 * first and spills into the next only when it runs short, which is what
 * someone buying would do; `sources` is already in that order, so this is the
 * order the page showed.
 *
 * Never more than exists. This feeds a request sent to a shop and a total
 * shown to the reader, and a number nobody can fill is wrong in both.
 *
 * @param {DecklistMatch[]} matches
 * @returns {Allocation[]}
 */
export function allocateStock(matches) {
  /** @type {Allocation[]} */
  const out = [];

  for (const m of matches ?? []) {
    let left = Math.min(m.wanted, m.available);

    for (const source of m.sources) {
      if (left <= 0) break;
      let fromDeck = Math.min(left, source.quantity);
      left -= fromDeck;

      // Spread across the printings this deck holds, so a deck with a foil and
      // a plain copy is asked for both by name rather than for two of one.
      for (const card of source.cards) {
        if (fromDeck <= 0) break;
        const quantity = Math.min(fromDeck, card.quantity);
        fromDeck -= quantity;
        out.push({
          deckId: source.deckId, deckName: source.deckName, deckUrl: source.deckUrl,
          discount: source.discount, name: m.entry.name, card, quantity,
        });
      }
    }
  }
  return out;
}

/**
 * The stocked half of a list, as something to send the seller.
 *
 * Grouped by deck because that is how the stock is organised: a list sorted by
 * card name would make the seller hunt through seventy decks for every line.
 * The deck's link goes with its heading, since that is the thing they open.
 *
 * @param {DecklistMatch[]} matches
 * @returns {string} empty when nothing is stocked
 */
export function stockedMessage(matches) {
  /** @type {Map<string, {deckName: string, deckUrl: string, discount: number|null, lines: string[]}>} */
  const groups = new Map();
  let copies = 0;

  for (const a of allocateStock(matches)) {
    copies += a.quantity;
    if (!groups.has(a.deckId)) {
      groups.set(a.deckId, {
        deckName: a.deckName, deckUrl: a.deckUrl, discount: a.discount, lines: [],
      });
    }
    groups.get(a.deckId).lines.push(cardLine(a.quantity, a.name, a.card));
  }

  if (!groups.size) return '';

  // Just the cards. No greeting and no total: whoever sends this writes their
  // own opening, and the counts are already on the page they are reading.
  const out = [];
  for (const g of groups.values()) {
    out.push(`${g.deckName}${g.discount ? ` (${g.discount}% off)` : ''}`);
    out.push(g.deckUrl);
    out.push(...g.lines, '');
  }
  return out.join('\n').trimEnd();
}
