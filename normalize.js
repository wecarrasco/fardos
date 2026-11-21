/**
 * Fold a card name into its searchable form: lowercase, accents stripped, and
 * punctuation flattened to single spaces.
 *
 * Plain JavaScript on purpose. The build script imports it to precompute the
 * folded name of every card, and the browser imports the same file to fold the
 * query. One implementation, so the two can never drift apart.
 */
export function normalizeCardName(name) {
  return String(name)
    .normalize('NFKD')
    // Combining accent marks, written as escapes so the source stays ASCII.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
