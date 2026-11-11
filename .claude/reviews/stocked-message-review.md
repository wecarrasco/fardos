# Local Review: the stocked list becomes a message to the seller

**Reviewed**: 2026-11-11
**Branch**: main
**Decision**: APPROVE

## Summary

The stocked export was a bare `quantity name` list. It now carries the set,
collector number, foil and the deck's link, grouped by deck. A regression was
introduced and caught in the browser during this change; it is described below
rather than quietly fixed.

## Findings

### CRITICAL
None.

### HIGH
1. **Introduced and fixed in this change** — `sources[].card` was replaced by
   `sources[].cards` so a deck's several printings survive. A grep for
   consumers used the pattern `sources\.`, which cannot match `s.card.prices`,
   and that one call site in the price-total block was missed. The result threw
   `Cannot read properties of undefined (reading 'prices')` and rendered an
   empty Decklist tab. Caught by loading the page, not by the tests — nothing
   covers `renderDecklist`'s DOM output. Fixed by routing that block through
   `allocateStock()`.

   The lesson is the grep, not the rename: searching for `sources.` to find
   uses of a field on a `source` object was the wrong pattern.

### MEDIUM
1. **Fixed during the above** — the price-total block already contained its own
   copy of the allocation rule (best deck first, capped at wanted), which
   `stockedMessage` then duplicated. Both now call `allocateStock()`, so the
   figure shown and the request sent agree on which copies they mean. The total
   also improved: it prices each printing rather than applying the first
   printing's price to a whole deck's worth.

### LOW
1. **Accepted** — `allocateStock` is greedy over `sources`, which is ordered by
   discount then quantity. It does not try to minimise the number of decks a
   buyer must deal with. Cheapest-first is what someone buying would do and
   matches the order the page already displays.

## Behaviour worth stating

- A deck holding a foil and a plain copy is asked for both by name, rather than
  for two of whichever printing happened to be seen first. This is why
  `sources[].cards` is a list.
- A card stocked in several decks spills from the best-discounted deck into the
  next only when the first runs short.
- Nothing is ever asked for beyond what exists.
- Cards the seller does not stock are absent from the message entirely; they
  remain in the "Not stocked" block.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 325/325, 8 new |
| Console errors after the fix | None (the error seen afterwards is a stale buffer entry; the served file contains neither `flatMap` nor `s.card.prices`) |

New tests cover: grouping with the link under the deck name, foil marking,
two printings in one deck, spill across decks in discount order, the cap at
what exists, missing cards excluded, empty input, and a named printing
reaching the message.

## Manual verification

Against the live index (72 decks, post-sale):

| Check | Result |
|---|---|
| Grouped message | Two decks, each with name, discount and URL |
| Line format | `3x Sol Ring (SOC) #128`, `4x Lightning Bolt (MSC) #806 [foil]` |
| Footer | `9 cards from 2 decks.` |
| Per-printing spread | `99 Sol Ring` → ten printings named within one deck, then spilling to the next |
| Reference value | Still computed; summary reads `82 of 99 copies available` |
| Not stocked block | Unchanged |

## Not covered

`renderDecklist` still has no automated test — it builds a template string
against the DOM. That is precisely the gap the HIGH finding above fell through,
and it remains open.
