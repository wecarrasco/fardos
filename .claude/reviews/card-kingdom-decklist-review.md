# Local Review: Card Kingdom lists in the Decklist tab

**Reviewed**: 2026-11-10
**Branch**: main
**Decision**: APPROVE

## Summary

The requested feature was almost entirely already built: the Decklist tab
already takes a pasted list, reports which decks hold each card with links and
discounts, and lists what is missing. What it could not read was Card Kingdom.
It turned out to need no parser of its own -- only the two things Card Kingdom
says differently, one of which was a genuine bug affecting every format.

## Findings

### CRITICAL / HIGH
None. No new network, storage or markup; the change is two predicates inside an
existing parser.

### MEDIUM
1. **Fixed** — `isFoilValue` treated any value outside a short negative list as
   a foil, so `nonfoil` -- which Card Kingdom writes on every ordinary card --
   read as a positive and marked whole lists foil. Replaced the chain with a
   `NOT_FOIL` set including `nonfoil`, `non-foil` and `regular`. This was not
   Card Kingdom-specific: any export using that spelling was affected.

### LOW
1. **Accepted** — `isNamedPrinting` compares the list's set against both the
   card's `setId` and its `setName`. Card Kingdom's edition column holds a name
   ("Modern Horizons 3") where ManaBox holds a code ("mh3"), so without it the
   printing preference was silently dropped on every Card Kingdom list. The
   existing "narrows but never hides" rule means this only ever adds precision:
   an unmatched set still falls back to every printing.

2. **Not done** — no Card Kingdom-specific format detection, no new CSV
   dialect, no parser branch. The existing column aliases (`card name`,
   `edition`, `foil`, `quantity`) already covered all four fields Card Kingdom
   documents, which was verified by probe before any code was written.

## Correctness notes

- `isNamedPrinting` guards `card.setName` before normalising, since
  `normalizeCardName(null)` returns the string "null" and would otherwise be
  comparable.
- Foil is not used in matching at all, only in display, so the `nonfoil` bug
  mislabelled rows rather than hiding cards. Still worth fixing: a list that
  says FOIL on every line is wrong in a way the reader cannot check.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 317/317 (5 new) |
| Lint | Skipped — no lint script |

## Manual verification

A Card Kingdom-shaped CSV pasted into the live tab, against the published index:

| Check | Result |
|---|---|
| Detected as CSV | Yes — "5 cards read from a CSV export", 0 skipped |
| Availability | "7 of 9 copies available across 5 cards"; 3 available, 2 not stocked |
| Links to where cards are | 11 ManaBox deck links rendered |
| Deck coverage | "Decks covering the most of your list" populated |
| Missing list | "Not stocked (2)", copyable |
| Foil | Only the `foil` row shows FOIL; the three `nonfoil` rows do not |
| Console errors | None |

## Files Reviewed

| File | Change |
|---|---|
| `web/decklist.js` | Modified — `NOT_FOIL` set, `isNamedPrinting` |
| `test/decklist.test.ts` | Modified — 5 tests added |
| `README.md` | Modified — Card Kingdom listed and explained |
