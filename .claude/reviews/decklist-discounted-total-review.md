# Local Review: the discounted total on the decklist too

**Reviewed**: 2026-11-26
**Branch**: main
**Decision**: APPROVE

The cart gained "with each deck's discount" in the previous commit; the
Decklist tab's summary was left stating a reference value alone. Asked for
afterwards, and listed as "not done" in
[that review](discounted-total-and-watch-missing-review.md). Same helper, same
wording, one caller.

## Findings

### CRITICAL / HIGH / MEDIUM
None. No new helper, no new state, no new storage. `describeDiscounted` was
already imported for the cart.

### LOW
1. **The regrouping is the whole change, and it matters.** `allocateStock`
   returns a flat list that can name the same deck more than once -- one card
   spilling into a second deck, a later card spilling back. Feeding that list
   to `discountedTotal` as one group per allocation would round that deck's
   subtotal once per appearance instead of once. Measured live: a three-line
   list produced **3 allocations that collapsed to 1 deck**, and a
   deliberately spilling one produced **19 allocations across 10 decks**.

2. **Worded identically to the cart.** The same figure answering the same
   question should not read as two different claims, so the caveat sentence is
   copied verbatim rather than paraphrased.

3. **No test added.** The arithmetic is covered by the eleven tests on
   `discountedTotal`/`describeDiscounted`; what is new here is five lines of
   `Map` accumulation inside a render function the suite does not reach. It
   was verified in the browser instead, by recomputing the figure
   independently from the index and comparing it to what the page printed.

4. **Not changed** -- "Decks covering the most of your list" still counts
   cards, not money. A discounted figure there would answer a question that
   section does not ask.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass -- 356/356, unchanged |
| Console errors from the app | None (the local preview server reset connections under load) |

## Manual verification

Against the live index, served locally:

| Check | Result |
|---|---|
| `12 Sol Ring / 4 Arcane Signet / 1 Black Lotus` | 3 allocations regrouped to 1 deck; $23.38 -> $15.20 at 35% |
| `60 Sol Ring / 40 Lightning Bolt` | 19 allocations regrouped to 10 decks |
| Per-deck figures add up to the total | $85.57 = $85.57, exactly |
| Both vendors | $85.57 TCGplayer, $134.07 Card Kingdom |
| Wording and styling | Identical to the cart's line |
