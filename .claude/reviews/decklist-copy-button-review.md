# Local Review: a copy button on each export block

**Reviewed**: 2026-11-11
**Branch**: main
**Decision**: APPROVE

## Summary

Both export blocks gain a Copy button. Frontend only, no new dependency, no
change to any data the page holds.

## Findings

### CRITICAL / HIGH
None. Nothing new is interpolated into markup; the button is static and the
text it copies comes from the textarea already rendered through `esc()`.

### MEDIUM
None.

### LOW
1. **Accepted** — the handler is delegated from `resultsEl` rather than bound
   per button, because both blocks are rebuilt on every check. `resultsEl` is
   shared across tabs, but `[data-copy]` exists only in decklist output, so the
   listener cannot fire elsewhere.

2. **Accepted** — the label is restored by a 2.5s `setTimeout` that may fire
   after the block has been rebuilt. Writing `textContent` on a detached node
   is harmless, so no cancellation is kept.

3. **Deliberately different from the cart's copy button** — the cart injects a
   fallback textarea when the clipboard is refused, because its message is not
   otherwise on screen. Here the text is already visible, so the fallback
   selects the existing box instead of printing the message twice.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests (`npm test`) | Pass — 325/325, untouched |

## Manual verification

| Check | Result |
|---|---|
| Buttons rendered | 2, one per block, both labelled "Copy" |
| Clicking one | Selects that block's textarea, label becomes "Press Ctrl/Cmd+C" |
| The other button | Unchanged — the handler acts only on its own block |
| Label restore | Returns to "Copy" after the timeout |
| Console errors | None |

## Not verified — the success path

This browser pane reports `clipboard-write: denied` in a secure context, so
`navigator.clipboard.writeText` throws `NotAllowedError` here no matter what.
Every click in testing therefore took the fallback branch. That branch is the
one that matters for robustness and it is confirmed working, but the "Copied"
label and the actual clipboard write could not be exercised and rest on the
same API call the cart's copy button has been shipping with.
