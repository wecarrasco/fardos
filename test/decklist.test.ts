import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecklist, matchDecklist, splitCsvRow, looksLikeCsv, frontFace }
  from '../web/decklist.js';

const names = (r: { entries: any[] }) => r.entries.map((e) => e.name);

/* ---------------------------------------------------------------- *
 * Plain lists
 * ---------------------------------------------------------------- */

test('reads quantities written the common ways', () => {
  const r = parseDecklist('4 Lightning Bolt\n4x Sol Ring\n2 x Island\nSeedborn Muse');
  assert.deepEqual(r.entries.map((e) => [e.quantity, e.name]), [
    [4, 'Lightning Bolt'], [4, 'Sol Ring'], [2, 'Island'], [1, 'Seedborn Muse'],
  ]);
  assert.equal(r.format, 'list');
});

test('reads the printing tail that Arena and Moxfield add', () => {
  const r = parseDecklist('1 Wooded Foothills (MH3) 361\n2 Ocelot Pride (MH3) 38 *F*\n1 Sol Ring (SLD)');
  assert.deepEqual(r.entries.map((e) => [e.name, e.setId, e.collectorNumber, e.foil]), [
    ['Wooded Foothills', 'mh3', '361', false],
    ['Ocelot Pride', 'mh3', '38', true],
    ['Sol Ring', 'sld', null, false],
  ]);
});

test('skips comments, blanks and section headings', () => {
  const r = parseDecklist([
    'Deck', '4 Lightning Bolt', '', '// a note', '# another',
    'Sideboard', '2 Duress', 'Commander:', '1 Kynaios and Tiro of Meletis',
    'Maybeboard', 'Considering',
  ].join('\n'));
  assert.deepEqual(names(r), ['Lightning Bolt', 'Duress', 'Kynaios and Tiro of Meletis']);
});

test('strips the SB: and MB: prefixes from older exports', () => {
  const r = parseDecklist('SB: 2 Duress\nMB: 1 Sol Ring');
  assert.deepEqual(r.entries.map((e) => [e.quantity, e.name]), [[2, 'Duress'], [1, 'Sol Ring']]);
});

test('counts lines that are not cards as skipped', () => {
  const r = parseDecklist('4 Lightning Bolt\n12345\n---\n***');
  assert.deepEqual(names(r), ['Lightning Bolt']);
  assert.equal(r.skipped, 3);
});

test('a card name containing digits is not mistaken for a quantity', () => {
  assert.deepEqual(names(parseDecklist('Borrowing 100,000 Arrows')), ['Borrowing 100,000 Arrows']);
});

/* ---------------------------------------------------------------- *
 * CSV, which is what ManaBox and Moxfield export
 * ---------------------------------------------------------------- */

test('splits CSV rows with quotes, commas and doubled quotes', () => {
  assert.deepEqual(splitCsvRow('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvRow('"a,1",b,"c"'), ['a,1', 'b', 'c']);
  assert.deepEqual(splitCsvRow('"He said ""hi""",x'), ['He said "hi"', 'x']);
  assert.deepEqual(splitCsvRow('a,,c'), ['a', '', 'c']);
});

test('recognises a CSV export by its header', () => {
  assert.equal(looksLikeCsv('Name,Set code,Quantity\nSol Ring,sld,2'), true);
  assert.equal(looksLikeCsv('"Count","Name","Edition"\n"4","Sol Ring","c21"'), true);
  assert.equal(looksLikeCsv('4 Lightning Bolt\n1 Sol Ring'), false);
  assert.equal(looksLikeCsv(''), false);
});

test('reads a ManaBox export', () => {
  const csv = [
    'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity',
    'Sol Ring,sld,Secret Lair Drop,2467,foil,rare,2',
    'Lightning Bolt,m11,Magic 2011,149,normal,common,4',
  ].join('\n');

  const r = parseDecklist(csv);
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.entries.map((e) => [e.quantity, e.name, e.setId, e.collectorNumber, e.foil]), [
    [2, 'Sol Ring', 'sld', '2467', true],
    [4, 'Lightning Bolt', 'm11', '149', false],
  ]);
});

test('reads a Moxfield export, whose columns are named differently', () => {
  const csv = [
    '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Collector Number"',
    '"4","0","Ocelot Pride","mh3","Near Mint","English","foil","38"',
    '"1","0","Seedborn Muse","10e","Near Mint","English","","296"',
  ].join('\n');

  const r = parseDecklist(csv);
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.entries.map((e) => [e.quantity, e.name, e.setId, e.foil]), [
    [4, 'Ocelot Pride', 'mh3', true],
    [1, 'Seedborn Muse', '10e', false],
  ]);
});

test('a quoted name containing a comma survives', () => {
  const r = parseDecklist('Name,Quantity\n"Jace, Beleren",3');
  assert.deepEqual(r.entries.map((e) => [e.quantity, e.name]), [[3, 'Jace, Beleren']]);
});

