# Local Review: mana value and colour filters

**Reviewed**: 2026-10-30
**Branch**: mana-filters
**Decision**: APPROVE

## Summary

Adds two search filters built from data ManaBox already sends and the index
was discarding. No new network dependency, no new build failure mode. One
declaration-order hazard found and fixed during review; nothing else above LOW.

## Findings

### CRITICAL
None. The change touches no credentials, no SQL, no file paths, and no
network input. The only new HTML is built from the `COLOURS` and
`COLOUR_MODES` constants, not from index data, and is escaped with the
existing `esc()` regardless.

### HIGH
None.

### MEDIUM
None introduced.

Pre-existing, not from this diff: `web/app.js` is 1302 lines, above the
800-line guideline. This change adds 47 of them. Worth splitting the filter
bar out of `app.js` eventually; not this commit's job.

### LOW
1. **FIXED during review** — `web/filters.js`: `emptyFilters()` referenced
   `DEFAULT_COLOUR_MODE` fifty lines before its `const` declaration. Safe only
   because nothing calls `emptyFilters()` during module evaluation; any future
   module-level call would have thrown a temporal-dead-zone ReferenceError.
   Moved the constant above its first use.

2. **Accepted** — the colour chips show a single letter, with the full name and
   count on `aria-label`/`title` rather than visible. Deliberate: six named
   chips with counts would overflow 375px. Screen readers get the full label.

3. **Accepted** — the filter bar is now 279px tall at 375px wide, up from 213px.
   No horizontal scroll. Flagged to the user; collapsing the bar behind a
   toggle is the follow-up, not a blocker.

## Correctness notes

- `matchesColours` returns `false` for a card with no recorded identity under
  all three modes, including `at-most`. Intentional and tested: not knowing a
  card's colours is not the same as it having none.
- `identity()` deliberately bypasses `str()`, which maps `''` to `null` and
  would have merged "colourless" into "unknown". This was a real bug caught by
  a probe before the code was written, and it has a regression test.
- `manaBucket` floors and clamps, so a negative or fractional mana value cannot
  produce an out-of-range bucket.
- `mv: 0` is written to the index rather than omitted, and `isFiltered` treats
  `manaValue: 0` as a choice. Verified in a browser, since 0 is falsy.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Lint | Skipped — no lint script in package.json |
| Tests (`npm test`) | Pass — 275/275 |
| Build | Skipped — `build:index` performs live scraping |

## Manual verification

Against the published index with mv/ci present:

| Check | Result |
|---|---|
| `U`+`R` including / exactly / at most | 57 / 21 / 345 — correctly nested |
| `exactly C` | 91, matching the Colorless facet count |
| `at most W` vs `including W` | 210 vs 246; 210 = 119 mono-white + 91 colourless |
| Mana value 0 | 61 of 66, select renders active despite 0 being falsy |
| Unknown-identity cards | Matched by no colour selection, in any mode |
| 375px viewport | No horizontal scroll; chip row 183px |
| Console errors | None |

## Files Reviewed

| File | Change |
|---|---|
| `src/scrapers/manabox.ts` | Modified — `colorIdentity` on `DeckCard`, `identity()` helper |
| `scripts/build-index.ts` | Modified — `mv` and `ci` on `IndexCard` |
| `web/filters.js` | Modified — colour set model, three modes, mana buckets |
| `web/app.js` | Modified — colour chips, mode select, handlers |
| `test/filters.test.ts` | Modified — 18 tests added |
| `test/manabox.test.ts` | Modified — 3 tests added |
