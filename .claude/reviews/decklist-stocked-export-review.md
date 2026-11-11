# Local Review: export the stocked half of a decklist

**Reviewed**: 2026-11-11
**Branch**: main
**Decision**: APPROVE

## Summary

The Decklist tab offered a copyable list of what the seller does not have. It
now offers the other half too. Frontend only; no new data, no new dependency.

## Findings

### CRITICAL / HIGH
None. Both lists go through the existing `esc()`, and the content is card names
already in the published index.

### MEDIUM
None.

### LOW
1. **Accepted** — the two blocks are built by one local `exportBlock()` helper
   rather than written twice. They are the same control with different
   contents, and having them drift apart in markup would be the likelier bug.

2. **Renamed** — `.dl-missing` became `.dl-export`, since it now also styles a
   list of cards that are present. One JS consumer and two CSS rules; both
   updated, and `grep` confirms no reference to the old name remains.

## The one real decision

A short line exports at the number the seller **has**, not the number asked
for: `Math.min(m.wanted, m.available)`. Asking for 99 Sol Rings when 82 exist
would put a figure in the message nobody can fill. This is the rule `cart.js`
already applies to its own message ("the message asks only for what is there"),
so the two ways of leaving this app agree.

Partial lines are included rather than held back. The seller does have some,
and a list that silently omitted them would under-report what is available.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 317/317, untouched |
| `grep dl-missing` | No references remain |

## Manual verification

Against the live published index (72 decks, post-sale):

| Check | Result |
|---|---|
| Both blocks render | `Stocked (3)` and `Not stocked (2)` |
| Stocked contents | `2 Sol Ring` / `4 Lightning Bolt` / `1 Arcane Signet` |
| Not stocked contents | `1 Black Lotus` / `1 Jace, Beleren` — unchanged |
| Short line capped | `99 Sol Ring` asked, 82 in stock, exported as `82 Sol Ring` |
| Line within stock | `4 Lightning Bolt` with 5 in stock stays `4` |
| Console errors | None |

## Not covered

No automated test: the change is presentation inside `renderDecklist`, which
builds a template string against the DOM and has no existing test harness. The
quantity rule it depends on (`wanted` vs `available`) is already covered by
`test/decklist.test.ts`.
