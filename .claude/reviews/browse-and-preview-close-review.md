# Local Review: filter without a query, and a way out of the card preview

**Reviewed**: 2026-10-30
**Branch**: main
**Decision**: APPROVE

## Summary

Two user-reported problems. The filters could not be used without typing a card
name, and on a phone the card preview had no dismissal that worked. Both fixed;
one new render cap added because the first fix can now produce an 8,500-row
result. No CRITICAL or HIGH findings.

## Findings

### CRITICAL / HIGH
None. No new network, storage, or untrusted input. The one new piece of markup
is a static close button with no interpolated data.

### MEDIUM
1. **Pre-existing, now mitigated** — `renderResults` drew every row it was
   given. That was survivable while `search()` capped itself at 2000 upstream,
   but browsing the catalogue can hand it 8,935. Added `MAX_ROWS = 2000` at the
   draw, matching the ceiling search already used (~28,000 DOM nodes). The
   summary and every facet still count the whole result, and the note says so.

2. **Accepted** — `allCards()` is deliberately uncapped. Capping it would make
   the facet counts describe a slice while claiming to describe the catalogue,
   which is worse than drawing fewer rows. The cap belongs at the draw, and is
   there.

### LOW
1. **Accepted** — the landing page now shows a filter bar above a prompt and no
   rows. Drawing 8,935 rows for someone who has asked for nothing is neither
   fast nor useful, and the prompt names both routes ("Type a card name above,
   or use the filters to search all 8,935 cards"). Verified: 0 rows drawn.

2. **Accepted** — the close button is hidden while the panel is merely hovered
   (`.cardpreview.is-pinned .cp-close`). A mouse dismisses by moving away, so
   the button would be an obstacle rather than an exit. It appears as soon as
   the panel is pinned, which is always the case on touch.

## Why the preview needed this

At <=560px the panel is `position: fixed` with all four insets at 8px, so it
covered 359x796 of a 375x812 viewport. Every dismissal it had was unreachable
there: tapping outside had essentially no target, the anchor to tap again sat
underneath the panel, and Escape needs a keyboard. Scroll-to-dismiss is
disabled while pinned, which touch always is. It was a trap, not an
inconvenience. The button is 44x44 on phones and 34x34 elsewhere.

`stopPropagation` on the button's click is deliberate: the document-level
dismissal would otherwise also fire on the same event.

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 312/312 (6 new for `allCards`) |
| Lint | Skipped — no lint script |

## Manual verification

Against the live published index (8,935 entries, 69 decks):

| Check | Result |
|---|---|
| Landing page, no query | Full filter bar, 0 rows, prompt naming both routes |
| Filter with no query — Pauper | 1,803 entries, 1,803 drawn, no cap note |
| Filter with no query — Commander | 8,531 counted in the summary, 2,000 drawn, cap note shown |
| Preview close, 375px | Button 44x44 at top-right; closes, sets aria-hidden, collapses the anchor, returns focus to it |
| Reopen after closing | Works, and closes again |
| Preview close, desktop | Pinned panel shows a 34x34 button on a 320px panel |
| Console errors | None |

## Files Reviewed

| File | Change |
|---|---|
| `web/search.js` | Modified — `allCards()` added |
| `web/app.js` | Modified — `browseAll()`, `MAX_ROWS`/`capRows`, stale prompt removed |
| `web/preview.js` | Modified — close button markup and handler |
| `web/app.css` | Modified — `.cp-close`, plus a larger target under 560px |
| `test/search.test.ts` | Modified — 6 tests added |
