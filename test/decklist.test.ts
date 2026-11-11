import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecklist, matchDecklist, splitCsvRow, looksLikeCsv, frontFace, stockedMessage }
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

/* ---------------------------------------------------------------- *
 * Card Kingdom
 * ---------------------------------------------------------------- */

// Card Kingdom's documented CSV carries card name, edition, foil/nonfoil and
// quantity. The column aliases already cover all four, so the format needs no
// parser of its own -- only the two things it says differently.
const CK = [
  'Card Name,Edition,Foil,Quantity',
  'Lightning Bolt,Modern Horizons 3,nonfoil,4',
  '"Jace, Beleren",Lorwyn,foil,1',
  'Sol Ring,Commander 2021,,2',
].join('\n');

test('a Card Kingdom CSV is read without a parser of its own', () => {
  assert.equal(looksLikeCsv(CK), true);
  const out = parseDecklist(CK);
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.entries.map((e: any) => [e.quantity, e.name]), [
    [4, 'Lightning Bolt'], [1, 'Jace, Beleren'], [2, 'Sol Ring'],
  ]);
});

test('"nonfoil" is not a foil', () => {
  // It contains the word, and Card Kingdom writes it on every ordinary card,
  // so reading it as a positive marked whole lists foil.
  const out = parseDecklist(CK);
  assert.deepEqual(out.entries.map((e: any) => e.foil), [false, true, false]);

  for (const v of ['nonfoil', 'NonFoil', 'non-foil', 'normal', 'regular', 'no', '']) {
    assert.equal(parseDecklist(`Name,Foil\nSol Ring,${v}`).entries[0]!.foil, false, v);
  }
  for (const v of ['foil', 'Foil', 'etched', 'true', 'yes']) {
    assert.equal(parseDecklist(`Name,Foil\nSol Ring,${v}`).entries[0]!.foil, true, v);
  }
});

test('a set named in full narrows the printing, like a set code does', () => {
  // Card Kingdom's edition column says "Modern Horizons 3" where ManaBox says
  // "mh3". Without this the preference was silently dropped on every CK list.
  const index = {
    decks: [deck('a', 10, [
      card('Sol Ring', { setId: 'mh3', setName: 'Modern Horizons 3', quantity: 1 }),
      card('Sol Ring', { setId: 'c21', setName: 'Commander 2021', collectorNumber: '2', quantity: 7 }),
    ])],
  };

  const byName = matchDecklist(index, parseDecklist('Card Name,Edition,Quantity\nSol Ring,Modern Horizons 3,1').entries).matches[0]!;
  assert.equal(byName.available, 1, 'narrowed to the Modern Horizons printing');

  const byCode = matchDecklist(index, parseDecklist('1 Sol Ring (MH3)').entries).matches[0]!;
  assert.equal(byCode.available, 1, 'the set code still works');
});

test('a set we do not stock still shows the card, however it was named', () => {
  // The rule the plain-list path already followed: a named printing narrows
  // but never hides.
  const index = { decks: [deck('a', 10, [card('Sol Ring', { setId: 'mh3', setName: 'Modern Horizons 3', quantity: 4 })])] };
  const m = matchDecklist(index, parseDecklist('Card Name,Edition,Quantity\nSol Ring,Alpha,1').entries).matches[0]!;
  assert.equal(m.status, 'available');
  assert.equal(m.available, 4);
});

test('a Card Kingdom list reports where each card is, and what is missing', () => {
  // The whole point of the tab, driven from a CK file end to end.
  const index = {
    decks: [
      deck('a', 20, [card('Lightning Bolt', { setId: 'mh3', setName: 'Modern Horizons 3', quantity: 4 })]),
      deck('b', 10, [card('Sol Ring', { quantity: 1 })]),
    ],
  };
  const { matches, summary } = matchDecklist(index, parseDecklist(CK).entries);

  const bolt = matches.find((m: any) => m.entry.name === 'Lightning Bolt')!;
  assert.equal(bolt.status, 'available');
  assert.equal(bolt.sources[0]!.deckUrl, 'https://manabox.app/decks/a', 'a link to where it is');

  const sol = matches.find((m: any) => m.entry.name === 'Sol Ring')!;
  assert.equal(sol.status, 'partial', 'two wanted, one stocked');

  const jace = matches.find((m: any) => m.entry.name === 'Jace, Beleren')!;
  assert.equal(jace.status, 'missing');
  assert.deepEqual(jace.sources, []);
  assert.ok(summary.missing >= 1);
});

/* ---------------------------------------------------------------- *
 * The message to the seller
 * ---------------------------------------------------------------- */

const msgFor = (index: any, text: string) =>
  stockedMessage(matchDecklist(index, parseDecklist(text).entries).matches);

