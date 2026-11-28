/**
 * Every Magic card name, for the wishlist box.
 *
 * The wishlist is the one place that holds cards the seller does not stock, so
 * suggesting only from the seller's catalogue answered a narrower question
 * than the box asks. Worse, it left a mistyped name indistinguishable from a
 * card nobody carries: both match nothing, and both were accepted in silence.
 *
 * Three reasons the list is a committed file rather than live calls to
 * Scryfall's autocomplete endpoint:
 *
 *   - That endpoint matches prefixes and substrings. It returns nothing for
 *     "Sol Rign", which is the case this exists to catch. Only a local list
 *     can measure how far a typed name is from a real one.
 *   - A call per keystroke makes a tab that fails when a third party is slow,
 *     in a site whose whole point is being static.
 *   - `legality.json` cannot stand in for it: it carries only cards legal in
 *     at least one of the six formats, so Black Lotus, Ancestral Recall, Mox
 *     Sapphire and Chaos Orb -- exactly the cards people put on a wishlist --
 *     are not in it.
 *
 * It costs 240 KB gzipped, so it is fetched on the first keystroke in the
 * wishlist box and never on page load. Nobody who does not use the box pays
 * for it.
 */

import { normalizeCardName } from './normalize.js';

export const CARD_NAMES_PATH = 'card-names.json';

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/** @type {string[]|null} */
let loaded = null;
/** @type {Promise<string[]>|null} */
let inflight = null;

/**
 * Fetch the list once, whatever happens.
 *
 * Memoised on the promise, not only the result, so keystrokes arriving while
 * the first is still in flight share it instead of starting a second download
 * of the same 240 KB.
 *
 * A failure resolves to an empty list rather than throwing: the box must keep
 * working without suggestions, since a name can always be typed in full.
 *
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @param {string} [path]
 * @returns {Promise<string[]>}
 */
export function loadCardNames(fetchImpl = globalThis.fetch, path = CARD_NAMES_PATH) {
  // `!== null` rather than a truthiness test: an empty list is a settled
  // answer that must be remembered, and `[]` is truthy, so `if (loaded)` would
  // have cached a failure as permanent and made the retry below unreachable.
  if (loaded !== null) return Promise.resolve(loaded);
  if (inflight) return inflight;

  inflight = (async () => {
    let res;
    try {
      res = await fetchImpl(path);
    } catch {
      // Nothing answered. Left uncached and the slot cleared, so a later
      // keystroke tries again: one dropped connection must not disable
      // suggestions for the rest of the visit.
      inflight = null;
      return [];
    }

    try {
      // A status is an answer. A 404 means the build did not publish the file,
      // which no amount of retrying fixes, so it is remembered rather than
      // re-requested on every keystroke.
      if (!res.ok) return (loaded = []);
      const data = await res.json();
      return (loaded = Array.isArray(data)
        ? data.filter((n) => typeof n === 'string' && n)
        : []);
    } catch {
      return (loaded = []);   // answered with something unreadable
    }
  })();

  return inflight;
}

/** Testing seam: forget what was loaded. */
export function resetCardNames() {
  loaded = null;
  inflight = null;
}

/* ------------------------------------------------------------------ *
 * Suggesting
 * ------------------------------------------------------------------ */

/**
 * How well a name answers what has been typed, lower being better, -1 for not
 * at all.
 *
 * Four tiers rather than one score: someone typing "sol" wants the cards that
 * start with it above the ones that merely contain it, and an exact name above
 * everything.
 */
function rank(norm, q) {
  if (norm === q) return 0;
  if (norm.startsWith(q)) return 1;
  if (norm.includes(` ${q}`)) return 2;
  return norm.includes(q) ? 3 : -1;
}

/**
 * Names worth offering for what has been typed so far.
 *
 * Cards the seller stocks are floated within each tier, because an entry you
 * can act on today is more useful than one you cannot, and a native dropdown
 * gives no other way to tell them apart.
 *
 * @param {string[]} names
 * @param {string} query
 * @param {{limit?: number, stocked?: Set<string>|null}} [opts]
 * @returns {string[]}
 */
export function suggestNames(names, query, opts = {}) {
  const { limit = 10, stocked = null } = opts;
  const q = normalizeCardName(query ?? '');
  if (!q) return [];

  const hits = [];
  for (const name of names ?? []) {
    const norm = normalizeCardName(name);
    const r = rank(norm, q);
    if (r === -1) continue;
    hits.push({ name, r, near: stocked?.has(norm) ? 0 : 1 });
  }

  hits.sort((a, b) =>
    a.r - b.r || a.near - b.near || a.name.length - b.name.length ||
    a.name.localeCompare(b.name));

  return hits.slice(0, limit).map((h) => h.name);
}

/* ------------------------------------------------------------------ *
 * Catching a slip
 * ------------------------------------------------------------------ */

/**
 * Levenshtein distance, abandoned once it passes `cap`.
 *
 * The cap is what makes scanning 35,000 names on a submit affordable: most
 * candidates are ruled out after a row or two instead of being measured in
 * full.
 */
export function editDistance(a, b, cap = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  // One row, rewritten in place, with the diagonal carried in a scalar. Half
  // the memory of the two-row form and no per-cell read of a second array --
  // which matters, because closestName runs this across 35,000 names.
  const row = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;

  let last = b.length;
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];            // row[j-1] as it was before this pass
    row[0] = i;
    let best = i;

    for (let j = 1; j <= b.length; j++) {
      const above = row[j];       // the previous row's value at j
      const d = a[i - 1] === b[j - 1]
        ? diag
        : 1 + Math.min(diag, above, row[j - 1]);
      row[j] = d;
      diag = above;
      if (d < best) best = d;
    }

    // Every remaining path runs through this row, so nothing after it can come
    // back under the cap.
    if (best > cap) return cap + 1;
    last = row[b.length];
  }
  return last;
}

/**
 * The real card a typed name was probably meant to be, or null.
 *
 * Null for anything already a real name -- there is nothing to correct -- and
 * for a query too short to judge, where one letter in three is a different
 * card rather than a slip.
 *
 * Never applied on its own. The caller offers it and the reader decides: a
 * wishlist that silently swaps in a neighbouring card is worse than one
 * showing a typo, because the typo is visible and the wrong card is not.
 *
 * @param {string[]} names
 * @param {string} query
 * @param {number} [maxDistance]
 * @returns {string|null}
 */
export function closestName(names, query, maxDistance = 2) {
  const q = normalizeCardName(query ?? '');
  if (q.length < 4) return null;

  let best = null;
  let bestD = maxDistance + 1;

  for (const name of names ?? []) {
    const norm = normalizeCardName(name);
    if (norm === q) return null;                       // already a real card
    if (Math.abs(norm.length - q.length) > maxDistance) continue;

    const d = editDistance(norm, q, bestD - 1);
    if (d < bestD) { bestD = d; best = name; }
  }

  return bestD <= maxDistance ? best : null;
}