test('rows without a usable name are skipped, not guessed at', () => {
  const r = parseDecklist('Name,Quantity\nSol Ring,2\n,5\n123,1');
  assert.deepEqual(names(r), ['Sol Ring']);
  assert.equal(r.skipped, 2);
});

test('a missing or unreadable quantity falls back to one copy', () => {
  const r = parseDecklist('Name,Quantity\nSol Ring,\nIsland,abc\nForest,0');
  assert.deepEqual(r.entries.map((e) => e.quantity), [1, 1, 1]);
});

/* ---------------------------------------------------------------- *
 * Matching
 * ---------------------------------------------------------------- */

const card = (name: string, extra: any = {}) => ({
  name, quantity: 2, foil: false, setName: 'Set', setId: 'set',
  collectorNumber: '1', rarity: 'Rare', typeName: 'Creature', ...extra,
});
const deck = (id: string, discount: number | null, cards: any[]) => ({
  id, name: `Deck ${id}`, url: `https://manabox.app/decks/${id}`,
  category: null, discount, updatedAt: null, cardCount: 0, cards,
});

test('reports availability against what is stocked', () => {
  const index = { decks: [deck('a', 10, [card('Sol Ring', { quantity: 3 })])] };
  const { matches } = matchDecklist(index, parseDecklist('2 Sol Ring\n5 Sol Ring\n1 Black Lotus').entries);

  assert.deepEqual(matches.map((m) => [m.status, m.available]), [
    ['available', 3], ['partial', 3], ['missing', 0],
  ]);
});

test('copies are totalled across decks, best discount first', () => {
  const index = {
    decks: [deck('a', 10, [card('Sol Ring', { quantity: 1 })]),
            deck('b', 20, [card('Sol Ring', { quantity: 4 })])],
  };
  const { matches } = matchDecklist(index, parseDecklist('3 Sol Ring').entries);
  assert.equal(matches[0]!.available, 5);
  assert.equal(matches[0]!.sources[0]!.discount, 20, 'the cheaper deck leads');
});

test('a decklist name matches the front face of a double-faced card', () => {
  // Lists write "Invasion of Arcavios"; the index holds the full "a // b" name.
  const index = { decks: [deck('a', null, [card('Invasion of Arcavios // Invocation of the Founders')])] };
  const { matches } = matchDecklist(index, parseDecklist('1 Invasion of Arcavios').entries);
  assert.equal(matches[0]!.status, 'available');
});

test('matching is on the whole name, not a substring', () => {
  // "Bolt" must not drag in every card containing the word.
  const index = { decks: [deck('a', null, [card('Lightning Bolt'), card('Bolt Bend')])] };
  const { matches } = matchDecklist(index, parseDecklist('1 Bolt').entries);
  assert.equal(matches[0]!.status, 'missing');
});

test('a named printing narrows the sources but never hides the card', () => {
  const index = {
    decks: [deck('a', null, [card('Sol Ring', { setId: 'sld', collectorNumber: '2467' })]),
            deck('b', null, [card('Sol Ring', { setId: 'c21', collectorNumber: '1' })])],
  };

  const exact = matchDecklist(index, parseDecklist('1 Sol Ring (SLD) 2467').entries).matches[0]!;
  assert.deepEqual(exact.sources.map((s) => s.deckId), ['a'], 'narrowed to the printing asked for');

  const absent = matchDecklist(index, parseDecklist('1 Sol Ring (XYZ) 9').entries).matches[0]!;
  assert.equal(absent.status, 'available');
  assert.equal(absent.sources.length, 2, 'a printing we lack falls back to the others');
});

test('the summary counts cards and copies separately', () => {
  const index = { decks: [deck('a', null, [card('Sol Ring', { quantity: 1 })])] };
  const { summary } = matchDecklist(index, parseDecklist('4 Sol Ring\n2 Black Lotus').entries);

  assert.equal(summary.lines, 2);
  assert.equal(summary.wantedCopies, 6);
  assert.equal(summary.foundCopies, 1, 'only what can actually be supplied');
  assert.equal(summary.missing, 1);
});

test('deck coverage ranks by how much of the list each deck holds', () => {
  const index = {
    decks: [deck('a', null, [card('One'), card('Two'), card('Three')]),
            deck('b', null, [card('One')])],
  };
  const { summary } = matchDecklist(index, parseDecklist('1 One\n1 Two\n1 Three').entries);
  assert.deepEqual(summary.topDecks.map((d) => d.cards), [3, 1]);
});

test('an empty list produces nothing rather than throwing', () => {
  for (const text of ['', '   ', '// only a comment']) {
    const r = parseDecklist(text);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(matchDecklist({ decks: [] }, r.entries).matches, []);
  }
});

test('frontFace takes the half people type', () => {
  assert.equal(frontFace('Invasion of Arcavios // Invocation of the Founders'), 'Invasion of Arcavios');
  assert.equal(frontFace('Sol Ring'), 'Sol Ring');
});
