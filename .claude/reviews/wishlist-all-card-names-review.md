# Local Review: every Magic card in the wishlist box, and a typo caught

**Reviewed**: 2026-11-27
**Branch**: main
**Decision**: APPROVE

The wishlist box suggested only from the seller's catalogue, which answered a
narrower question than the box asks -- it is the one list meant to hold cards
nobody stocks. And a mistyped name was indistinguishable from an unstocked
one: both matched nothing, and both were accepted in silence. It now searches
all 35,667 Magic card names and offers the card a slip was probably meant to
be.

## Why a committed file and not Scryfall's autocomplete

Measured, not assumed:

- **Scryfall's autocomplete cannot do this.** It matches prefixes and
  substrings, so `Sol Rign` returns nothing -- precisely the case the user
  asked about. Only a local list can measure distance.
- **`legality.json` cannot stand in.** It holds only cards legal in at least
  one of the six formats. Checked: Black Lotus, Ancestral Recall, Mox Sapphire
  and Chaos Orb are all absent -- exactly the cards people wishlist.
- `https://api.scryfall.com/catalog/card-names` is allowed: that host's
  robots.txt disallows only `/admin` and the error pages (printed and read,
  not assumed). 35,667 names, 690 KB raw, **240 KB gzipped**.

## Findings

### CRITICAL / HIGH
None.

### MEDIUM
1. **A real bug the tests caught: the retry was unreachable.** `loadCardNames`
   cached a failed download as `loaded = []` and guarded with `if (loaded)`.
   An empty array is truthy, so one dropped connection disabled suggestions
   for the rest of the visit. Now guarded with `!== null`, and a *thrown*
   fetch leaves nothing cached so a later keystroke retries, while an HTTP
   answer (a 404 from a build that forgot the file) is remembered rather than
   re-requested on every keystroke. Both paths asserted.

2. **`publishSite()` in the build.** `card-names.json` lives at the repo root
   beside `legality.json` -- generated data, not a hand-written part of the
   site -- and both build paths (`--no-scrape` and the full scrape) now go
   through one function that copies it. Two `cpSync` calls could have drifted
   apart, and the one that ships on every frontend push is the `--no-scrape`
   branch, so missing it there would have shipped a box with no suggestions.

### LOW
1. **Never autocorrected.** `closestName` is offered, never applied: *No card
   is called "Sol Rang". Did you mean **Sol Ring**? **Add it as typed***. A
   wishlist that silently swaps in a neighbouring card is worse than one
   showing a typo, because the typo is visible and the wrong card is not. A
   name that is already a real card returns `null` -- nothing to ask -- so the
   common case never needs a second press.

2. **A query under four characters is left alone.** At three letters a single
   change is a different card, not a slip.

3. **Lazy by 240 KB.** Fetched on the first keystroke in the box, never on
   page load. Verified in the browser: 0 requests for it on load, 1 after the
   first keystroke, and one download shared by concurrent callers.

4. **Stocked cards float within a tier**, since a native `<datalist>` gives no
   other way to say which of two suggestions you could buy today.

5. **Typed array and a scalar diagonal in `editDistance`.** The first version
   failed `tsc` because `noUncheckedIndexedAccess` makes every array read
   `number | undefined`, on an `Int32Array` too. Rewritten to one row with the
   diagonal carried in a local, which types cleanly, halves the memory and
   drops a read per cell -- and that matters, since `closestName` runs it
   across 35,000 names.

6. **My own test fixture was wrong, not the code** -- an assertion that
   "Consul Flagship" ranks below "Sol Ring" for `sol`, when `consul` does not
   contain `sol` at all. Replaced with a three-tier check on real cards:
   `Ring of Three Wishes`, `Sol Ring`, `Springleaf Drum` for the query `ring`.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass -- 380/380 (21 new) |
| `npm run build:index -- --no-scrape` | Publishes `card-names.json` (690 KB) |
| Console errors | None |

## Manual verification

Against the live index and the real 35,667-name list, in the browser:

| Check | Result |
|---|---|
| Requests for `card-names.json` on page load | **0** |
| After the first keystroke | **1** |
| `black lo` | `Black Lotus` -- a card the seller has never stocked |
| `ancestral` | `Ancestral Mask`, `Ancestral Communion`, `Ancestral Anger` |
| `sol ri` | `Sol Ring` first |
| `Sol Rang` + Enter | *Did you mean Sol Ring?*; **nothing added yet** |
| Accepting | `Sol Ring added.` |
| `Blak Lotus` then "Add it as typed" | `Blak Lotus added.` |
| `Ancestral Recall` | Added straight away, no question |
| `closestName` across 35,667 names | **8.2 - 14.6 ms** |

## Not done

- The list is refreshed by hand (`npm run names:update`) and committed, like
  `legality.json`. A set released after the last run will not be suggested,
  though it can still be typed in full.
- Suggestions are a native `<datalist>`, so they cannot show set, price or
  stock beside each name.
- Only the wishlist box uses this. The Search tab still suggests from the
  seller's catalogue, which is right there -- searching for a card nobody has
  would only ever return nothing.
