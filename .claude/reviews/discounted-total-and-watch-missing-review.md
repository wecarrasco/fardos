# Local Review: what the seller would charge, and watching what they lack

**Reviewed**: 2026-11-26
**Branch**: main
**Decision**: APPROVE

Two small things asked for together. The cart now states what the deck
discounts come to, beside the reference value it is derived from. The
decklist's "Not stocked" block gained a button that sends those cards to the
wishlist. Frontend only.

## Findings

### CRITICAL / HIGH
None. No new data is fetched or stored; `describeDiscounted` reads prices and
discounts the index already publishes, and the button reuses `addToWishlist`.

### MEDIUM
1. **Fixed during review** -- the first version rounded only the final sum, so
   the deck rows read $6.32 and $6.85 under a total of $13.18. Each deck's
   discounted subtotal is now rounded to cents before being summed, because
   every one of them is on screen beside the total; a reader checking the
   addition by hand is right to distrust it when it does not come out.
   Arithmetically the end-rounded figure was closer. Agreement with what is
   displayed matters more. Pinned by a test using the real figures.

### LOW
1. **Per deck, never blended** -- the discount belongs to a deck, so the
   arithmetic runs per deck and is summed. A single rate over a mixed cart is
   wrong wherever the decks differ, which is most carts. Verified live on a
   cart holding the same card at 40% and at 35%.

2. **Out-of-range discounts are ignored, not applied** -- `0`, negatives,
   `>= 100`, `NaN` and a string all fall back to full price. A parser fault
   upstream must not be able to invent money or take a cart negative.

3. **Silent when there is nothing to say** -- `describeDiscounted` returns
   null when no deck here offers a discount, rather than printing the
   reference figure a second time under a different label, which would read as
   a confirming source rather than the same number.

4. **The caveat travels with the figure** -- it is in the sentence, not a
   footnote: the discount comes off the seller's own price, which this site
   never sees, so this estimates what they would charge if they priced at
   these references. It is the most quotable number on the page.

5. **`exportBlock` gained an optional fifth argument** for a button beside
   Copy. Both existing callers pass nothing and are unchanged.

6. **The missing list is re-derived on click**, not remembered. Pressing the
   button costs the same as pressing "Check list" (~6 ms), and a stored copy
   could disagree with what is on screen after an index refresh.

7. **Locale** -- a first test expectation hard-coded `USD 75.00`;
   `formatPrice` renders for the reader's locale, so it is `$75.00` under
   Node and `USD 42,60` in the user's browser. The assertion now builds its
   expectation with `formatPrice` and matches the digits.

## Behaviour worth stating

- The button covers "not stocked" only, matching the block it sits in. Cards
  the seller is merely short of are stocked, and are not added.
- Pressing it twice adds nothing and says "Already watching all of them"; the
  label reads "All watched" once every missing card is on the list.
- Unpriced cards are still counted as unpriced rather than free, as in
  `referenceTotal`.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass -- 356/356 (11 new) |
| Console errors in the browser | None from the app (the local preview server reset connections under load) |

## Manual verification

Against the live index, served locally, desktop and 375px:

| Check | Result |
|---|---|
| Cart across two tiers (40% and 35%) | `$6.32` and `$6.85` per deck |
| Rows add up to the total | `6.32 + 6.85 = 13.17`; `8.39 + 9.09 = 17.48` |
| Both vendors | TCGplayer and Card Kingdom each discounted |
| Caveat line | Present, in the same sentence as the figure |
| `Not stocked (2)` with a clean wishlist | `2 cards added to your wishlist.` |
| Button after adding | `All watched`; second press adds nothing |
| Cards land in the wishlist | `2 still waiting.` -- Black Lotus, Mox Sapphire |
| Copy button in the same header | Still works |
| 375px: title + two buttons | One row, no sideways scroll |

## Not done

- The Decklist tab's own "Reference value" line has no discounted figure. The
  helper and the per-allocation `discount` are both there, so it is a few
  lines, but only the cart was asked about.
- Partially-stocked cards cannot be sent to the wishlist in one press -- only
  the "not stocked" ones. Starring them individually still works.
