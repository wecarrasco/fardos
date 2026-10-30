# Local Review: format legality filter

**Reviewed**: 2026-10-30
**Branch**: mana-filters
**Decision**: APPROVE

## Summary

Adds a format-legality filter sourced from Scryfall bulk data, extracted into a
committed `legality.json` and joined at build time. Four join hazards were found
by probing before the code was written; each has a regression test. No CRITICAL
or HIGH findings.

## Findings

### CRITICAL
None. No credentials, no SQL, no user-controlled paths. The one network call
lives in a manual command, not the build, and targets a hardcoded Scryfall URL.

### HIGH
None.

### MEDIUM
1. **Accepted** — `scripts/update-legality.ts` sets no fetch timeout on the 25MB
   download. A hung Scryfall connection hangs the command. It is an interactive
   command run a few times a year, Ctrl-C is the remedy, and the build never
   calls it. Adding retry/timeout machinery here would be more code than the
   failure justifies.

2. **Accepted** — `isLegalIn` exists twice: `src/legality.ts` for the build and
   `web/filters.js` for the browser. The project shares `normalizeCardName`
   across that boundary rather than duplicating it, so the precedent argues for
   sharing. Not done because the duplicated part is two lines of bit-testing,
   while the part that would actually cause wrong answers — the *format order* —
   is genuinely shared: the index publishes `legalFormats` and the frontend
   reads positions from it rather than from a list of its own. Both sides have
   tests asserting positional order.

### LOW
1. **Accepted** — `src/legality.ts` imports `ageInDays` from `./decks.js`, which
   is mild coupling between two unrelated data modules. Reuse beat a second
   date helper.

2. **Accepted** — `Readable.fromWeb(res.body as any)` needs a cast to bridge
   Node's and the web's stream types. Unavoidable without a dependency.

## Correctness notes — the four join hazards

Each was found by probing real data before writing the code, and each has a test:

1. **Art Series decoys.** `oracle_cards` carries one row per oracle id, and Art
   Series cards share real card names while being legal nowhere. A first-wins
   name join marked Mortify banned everywhere. Fixed by `NOT_A_CARD`; the real
   run reclaimed 52 names. Covered by the Mortify spot check against the
   shipped file.

2. **Token collisions the other way.** Skipping decoys made ManaBox's own token
   rows match the unrelated real card of the same name. Fixed at the join by
   skipping `typeName === 'Other'`. Covered by the Scarecrow test.

3. **The search key is not a join key.** `normalizeCardName` strips punctuation,
   merging "Rampant Growth" with the playtest card "Rampant, Growth" — which is
   legal in nothing, and the real card is in this seller's stock. Measured: the
   search key collides on 13 of Scryfall's 35,224 non-token cards; the stricter
   `legalityKey` collides on zero. Covered by a test asserting the two keys
   disagree on exactly that pair.

4. **Positional masks.** The bitmask means nothing without its format order, so
   `parseLegalityTable` refuses a file whose own `formats` list differs from the
   build's — including the same formats reordered. Without that check, a
   reordered file would silently read black as white on every card. Three tests.

Other deliberate behaviours, each tested:
- A card with no mask fails every format rather than being guessed either way.
- A card legal in none of the six is omitted rather than stored as `0`.
- An exact name beats a front-face match; a front face two split cards share
  answers for neither.
- `--no-scrape` exits before `loadLegality`, so push builds never need the file.
  Verified by running it: the published index came back byte-identical.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Lint | Skipped — no lint script |
| Tests (`npm test`) | Pass — 306/306 (19 new legality, 13 new filter) |
| `legality:update` | Pass — 32,136 cards in 5.7s |
| `build:index --no-scrape` | Pass — index byte-identical |
| Full `build:index` | Not run — would scrape 61 live decks |

## Manual verification

| Check | Result |
|---|---|
| Facet counts (1001 entries) | Standard 449, Pioneer 681, Modern 769, Legacy 986, Pauper 75, Commander 991 |
| Combined filters | 449 standard → 116 +blue → 7 +MV1 |
| Entries with no legality | 3 of 8,210 non-token, all correct: Nadu (banned in all six), Tinker (banned/restricted), Lila (Unfinity acorn) |
| Rare cards under Pauper | 2, both Secret Lair printings of cards that exist at common — correct, legality is per card and rarity is per printing |
| Index size | 197 → 224 KB gz (+13.4%), matching the 13.5% the probe predicted |
| Console errors | None |

## Files Reviewed

| File | Change |
|---|---|
| `src/legality.ts` | Added — table model, join key, lookup, validation |
| `scripts/update-legality.ts` | Added — bulk download, extract, diff, write |
| `legality.json` | Added — 32,136 cards, 835 KB, never shipped to the browser |
| `test/legality.test.ts` | Added — 19 tests |
| `scripts/build-index.ts` | Modified — join, `lg` field, `legalFormats` root |
| `web/filters.js` | Modified — `isLegalIn`, format facet, filter, prune |
| `web/app.js` | Modified — format control, `legalFormats()` from the index |
| `test/filters.test.ts` | Modified — 13 tests added |
| `package.json` | Modified — `legality:update` script |
| `README.md` | Modified — refresh procedure and command table |
