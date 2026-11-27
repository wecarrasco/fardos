# Local Review: the wishlist takes a search bar, not a paste box

**Reviewed**: 2026-11-27
**Branch**: main
**Decision**: APPROVE

The wishlist shipped with a textarea you paste a list into. That is not what
the tab is for -- you add one card at a time, usually one you just thought of
-- and the user said so plainly. It is a search bar now, with suggestions from
the catalogue, that still accepts a card nobody stocks.

## Findings

### CRITICAL / HIGH
None.

### MEDIUM
1. **Caught by testing the real page, and fixed** -- the first version took
   the box's text verbatim. Typing `sol r`, seeing `Sol Ring` offered in the
   dropdown and pressing Enter silently watched a line called **"sol r"**. A
   search bar makes people expect Enter to mean the suggestion, so the gap
   between what is shown and what is stored had to be closed.

   It is closed in two directions rather than one. `catalogueName` returns the
   catalogue's own spelling for an **exact** match after normalising, so
   `sol ring` is stored as `Sol Ring`. A name nothing matches exactly is still
   added -- holding cards nobody stocks is the whole point -- but the note
   says so out loud: *Nobody stocks "sol r" — watching it as typed.*

   Deliberately **not** autocorrected to the nearest suggestion. A wishlist
   that quietly swaps in a different card is worse than one showing a typo,
   because the typo is visible and the wrong card is not.

### LOW
1. **Reused** -- `suggest()` fills the datalist exactly as the Search tab's
   does, and `.searchbar input` already styles any input inside it, so the new
   field needed no CSS. The orphaned `#wish-add` rule was removed and
   `#decklist` returned to its own.

2. **Still routed through `parseDecklist`** -- so `4 Sol Ring` or
   `1 Sol Ring (SLD) 2467` is understood as a name rather than watched as that
   whole string. A wishlist line is the card name; the rest is dropped.

3. **The note names the card** rather than counting -- one is added at a time,
   and "Sol Ring added" is what tells the reader their typing landed where
   they meant. Only a multi-entry paste falls back to a count.

4. **Focus** -- opening the tab focuses the box, and it is refocused after
   each add, so a run of cards can be typed without reaching for the mouse.

5. **Removed, not kept beside it** -- the textarea is gone rather than offered
   as a second way in. Bulk adding still exists where it belongs: the Decklist
   tab's "Watch these" button.

## Test-rig hazard worth recording

Half an hour went into a failure that was not in the code. The browser held a
**disk-cache copy of the pre-edit `wishlist.js`** (7211 bytes, no
`cache-control`) and would not revalidate, so `app.js` kept failing on an
export the file on disk plainly had -- while `curl` served the right bytes and
Node's suite passed 359/359. A new tab did not clear it; `Cache-Control:
no-store` on the new responses did not evict the old entry. Serving the
preview from a different port did, because the origin changed.

Diagnosed by fetching the module from inside the page and comparing its length
and headers against what the server sends. Worth doing first next time the
browser disagrees with the disk.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass -- 359/359 (3 new, on `catalogueName`) |
| `grep wish-add` across js/css/html | 0 references remain |
| Console errors | None, once served from a clean origin |

## Manual verification

Against the live index, served locally:

| Typed | Result |
|---|---|
| `sol r` (suggestions) | `Sol Ring` offered first |
| `sol ring` | Stored as **Sol Ring**; *Sol Ring added.* |
| `sol r` + Enter | Added as typed, *Nobody stocks "sol r"* |
| `Black Lotus` | Added, same message, correctly |
| `SOL RING` | *Sol Ring is already on the list.*, no duplicate |
| `4 Arcane Signet` | Quantity dropped, *Arcane Signet added.* |
| Empty box | *Type a card name first.* |
| Focus | In the box on open, and after each add |
| Summary | `2 in stock · 2 still waiting.` |

## Not done

- No suggestions for cards outside the seller's catalogue. `legality.json` has
  32,136 real names but is 835 KB the page does not download; a typo like
  `sol r` is now called out rather than prevented.
- The dropdown is the browser's native `<datalist>`, so it cannot show set,
  price or stock beside each name.
