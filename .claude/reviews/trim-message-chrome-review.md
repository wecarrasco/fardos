# Local Review: strip the greeting and the total from the seller message

**Reviewed**: 2026-11-11
**Branch**: main
**Decision**: APPROVE

`stockedMessage` opened with "Hi! I would like these cards:" and closed with
"N cards from M decks." Both are gone; the message is the deck groups alone.

## Findings

### CRITICAL / HIGH / MEDIUM
None. No logic changed — two lines removed from the output assembly.

### LOW
1. **Added** — `trimEnd()` on the result. Each group pushes a blank separator
   after its cards, which the footer used to absorb. Without it the message
   would end in a stray newline, showing as an empty line when pasted.
   Asserted directly (`text === text.trim()`).

2. **Not changed** — `cart.js` still opens its own message with "Cards I'd
   like:" and closes with a count. That message travels on its own, from a tab
   where the totals are not on screen beside it, and was not what was asked
   about.

## Test changes

Five assertions pinned the footer and had to go. Rather than just delete them,
each test kept an assertion about what it was actually for:

| Test | Was | Now |
|---|---|---|
| groups by deck | `/3 cards from 2 decks\./` | message is trimmed, starts `Deck a`, ends `#149` |
| two printings in a deck | `/2 cards from 1 deck\./` | exactly two `Sol Ring` lines |
| spill across decks | `/3 cards from 2 decks\./` | dropped; deck order already asserted |
| never asks for more | `/2 cards from 1 deck\./` | dropped; `2x` and absence of `99x` already asserted |
| missing cards excluded | `/1 card from 1 deck\./` | `/1x Sol Ring/` |

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 325/325 |
| `grep "cards from"` in tests | None remain |
| Message in the browser | Starts `Artifacts III ☎️ (35% off)`, ends `[foil]`, no greeting, no footer, no blank edges |
| Page summary | Unaffected — still reads `9 of 10 copies available across 4 cards` |