test('the message groups by deck, with the deck link under its name', () => {
  // The link is the thing the seller opens, so it travels with the heading
  // rather than being repeated on every line.
  const index = {
    decks: [
      deck('a', 35, [card('Sol Ring', { setId: 'ltc', collectorNumber: '284', quantity: 4 })]),
      deck('b', 10, [card('Lightning Bolt', { setId: 'm11', collectorNumber: '149', quantity: 4 })]),
    ],
  };
  const text = msgFor(index, '2 Sol Ring\n1 Lightning Bolt');

  assert.match(text, /Deck a \(35% off\)/);
  assert.match(text, /https:\/\/manabox\.app\/decks\/a/);
  assert.match(text, /^ {2}2x Sol Ring \(LTC\) #284$/m);
  assert.match(text, /^ {2}1x Lightning Bolt \(M11\) #149$/m);
  // The cards and nothing else: no greeting, no total, no blank edges. The
  // sender writes their own opening, and the counts are on the page already.
  assert.equal(text, text.trim());
  assert.match(text, /^Deck a/);
  assert.match(text, /#149$/);
  // The heading comes before its own cards.
  assert.ok(text.indexOf('Deck a') < text.indexOf('2x Sol Ring'));
});

test('a foil is named as one', () => {
  const index = { decks: [deck('a', null, [card('Sol Ring', { foil: true, quantity: 1 })])] };
  assert.match(msgFor(index, '1 Sol Ring'), /1x Sol Ring \(SET\) #1 \[foil\]/);
});

test('a deck holding two printings is asked for both by name', () => {
  // The reason every printing is kept rather than the first: asking for two of
  // the plain one when the deck has one of each is asking for a card that is
  // not there.
  const index = {
    decks: [deck('a', 20, [
      card('Sol Ring', { setId: 'ltc', collectorNumber: '284', quantity: 1 }),
      card('Sol Ring', { setId: 'c21', collectorNumber: '2', foil: true, quantity: 1 }),
    ])],
  };
  const text = msgFor(index, '2 Sol Ring');
  assert.match(text, /1x Sol Ring \(LTC\) #284$/m);
  assert.match(text, /1x Sol Ring \(C21\) #2 \[foil\]/);
  assert.equal(text.match(/Sol Ring/g)?.length, 2, 'two lines, one per printing');
});

test('a card spills into the next deck only when the first runs short', () => {
  // sources are ordered by discount, so the cheapest deck is emptied first.
  const index = {
    decks: [
      deck('cheap', 35, [card('Sol Ring', { quantity: 2 })]),
      deck('dear', 10, [card('Sol Ring', { quantity: 5 })]),
    ],
  };
  const text = msgFor(index, '3 Sol Ring');
  assert.match(text, /Deck cheap \(35% off\)/);
  assert.match(text, /2x Sol Ring/);
  assert.match(text, /Deck dear \(10% off\)/);
  assert.match(text, /1x Sol Ring/);
  assert.ok(text.indexOf('Deck cheap') < text.indexOf('Deck dear'), 'best discount first');
});

test('the message never asks for more than exists', () => {
  // A request nobody can fill is worse than a short one.
  const index = { decks: [deck('a', null, [card('Sol Ring', { quantity: 2 })])] };
  const text = msgFor(index, '99 Sol Ring');
  assert.match(text, /2x Sol Ring/);
  assert.ok(!text.includes('99x'));
});

test('cards nobody stocks are left out of the message entirely', () => {
  const index = { decks: [deck('a', null, [card('Sol Ring', { quantity: 1 })])] };
  const text = msgFor(index, '1 Sol Ring\n1 Black Lotus');
  assert.ok(!text.includes('Black Lotus'));
  assert.match(text, /1x Sol Ring/);
});

test('nothing stocked produces no message at all', () => {
  const index = { decks: [deck('a', null, [card('Sol Ring')])] };
  assert.equal(msgFor(index, '1 Black Lotus'), '');
  assert.equal(stockedMessage([]), '');
  assert.equal(stockedMessage(null as any), '');
});

test('a printing named in the list is the one asked for', () => {
  // The narrowing rule reaching the message: name a printing and that is what
  // the seller is asked for, not whichever copy came first.
  const index = {
    decks: [deck('a', null, [
      card('Sol Ring', { setId: 'ltc', collectorNumber: '284', quantity: 1 }),
      card('Sol Ring', { setId: 'sld', collectorNumber: '2467', quantity: 1 }),
    ])],
  };
  const text = msgFor(index, '1 Sol Ring (SLD) 2467');
  assert.match(text, /1x Sol Ring \(SLD\) #2467/);
  assert.ok(!text.includes('LTC'));
});
