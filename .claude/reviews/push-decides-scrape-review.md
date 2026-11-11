# Local Review: a push decides for itself whether to scrape

**Reviewed**: 2026-11-10
**Branch**: main
**Decision**: APPROVE

## Summary

Refreshing the deck list needed four steps, the last of which was "remember to
press a button" — and pushing `decks.json` triggered nothing at all, since it
was not in the workflow's path filter. The workflow now decides from the diff
whether a push scrapes. Scope widened beyond the deck list during review,
because testing the predicate against real history showed it would still have
mis-handled index-shape changes.

## Findings

### CRITICAL / HIGH
None. No secrets added; the step reads `github.event.before`/`github.sha`
through `env:` rather than interpolating them into the shell body, so a branch
or ref name cannot break out of the script.

### MEDIUM
1. **Found during review, fixed** — the first version keyed only on
   `decks.json` and `legality.json`. Running the predicate over this repo's real
   commits showed "Filter the search by mana value and colour" classified as
   site-only: it changed `scripts/build-index.ts` to emit new index fields, so
   it would have deployed `--no-scrape` and shipped three filters with no data.
   That is the exact failure this repo has hit twice. Widened to `src/**` and
   `scripts/build-index.ts`, and re-tested.

### LOW
1. **Accepted** — `fetch-depth: 0` on checkout. Needed because the decision
   diffs against the push's base commit, which a shallow clone lacks. This
   repository is small; `legality.json` at 835 KB is the largest file and
   `gh-pages` is a separate orphan branch, so full history is cheap.

2. **Accepted** — the predicate is deliberately over-inclusive. `src/cli/**`
   and `scripts/update-*.ts` do not change the index, but they sit under paths
   that do, so touching them causes a needless three-minute scrape. Enumerating
   exact files would be more rules to keep in sync than the waste is worth, on
   a job that already scrapes twice a day.

3. **Accepted** — an unresolvable `before` (new branch, force-push) scrapes
   rather than skipping. Three wasted minutes against publishing an index
   silently missing decks.

## Validation

| Check | Result |
|---|---|
| YAML parses (`js-yaml`) | Pass — paths, `fetch-depth: 0`, step `if:` conditions as intended |
| Shell syntax (`bash -n`) | Pass — comments between `elif` branches are valid |
| Decision script executed | Pass — all three branches |
| Tests (`npm test`) | Pass — 317/317, untouched by this change |

### The predicate against real history

Extracted from the workflow and run over actual commit pairs:

| Commit | Verdict | Correct? |
|---|---|---|
| `update decks` (decks.json) | SCRAPE | yes — new decks to fetch |
| `Filter the search by format legality` (legality.json) | SCRAPE | yes — every card's `lg` changes |
| `Filter the search by mana value and colour` (build-index.ts) | SCRAPE | yes — **missed by the first version** |
| `Filter without searching...` (web only) | site-only | yes |
| `Read Card Kingdom lists...` (web only) | site-only | yes |
| `Open the card preview from cart rows` (web only) | site-only | yes |

Simulated step runs: `schedule` → `not a push: scrape=true`; push with an
all-zeros `before` → `cannot tell what changed: scrape=true`; push with a real
base → `site-only change: scrape=false`.

## Not verified

The workflow itself has not run. YAML validity, shell syntax, the predicate and
each branch of the decision were all checked locally, but GitHub's own path
filter and `github.event.before` can only be confirmed by a real push.

## Files Reviewed

| File | Change |
|---|---|
| `.github/workflows/update-index.yml` | Modified — push paths, `fetch-depth: 0`, decision step, step conditions |
| `README.md` | Modified — deploy table, deck-list step 3 |
