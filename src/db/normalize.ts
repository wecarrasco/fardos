/**
 * Fold a card name into its searchable form: lowercase, accents stripped, and
 * punctuation flattened to single spaces. Applied identically to stored names
 * and to incoming queries, so "seance" matches the accented spelling and
 * "jace beleren" matches "Jace, Beleren".
 */
export function normalizeCardName(name: string): string {
  return name
    .normalize('NFKD')
    // Combining accent marks, written as escapes so the source stays ASCII.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
