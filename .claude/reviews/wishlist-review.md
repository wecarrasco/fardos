# Local Review: a wishlist that watches for cards the seller may not have

**Reviewed**: 2026-11-26
**Branch**: main
**Decision**: APPROVE

A list of cards to watch for, in or out of stock, that says when one turned up
*after* you asked for it and where it is cheapest *now*. Frontend only; the
index and the build are untouched.

## What was asked, and what was deliberately not built

The feature was proposed in two halves. The second -- watching any card, even
one the seller does not stock -- turned out to be the cheap one, because
`parseDecklist`, `matchDecklist` and `firstSeen` already do the work. The first
half's "has this card ever had a better discount" was dropped, and the reason
is recorded in `web/wishlist.js`'s header rather than only in chat:

Measured before deciding. Of 72 decks in the live index, **71 carry a
discount, 70 of them from a Linktree *section heading*** and one from a link
label. Only **3 of 72 ManaBox deck titles mention a percentage at all**. So the
discount exists almost entirely on a page `robots.txt` forbids fetching
([src/scrapers/linktree.ts:122](../../src/scrapers/linktree.ts)), reaching the
index only when a human captures it. A "best ever" built on that would miss
every uncaptured sale and then state a wrong number confidently. "Best right
now" is exact, free, and needs no history.

## Findings

### CRITICAL / HIGH
None. Every interpolation goes through the existing `esc()`. Nothing is
fetched, and no new storage key is read by anything but this feature.

### MEDIUM
1. **Fixed a pre-existing bug in shared code** -- `fmtDate` rendered a bare
   `YYYY-MM-DD` one day early west of Greenwich: `new Date('2026-11-26')` is
   UTC midnight, and `toLocaleDateString` in UTC-3 prints Nov 25. It read
   "ARRIVED today (Nov 25, 2026)" on the 26th. The calendar label is now read
   back in UTC for date-only inputs, which is the zone `firstSeen` was cut
   from; full timestamps keep the reader's own zone. This also corrects the
   "added ..." note that has been on every search row since arrivals shipped
   ([web/app.js:346](../../web/app.js)), verified live.

### LOW
1. **Accepted** -- `resolveWishlist` rebuilds `buildNameIndex` on every call,
   including on each star click via the badge. Measured in the browser against
   the live index: **6.4 ms** for a 3-line list and **5.3 ms** for a 60-line
   one -- the cost is the index build, not the lines, and it is invisible at
   click scale. Caching it would mean owning an invalidation rule for a
   problem that does not exist.

2. **Chosen** -- the arrival test is `firstSeen > addedAt` and nothing else.
   No "last visit" timestamp, no mark-as-read, no state to fall out of step. A
   card already in stock the day you starred it is not an arrival and never
   claims to be; verified live, where starring Mox Amber (`firstSeen`
   2026-11-26) on 2026-11-26 left the badge at 1 rather than 2.

3. **Chosen** -- the tab badge counts arrivals, not lines. A wishlist is a
   standing list; a badge showing its length would sit there permanently and
   mean nothing.

4. **Reused** -- rows are `.dl-row` with the decklist's marks and columns, and
   the box is `#decklist`'s styling with a shorter `min-height`. Two textareas
   that take the same input should not look like different kinds of field. The
   only new CSS is the star and three wishlist-specific overrides.

5. **Changed** -- `cartControl` is now wrapped by `rowControls`, which draws
   both controls, so the cell redraw after a cart press restores the star too.
   Both call sites updated ([web/app.js](../../web/app.js) `cardRow` and the
   delegated handler).

## Behaviour worth stating

- Pasting a decklist into the box watches each card **once**: quantities and
  printings are dropped on purpose, because a wishlist line is a card name.
- A card no deck holds is `waiting`, drawn with a neutral edge rather than the
  decklist's red. The seller never having stocked it is the normal case here,
  not a failure.
- `addedAt` is never refreshed by a second add -- that would erase the wait it
  exists to measure.
- There is no notification. A static site cannot push; the badge is what you
  see when you next open the page. Said plainly to the user before building.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass -- 345/345 (19 new, 326 untouched) |
| Console errors in the browser | None |

## Manual verification

Against the live index, served locally, desktop and 375px:

| Check | Result |
|---|---|
| Arrived / stocked / waiting in one list | `1 arrived since you asked · 1 in stock · 1 still waiting.` |
| Arrival date | `Arrived today (Nov 26, 2026), after you asked for it.` |
| Best discount now | Portal to Phyrexia shows 40%, the best of its 3 decks |
| Star toggles, persists, keeps focus | Yes, `aria-pressed` and title follow |
| Star beside cart Add, and after a stepper redraw | Both survive |
| Starring a card in stock today | Not counted as an arrival |
| Box: `3 Lightning Bolt` + a duplicate + an unknown card | `2 added, 1 already there.`; quantity dropped |
| Empty box, comment-only box | `Type a card name first.` |
| Remove one line, Empty wishlist | Row drops, empty state shown, key cleared |
| All six tabs, URL params, arrow-key roving | Work; `.tabs` already scrolls horizontally |
| Card preview still opens from a result row | Yes |

## Not done

- No autocomplete. A typo simply never matches, which is how the Decklist tab
  already behaves. `legality.json` holds 32,136 real card names and would serve
  one with no new dependency, but it is 835 KB the page does not download
  today. Worth revisiting only if typos actually bite.
- No star in the card preview panel -- only on result rows and in the box.
- The staleness work discussed alongside this (an issue when `decks.json`'s
  `capturedAt` ages, the age shown on the page) is not in this change.
