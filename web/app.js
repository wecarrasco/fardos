import { CONFIG, repoUrl, actionsUrl } from './config.js';
import { search, suggest, allCards } from './search.js';
import { normalizeCardName } from './normalize.js';
import { newArrivals, arrivalCutoff, isNewCard } from './arrivals.js';
import { createPreview } from './preview.js';
import { betterDealFor, categoryLabel, sortCardTypes } from './cards.js';
import { cardPrice, formatPrice, describeTotals, describeDiscounted } from './prices.js';
import { parseDecklist, matchDecklist, stockedMessage, allocateStock } from './decklist.js';
import {
  emptyFilters, isFiltered, facetsFor, applyFilters, pruneFilters, COLOUR_MODES, formatLabel,
} from './filters.js';
import { DEFAULT_SORT, SORT_LABELS, availableSorts, isSorted, pruneSort, sortResult } from './sorting.js';
import {
  addToCart, cartCount, cartMessage, loadCart, removeLine, resolveCart, saveCart,
  setQuantity, wantedFrom,
} from './cart.js';
import {
  addToWishlist, catalogueName, inWishlist, loadWishlist, removeWish, resolveWishlist,
  saveWishlist, wishKey,
} from './wishlist.js';

const $ = (id) => document.getElementById(id);
const qInput = $('q');
const resultsEl = $('results');
const summaryEl = $('summary');
const emptyEl = $('empty');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The whole backend, once loaded. */
let index = null;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Wrap the matched parts of a card name in <mark>, matching on the folded form.
 *
 * Mirrors how search ranks: the whole query is marked when it appears as a
 * phrase, and otherwise each word is marked wherever it lands -- so a reader
 * who typed "bolt lightning" can still see why a result matched.
 */
function highlight(name, query) {
  const nq = normalizeCardName(query);
  if (!nq) return esc(name);

  // Walk the original string tracking its normalized offset, so the marks land
  // correctly even where accents or punctuation were folded away.
  let normed = '';
  const map = [];
  for (let i = 0; i < name.length; i++) {
    const piece = normalizeCardName(name[i]);
    if (!piece) {
      if (normed.length && !normed.endsWith(' ')) { normed += ' '; map.push(i); }
      continue;
    }
    for (const ch of piece) { normed += ch; map.push(i); }
  }

  /** Normalized offsets to mark, as [start, end) pairs. */
  const spans = [];
  const addAll = (needle) => {
    if (!needle) return;
    for (let at = normed.indexOf(needle); at !== -1; at = normed.indexOf(needle, at + needle.length)) {
      spans.push([at, at + needle.length]);
    }
  };

  if (normed.includes(nq)) addAll(nq);
  else for (const w of nq.split(' ')) addAll(w);
  if (!spans.length) return esc(name);

  // Merge overlaps so nested <mark> elements cannot be produced.
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const [from, to] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }

  // Translate back to offsets in the original string.
  const at = (i) => (i < map.length ? map[i] : name.length);
  let out = '';
  let cursor = 0;
  for (const [from, to] of merged) {
    const start = at(from);
    const end = at(to);
    out += esc(name.slice(cursor, start)) + '<mark>' + esc(name.slice(start, end)) + '</mark>';
    cursor = end;
  }
  return out + esc(name.slice(cursor));
}

const fmtDate = (iso) => {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return 'unknown';
  const days = Math.floor((Date.now() - d) / 86400000);
  // A bare YYYY-MM-DD parses as UTC midnight, so west of Greenwich
  // toLocaleDateString would print the day before -- "today (Nov 25)" on the
  // 26th. Those dates are cut from the build's UTC timestamp, so the calendar
  // label is read back in UTC. Full timestamps keep the reader's own zone.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const abs = d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  });
  if (days <= 0) return `today (${abs})`;
  if (days === 1) return `yesterday (${abs})`;
  return `${days} days ago (${abs})`;
};

/** Cards arriving on or after this date get a NEW badge in either tab. */
let newBadgeCutoff = null;

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

const filtersEl = $('filters');
let filters = emptyFilters();
/** Result order. Kept apart from the filters: it narrows nothing. */
let sort = DEFAULT_SORT;

/** Cards to ask the seller for. Identity and quantity only; see cart.js. */
let cart = loadCart();

/** Cards to watch for, in or out of stock; see wishlist.js. */
let wishlist = loadWishlist();

/**
 * Today, as the index writes dates.
 *
 * UTC rather than local, because `firstSeen` is cut from the build's UTC
 * timestamp. Comparing a local date against those would make a card look like
 * an arrival, or not, depending on which side of midnight the reader is.
 */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * The vendor that price sorting and the price ceiling read. The first one
 * published, so the order matches the leftmost figure on every row.
 */
const priceSource = () => index?.priceSources?.[0] ?? null;
/**
 * The formats each card's legality mask is written against, in bit order.
 * Read from the index rather than listed here, so an index built before the
 * filter existed simply offers no formats instead of misreading its numbers.
 */
const legalFormats = () => index?.legalFormats ?? [];
/** The unfiltered result, kept so changing a filter need not redo the search. */
let lastResult = null;
/** What to call when a filter changes. */
let rerender = () => {};

/**
 * A block of text to take away, with its own copy button.
 *
 * Shared by the decklist and the cart: both end in "here is the list, now
 * send it", and a second implementation would drift.
 *
 * @param {string} title
 * @param {number|string} count shown beside the title
 * @param {string} hint one line under it
 * @param {string} body the text itself; empty means no block at all
 * @param {string} [extra] markup for another button beside Copy
 */
const exportBlock = (title, count, hint, body, extra = '') => (body ? `
  <div class="dl-export">
    <div class="dl-export-head">
      <h2 style="font-size:15px;margin:0">${esc(title)} (${count})</h2>
      ${extra}
      <button type="button" class="btn secondary" data-copy>Copy</button>
    </div>
    <div class="setinfo">${esc(hint)}</div>
    <textarea readonly rows="${Math.min(16, body.split('\n').length + 1)}">${esc(body)}</textarea>
  </div>` : '');

/** A <select> whose first option means "no restriction". */
function selectControl(key, anyLabel, options, current, format = (o) => o.label) {
  if (!options.length) return '';
  const opts = options.map((o) =>
    `<option value="${esc(o.value)}"${String(current) === String(o.value) ? ' selected' : ''}>` +
    `${esc(format(o))} (${o.count})</option>`).join('');
  return `<select data-filter="${key}" class="${current !== null ? 'on' : ''}"
                  aria-label="${esc(anyLabel)}">
            <option value="">${esc(anyLabel)}</option>${opts}
          </select>`;
}

function renderFilters(unfiltered, filtered, facets, sorts) {
  // Reordering one row is not reordering, so the control stays away until
  // there is something for it to do.
  const canSort = sorts.length > 1 && unfiltered.hitCount > 1;
  const anyControl = canSort || facets.foil || facets.rarity.length || facets.typeName.length ||
                     facets.setId.length || facets.discount.length || facets.maxPrice.length ||
                     facets.manaValue.length || facets.colour.length || facets.format.length;
  if (!anyControl) { filtersEl.hidden = true; filtersEl.innerHTML = ''; return; }

  const sortControl = canSort
    ? `<select data-sort class="${isSorted(sort) ? 'on' : ''}" aria-label="Sort results">
         ${sorts.map((v) =>
           `<option value="${esc(v)}"${v === sort ? ' selected' : ''}>${esc(SORT_LABELS[v])}</option>`)
          .join('')}
       </select>
       <span class="fsep" aria-hidden="true"></span>`
    : '';

  const seg = facets.foil
    ? `<div class="seg" role="group" aria-label="Finish">
         ${[['all', 'All'], ['foil', `Foil (${facets.foil.foil})`], ['nonfoil', `Non-foil (${facets.foil.nonfoil})`]]
           .map(([v, label]) =>
             `<button type="button" data-foil="${v}" class="${filters.foil === v ? 'on' : ''}"
                      aria-pressed="${filters.foil === v}">${esc(label)}</button>`)
           .join('')}
       </div>`
    : '';

  // Letters rather than names, so six chips fit a phone without scrolling; the
  // name and count ride along on the label for anyone who needs them.
  const chips = facets.colour.length
    ? `<div class="seg" role="group" aria-label="Colours">
         ${facets.colour.map((o) =>
           `<button type="button" data-colour="${esc(o.value)}"
                    class="${filters.colours.includes(o.value) ? 'on' : ''}"
                    aria-pressed="${filters.colours.includes(o.value)}"
                    aria-label="${esc(o.label)} (${o.count})"
                    title="${esc(o.label)} (${o.count})">${esc(o.value)}</button>`).join('')}
       </div>`
    : '';

  // The mode says nothing until something is ticked, so it waits until then --
  // the same reason the sort control stays away from a single row.
  const colourMode = facets.colour.length && filters.colours.length
    ? `<select data-colour-mode class="on" aria-label="How to match the ticked colours">
         ${COLOUR_MODES.map(([v, label]) =>
           `<option value="${esc(v)}"${v === filters.colourMode ? ' selected' : ''}>${esc(label)}</option>`)
          .join('')}
       </select>`
    : '';

  filtersEl.hidden = false;
  filtersEl.innerHTML =
    sortControl +
    seg +
    selectControl('maxPrice', 'Any price', facets.maxPrice, filters.maxPrice) +
    selectControl('rarity', 'Any rarity', facets.rarity, filters.rarity) +
    selectControl('typeName', 'Any type', facets.typeName, filters.typeName) +
    selectControl('manaValue', 'Any mana value', facets.manaValue, filters.manaValue,
      (o) => `Mana value ${o.label}`) +
    chips + colourMode +
    selectControl('format', 'Any format', facets.format, filters.format,
      (o) => `Legal in ${formatLabel(o.value)}`) +
    selectControl('setId', 'Any set', facets.setId, filters.setId) +
    selectControl('minDiscount', 'Any discount', facets.discount, filters.minDiscount,
      (o) => `${o.value}% off or better`) +
    // The reset offers to undo whatever is actually in effect, and the count
    // only appears when something was removed -- "20 of 20 shown" is noise.
    (isFiltered(filters) || isSorted(sort)
      ? `<button type="button" class="clear">${isFiltered(filters) ? 'Clear filters' : 'Reset order'}</button>` +
        (isFiltered(filters)
          ? `<span class="count-note">${filtered.hitCount} of ${unfiltered.hitCount} shown</span>`
          : '')
      : '');
}

filtersEl.addEventListener('click', (ev) => {
  const foil = ev.target.closest('[data-foil]');
  if (foil) { filters.foil = foil.dataset.foil; return rerender(); }

  const colour = ev.target.closest('[data-colour]');
  if (colour) {
    const code = colour.dataset.colour;
    filters.colours = filters.colours.includes(code)
      ? filters.colours.filter((c) => c !== code)
      : [...filters.colours, code];
    return rerender();
  }
  if (ev.target.closest('.clear')) {
    filters = emptyFilters();
    sort = DEFAULT_SORT;
    return rerender();
  }
});

filtersEl.addEventListener('change', (ev) => {
  const order = ev.target.closest('[data-sort]');
  if (order) { sort = order.value; return rerender(); }

  const mode = ev.target.closest('[data-colour-mode]');
  if (mode) { filters.colourMode = mode.value; return rerender(); }

  const sel = ev.target.closest('[data-filter]');
  if (!sel) return;
  const key = sel.dataset.filter;
  const raw = sel.value;
  const numeric = key === 'minDiscount' || key === 'maxPrice' || key === 'manaValue';
  filters[key] = raw === '' ? null : (numeric ? Number(raw) : raw);
  rerender();
});

/** Filter, draw, and refresh the bar. Shared by the search and arrivals tabs. */
function renderFiltered(result, opts, onRerender, draw = renderResults) {
  lastResult = result;
  rerender = onRerender;

  // Prune before applying, never after. A filter the new results cannot satisfy
  // would otherwise be applied once -- emptying the page -- and only then
  // dropped, leaving the reader looking at nothing with no filter to clear.
  const source = priceSource();
  const facets = facetsFor(result, source, legalFormats());
  const sorts = availableSorts(result, source);
  filters = pruneFilters(filters, facets);
  sort = pruneSort(sort, sorts);

  // Narrow first, then order: sorting rows that are about to be dropped is
  // work for nothing, and the deck order depends on which cards survive.
  const filtered = sortResult(applyFilters(result, filters, source, legalFormats()), sort, source);
  renderFilters(result, filtered, facets, sorts);
  draw(filtered, opts);
}

/**
 * Cards in the current render, addressed by index. The preview maps a clicked
 * element back through this rather than reading data attributes, which keeps
 * the whole card object available without serialising it into the DOM.
 */
let rendered = [];

/**
 * Note on a card row when the identical printing is cheaper in another deck.
 * Kept to one short line: it is a nudge, not the main content of the row.
 */
function cheaperElsewhere(card, deck) {
  const better = betterDealFor(index, card, { id: deck.deckId, discount: deck.discount });
  if (!better) return '';
  return `<div class="cheaper">${better.discount}% off in
            <a href="${esc(better.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(better.deckName)}</a>
            &middot; ${better.quantity} there</div>`;
}

/**
 * One card row. Shared by search results, new arrivals and deck browsing, so
 * the foil and NEW badges, printing detail and cheaper-elsewhere note behave
 * identically wherever a card appears.
 *
 * Registers the card in `rendered` so the preview can map the button back to
 * it without serialising the card into the DOM.
 */
function cardRow(c, deck, opts = {}) {
  const isNew = opts.allNew || isNewCard(c, newBadgeCutoff);
  const ref = rendered.push({ card: c, deckId: deck.deckId }) - 1;

  return `
    <tr>
      <td class="qty">${c.quantity}&times;</td>
      <td>
        <button type="button" class="name" data-card="${ref}"
                aria-expanded="false" aria-haspopup="dialog"
                title="Show ${esc(c.name)}">${opts.query ? highlight(c.name, opts.query) : esc(c.name)}</button>
        ${c.foil ? '<span class="foil">FOIL</span>' : ''}
        ${isNew ? '<span class="new-badge">NEW</span>' : ''}
        <div class="setinfo">
          ${esc(c.setName ?? 'Unknown set')}${c.setId ? ` (${esc(c.setId.toUpperCase())})` : ''}
          ${c.collectorNumber ? ` #${esc(c.collectorNumber)}` : ''}
          ${c.rarity ? ` &middot; ${esc(c.rarity)}` : ''}
          ${c.typeName ? ` &middot; ${esc(c.typeName)}` : ''}
          ${c.firstSeen && isNew ? ` &middot; <span class="arrived">added ${esc(fmtDate(c.firstSeen))}</span>` : ''}
        </div>
        ${priceNote(c)}
        ${cheaperElsewhere(c, deck)}
      </td>
      <td class="cartcell">${rowControls(c, deck.deckId, ref)}</td>
    </tr>`;
}

/**
 * Both of a row's controls, so the one cell can be redrawn in one go after
 * either is pressed.
 */
const rowControls = (card, deckId, ref) =>
  cartControl(card, deckId, ref) + wishControl(card, ref);

/**
 * Watch-this-card toggle.
 *
 * Beside the cart button rather than inside the card panel because the two are
 * the same decision made differently: the cart is "I want this copy, from this
 * deck", the star is "tell me about this card wherever it turns up". A card not
 * in stock has no row at all, which is what the Wishlist tab's box is for.
 */
function wishControl(card, ref) {
  const on = inWishlist(wishlist, card.name);
  return `<button type="button" class="wish-star${on ? ' is-on' : ''}" data-wish="${ref}"
                  aria-pressed="${on}"
                  title="${on ? esc(card.name) + ' is in your wishlist' : 'Watch for ' + esc(card.name)}"
          >${on ? '&#9733;' : '&#9734;'}</button>`;
}

/**
 * Add-to-cart control for one row.
 *
 * Becomes a stepper once the card is in the cart, so the same corner of the row
 * both adds and adjusts. The plus disables at the deck's own stock rather than
 * letting someone ask for four copies of a card the seller has two of.
 */
function cartControl(card, deckId, ref) {
  const want = wantedFrom(cart, deckId, card);
  const cap = card.quantity ?? 0;
  if (!cap) return '';

  if (!want) {
    return `<button type="button" class="cart-add" data-add="${ref}"
                    title="Add ${esc(card.name)} to the cart">Add</button>`;
  }
  return `<span class="stepper" role="group" aria-label="Copies of ${esc(card.name)} in the cart">
            <button type="button" data-step="${ref}" data-by="-1" aria-label="One fewer">&minus;</button>
            <b>${want}</b>
            <button type="button" data-step="${ref}" data-by="1" aria-label="One more"
                    ${want >= cap ? 'disabled title="That is all this deck has"' : ''}>+</button>
          </span>`;
}

/**
 * Reference prices for one card, one figure per published vendor.
 *
 * Every figure is labelled with whose price it is. A bare number beside a
 * discount badge would read as the seller's asking price, which it is not --
 * and with two vendors on the row, an unlabelled pair would be unreadable.
 *
 * A vendor that does not price the card is left out rather than shown empty.
 */
function priceNote(card) {
  const parts = (index?.priceSources ?? [])
    .map((source) => {
      const money = formatPrice(cardPrice(card, source), source);
      return money
        ? `<span class="price-one">${esc(money)}
             <span class="price-src">${esc(source.label)}</span></span>`
        : '';
    })
    .filter(Boolean);

  if (!parts.length) return '';
  return `<div class="price" title="Market reference prices, not the seller's price"
          >${parts.join('')}</div>`;
}

/**
 * How many card rows are drawn at once.
 *
 * Not a limit on what is found: the summary and every facet count the whole
 * result, and only the drawing stops here. Two thousand rows is already
 * ~28,000 DOM nodes, which is where a phone starts to feel it, and nobody
 * scrolls past it anyway.
 */
const MAX_ROWS = 2000;

/** Trim a result to MAX_ROWS of cards, keeping whole decks in order. */
function capRows(data) {
  if (data.hitCount <= MAX_ROWS) return { data, hidden: 0 };

  const decks = [];
  let left = MAX_ROWS;
  for (const d of data.decks) {
    if (left <= 0) break;
    const cards = d.cards.slice(0, left);
    left -= cards.length;
    decks.push({ ...d, cards });
  }
  return { data: { ...data, decks }, hidden: data.hitCount - MAX_ROWS };
}

function renderResults(data, opts = {}) {
  if (!data.decks.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    summaryEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = opts.emptyText ?? `No deck currently lists a card matching "${data.query}".`;
    return;
  }

  emptyEl.hidden = true;
  summaryEl.hidden = false;
  summaryEl.innerHTML = opts.summary ??
    (`<b>${data.totalCopies}</b> ${data.totalCopies === 1 ? 'copy' : 'copies'} ` +
     `across <b>${data.deckCount}</b> ${data.deckCount === 1 ? 'deck' : 'decks'} ` +
     `(<b>${data.hitCount}</b> matching ${data.hitCount === 1 ? 'entry' : 'entries'}).`);

  const { data: shown, hidden } = capRows(data);
  if (hidden) {
    summaryEl.innerHTML +=
      ` <span class="count-note">Showing the first ${MAX_ROWS.toLocaleString()}; ` +
      `narrow it with the filters to see the rest.</span>`;
  }

  rendered = [];
  resultsEl.innerHTML = shown.decks.map((d) => `
    <section class="deck">
      <div class="deck-head">
        <div class="deck-title">
          <a href="${esc(d.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.deckName)}</a>
          ${d.discount ? `<span class="chip off">${d.discount}% OFF</span>` : ''}
          ${d.category ? `<span class="chip">${esc(categoryLabel(d.category))}</span>` : ''}
        </div>
        <div class="deck-meta">
          ${d.totalQuantity} ${opts.copiesLabel ?? 'matching'} ${d.totalQuantity === 1 ? 'copy' : 'copies'}
          &middot; deck updated ${esc(fmtDate(d.deckUpdatedAt))}
        </div>
      </div>
      <table>${d.cards.map((c) => cardRow(c, d, { ...opts, query: data.query })).join('')}</table>
    </section>`).join('');
}

function runSearch(q) {
  if (!index) return;
  if (!q.trim()) return browseAll();

  renderFiltered(search(index, q), {}, () => runSearch(q));
  $('suggestions').innerHTML = suggest(index, q, 10)
    .map((n) => `<option value="${esc(n)}">`).join('');
}

/**
 * No query: offer the whole catalogue to the filters.
 *
 * Not every question starts with a card name. "Pauper-legal red cards under
 * two dollars" has none in it, and until the filters worked on their own
 * there was no way to ask it.
 *
 * Nothing is drawn until something narrows it, which is why the facets are
 * built from the whole catalogue but `renderResults` is handed an empty set.
 * Nine thousand rows is not a browsing experience, and it is not what anyone
 * opening the page wanted to see either.
 */
function browseAll() {
  const everything = allCards(index);
  const total = everything.hitCount.toLocaleString();

  renderFiltered(everything, {
    emptyText:
      `Type a card name above, or use the filters to search all ${total} cards.`,
  }, browseAll, (filtered, opts) => {
    if (!isFiltered(filters)) {
      // Show the bar, not the catalogue behind it.
      return renderResults({ ...everything, decks: [] }, opts);
    }
    renderResults(filtered, {
      ...opts,
      emptyText: 'Nothing in the catalogue matches those filters.',
    });
  });
}

/* ------------------------------------------------------------------ *
 * New arrivals
 * ------------------------------------------------------------------ */

const windowSelect = $('window');
let activeTab = 'search';

/** Tab id -> its button, its pane, and what to draw when it opens. */
const TABS = {
  search: { tab: 'tab-search', pane: 'pane-search' },
  new:    { tab: 'tab-new',    pane: 'pane-new' },
  browse: { tab: 'tab-browse', pane: 'pane-browse' },
  list:   { tab: 'tab-list',   pane: 'pane-list' },
  wish:   { tab: 'tab-wish',   pane: 'pane-wish' },
  cart:   { tab: 'tab-cart',   pane: 'pane-cart' },
};

/** Read the window picker into the options newArrivals() expects. */
function windowOpts() {
  const v = windowSelect.value;
  return v === 'last' ? { sinceLastUpdate: true } : { days: Number(v) };
}

function renderArrivals() {
  if (!index) return;
  const opts = windowOpts();
  const data = newArrivals(index, opts);

  const windowLabel = opts.sinceLastUpdate
    ? `in the update on ${esc(fmtDate(index.generatedAt))}`
    : `in the last ${opts.days} days`;

  if (!data.available) {
    // An index published before this field existed cannot answer the question.
    filtersEl.hidden = true;
    renderResults({ decks: [] }, {
      emptyText: 'This window needs a newer index. Press "Update now", or pick a day range.',
    });
    return;
  }

  // Most updates change nothing, so an empty "last update" is the normal case,
  // not a fault. Point at the wider window rather than leaving a dead end.
  const emptyText = opts.sinceLastUpdate
    ? 'The latest update did not add any cards. Try one of the day ranges to see recent arrivals.'
    : `No cards have been added in the last ${opts.days} days.`;

  renderFiltered(data, {
    copiesLabel: 'new',
    allNew: true,
    emptyText,
    summary:
      `<b>${data.printingCount}</b> new ${data.printingCount === 1 ? 'card' : 'cards'} ` +
      `(<b>${data.totalCopies}</b> ${data.totalCopies === 1 ? 'copy' : 'copies'}) ` +
      `across <b>${data.deckCount}</b> ${data.deckCount === 1 ? 'deck' : 'decks'}, ${windowLabel}.`,
  }, renderArrivals);
}

/** Headline count on the tab: what the most recent update brought in. */
function renderNewCount() {
  const el = $('new-count');
  const recent = newArrivals(index, { days: 7 }).printingCount;
  el.hidden = recent === 0;
  el.textContent = String(recent);
  el.title = `${recent} new cards in the last 7 days`;
}

function showTab(which) {
  activeTab = which;

  for (const [id, refs] of Object.entries(TABS)) {
    const on = id === which;
    const tab = $(refs.tab);
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
    // Roving tabindex: one Tab press reaches the tab row, then arrows move
    // within it. Four separate tab stops would be tedious to pass through.
    tab.tabIndex = on ? 0 : -1;
    $(refs.pane).hidden = !on;
  }

  const url = new URL(location.href);
  url.searchParams.delete('new');
  url.searchParams.delete('list');
  url.searchParams.delete('cart');
  url.searchParams.delete('wish');
  if (which !== 'browse') url.searchParams.delete('deck');
  if (which === 'new') url.searchParams.set('new', windowSelect.value);
  if (which === 'list') url.searchParams.set('list', '1');
  if (which === 'cart') url.searchParams.set('cart', '1');
  if (which === 'wish') url.searchParams.set('wish', '1');
  history.replaceState(null, '', url);

  // The NEW badge in search results always means "the last 7 days", whatever
  // window the arrivals tab happens to be showing.
  newBadgeCutoff = arrivalCutoff(index, { days: 7 });

  if (which === 'search') { runSearch(qInput.value); qInput.focus(); }
  else if (which === 'new') renderArrivals();
  else if (which === 'browse') renderBrowse();
  else if (which === 'cart') renderCart();
  else if (which === 'wish') { renderWishlist(); wishInput.focus(); }
  else { renderDecklist(); listInput.focus(); }
}

for (const [id, refs] of Object.entries(TABS)) {
  $(refs.tab).addEventListener('click', () => showTab(id));
}

// Arrow keys move between tabs, as the tablist pattern expects.
$('tab-search').parentElement.addEventListener('keydown', (ev) => {
  const ids = Object.keys(TABS);
  const here = ids.indexOf(activeTab);
  if (here === -1) return;

  const to =
    ev.key === 'ArrowRight' ? (here + 1) % ids.length :
    ev.key === 'ArrowLeft' ? (here - 1 + ids.length) % ids.length :
    ev.key === 'Home' ? 0 :
    ev.key === 'End' ? ids.length - 1 : -1;
  if (to === -1) return;

  ev.preventDefault();
  showTab(ids[to]);
  $(TABS[ids[to]].tab).focus();
});
windowSelect.addEventListener('change', renderArrivals);

/* ------------------------------------------------------------------ *
 * Browse
 * ------------------------------------------------------------------ */

/** Which deck is open, or null for the deck index. */
let browseDeckId = null;

/** Turn a raw index deck into the shape the shared renderers expect. */
const asGroup = (deck) => ({
  deckId: deck.id,
  deckName: deck.name,
  deckUrl: deck.url,
  category: deck.category,
  discount: deck.discount ?? null,
  deckUpdatedAt: deck.updatedAt,
  totalQuantity: deck.cardCount,
  cards: deck.cards,
});

/** The deck index: every deck, under its Linktree section, in page order. */
function renderBrowseList() {
  browseDeckId = null;
  filtersEl.hidden = true;
  $('browse-bar').innerHTML = '';
  summaryEl.hidden = false;
  emptyEl.hidden = true;

  const decks = index.decks;
  const copies = decks.reduce((n, d) => n + d.cardCount, 0);
  summaryEl.innerHTML =
    `<b>${decks.length}</b> decks &middot; <b>${copies.toLocaleString()}</b> cards. ` +
    `Open one to see everything in it.`;

  // Decks arrive in the seller's own page order, so grouping in that order
  // reproduces the Linktree layout people already know.
  const sections = [];
  for (const deck of decks) {
    const key = deck.category ?? '';
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.decks.push(deck);
    else sections.push({ key, decks: [deck] });
  }

  const cutoff = arrivalCutoff(index, { days: 7 });

  resultsEl.innerHTML = sections.map((sec) => {
    const label = sec.key ? categoryLabel(sec.key) : 'Not in a section';
    return `
      <div class="br-section">${esc(label)}</div>
      <div class="br-grid">${sec.decks.map((d) => {
        const fresh = d.cards.filter((c) => isNewCard(c, cutoff)).length;
        return `
          <button type="button" class="br-card" data-deck="${esc(d.id)}"
                  aria-label="${esc(d.name)}, ${d.cardCount} cards${d.discount ? `, ${d.discount}% off` : ''}">
            <div class="br-name">
              ${esc(d.name)}
              ${d.discount ? `<span class="chip off">${d.discount}% OFF</span>` : ''}
            </div>
            <div class="br-meta">
              <b>${d.cardCount.toLocaleString()}</b> cards &middot;
              <b>${d.cards.length.toLocaleString()}</b> entries
              ${fresh ? ` &middot; <span class="cp-off">${fresh} new</span>` : ''}
            </div>
            <div class="br-meta">updated ${esc(fmtDate(d.updatedAt))}</div>
          </button>`;
      }).join('')}</div>`;
  }).join('');
}

/** Draw one deck's contents, grouped by card type. */
function drawBrowseDeck(filtered, opts) {
  const group = filtered.decks[0];
  if (!group) {
    resultsEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = 'Nothing in this deck matches the filters.';
    return;
  }

  emptyEl.hidden = true;

  const byType = new Map();
  for (const c of group.cards) {
    const k = c.typeName || 'Other';
    byType.has(k) ? byType.get(k).push(c) : byType.set(k, [c]);
  }

  // Fixed order, so filtering removes sections without shuffling the rest.
  const order = sortCardTypes([...byType.keys()]);

  rendered = [];
  resultsEl.innerHTML = order.map((type) => [type, byType.get(type)]).map(([type, cards]) => `
    <div class="br-type">${esc(type)} <span>${cards.reduce((n, c) => n + c.quantity, 0)}</span></div>
    <section class="deck"><table>
      ${cards.map((c) => cardRow(c, group, opts)).join('')}
    </table></section>`).join('');
}

function renderBrowseDeck(deckId) {
  const deck = index.decks.find((d) => d.id === deckId);
  if (!deck) return renderBrowseList();

  browseDeckId = deckId;
  const group = asGroup(deck);

  $('browse-bar').innerHTML =
    `<button type="button" class="br-back">&larr; All decks</button>`;

  summaryEl.hidden = false;
  summaryEl.innerHTML =
    `<div class="br-head">
       <span class="br-title">${esc(deck.name)}</span>
       ${deck.discount ? `<span class="chip off">${deck.discount}% OFF</span>` : ''}
       <a href="${esc(deck.url)}" target="_blank" rel="noopener noreferrer">open on ManaBox &rarr;</a>
     </div>
     <b>${deck.cardCount.toLocaleString()}</b> cards in
     <b>${deck.cards.length.toLocaleString()}</b> entries &middot;
     updated ${esc(fmtDate(deck.updatedAt))}
     ${(() => {
       const t = describeTotals(deck.cards, index?.priceSources);
       return t ? `<div class="price-total">Reference value ${esc(t)}. Not the seller's price.</div>` : '';
     })()}`;

  renderFiltered(
    { deckCount: 1, hitCount: deck.cards.length, totalCopies: deck.cardCount, decks: [group] },
    {},
    () => renderBrowseDeck(deckId),
    drawBrowseDeck,
  );
}

function renderBrowse() {
  if (!index) return;
  browseDeckId ? renderBrowseDeck(browseDeckId) : renderBrowseList();

  const url = new URL(location.href);
  browseDeckId ? url.searchParams.set('deck', browseDeckId) : url.searchParams.delete('deck');
  history.replaceState(null, '', url);
}

resultsEl.addEventListener('click', (ev) => {
  const card = ev.target.closest('.br-card');
  if (!card) return;
  filters = emptyFilters();      // a fresh deck deserves a fresh view
  sort = DEFAULT_SORT;
  browseDeckId = card.dataset.deck;
  renderBrowse();
  window.scrollTo(0, 0);
});

$('browse-bar').addEventListener('click', (ev) => {
  if (!ev.target.closest('.br-back')) return;
  filters = emptyFilters();
  sort = DEFAULT_SORT;
  browseDeckId = null;
  renderBrowse();
});

/* ------------------------------------------------------------------ *
 * Decklist
 * ------------------------------------------------------------------ */

const listInput = $('decklist');
const LIST_KEY = 'decklist';

/** One row per pasted line, in the order it was written. */
function renderDecklistRow(m) {
  const best = m.sources[0];
  const more = m.sources.length - 1;

  const where = m.status === 'missing'
    ? '<div class="dl-where">Not stocked.</div>'
    : `<div class="dl-where">
         ${best.quantity}&times; in
         <a href="${esc(best.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(best.deckName)}</a>
         ${best.discount ? `<span class="cp-off">${best.discount}% off</span>` : ''}
         ${more > 0 ? `&middot; +${more} other ${more === 1 ? 'deck' : 'decks'}` : ''}
       </div>`;

  return `
    <div class="dl-row ${m.status === 'available' ? 'ok' : m.status === 'partial' ? 'part' : 'miss'}">
      <div class="dl-mark"></div>
      <div>
        <span class="dl-qty">${m.wanted}&times;</span>
        <span class="dl-name">${esc(m.entry.name)}</span>
        ${m.entry.foil ? '<span class="foil">FOIL</span>' : ''}
        ${where}
      </div>
      <div class="dl-have">${m.status === 'missing' ? '&mdash;' : `<b>${m.available}</b> available`}</div>
    </div>`;
}

function renderDecklist() {
  if (!index) return;
  filtersEl.hidden = true;   // the list view has its own shape

  const { entries, skipped, format } = parseDecklist(listInput.value);
  const what = format === 'csv' ? 'CSV export' : 'list';
  $('list-note').textContent = listInput.value.trim()
    ? `${entries.length} ${entries.length === 1 ? 'card' : 'cards'} read from a ${what}` +
      (skipped ? `, ${skipped} ${skipped === 1 ? 'row' : 'rows'} skipped.` : '.')
    : '';

  if (!entries.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = 'Paste a list above and press "Check list".';
    return;
  }

  const { matches, summary } = matchDecklist(index, entries);
  emptyEl.hidden = true;
  summaryEl.hidden = false;
  // Value of what can actually be supplied, priced per printing. The same
  // allocation the message uses, so the figure and the request agree on which
  // copies are being talked about.
  const allocations = allocateStock(matches);
  const supplied = allocations.map((a) => ({ prices: a.card.prices, quantity: a.quantity }));
  const value = describeTotals(supplied, index?.priceSources);

  // Regrouped by deck because the discount is the deck's, and `allocateStock`
  // returns a flat list that can come back to one deck more than once -- a
  // card spilling into a second deck and a later card spilling back.
  /** @type {Map<string, {cards: object[], discount: number|null}>} */
  const byDeck = new Map();
  for (const a of allocations) {
    const group = byDeck.get(a.deckId) ?? { cards: [], discount: a.discount };
    group.cards.push({ prices: a.card.prices, quantity: a.quantity });
    byDeck.set(a.deckId, group);
  }
  const net = describeDiscounted([...byDeck.values()], index?.priceSources);

  summaryEl.innerHTML =
    `<b>${summary.foundCopies}</b> of <b>${summary.wantedCopies}</b> copies available ` +
    `across <b>${summary.lines}</b> ${summary.lines === 1 ? 'card' : 'cards'}.` +
    (value ? `<div class="price-total">Reference value ${esc(value)}. Not the seller's price.</div>` : '') +
    // Worded exactly as the cart words it: the same figure answering the same
    // question should not read as two different claims.
    (net ? `<div class="price-total net">With each deck's discount ${esc(net)} &mdash; ` +
           `an estimate: the discount comes off the seller's own price, not these.</div>` : '');

  const missing = matches.filter((m) => m.status === 'missing');
  const stocked = matches.filter((m) => m.status !== 'missing');
  const message = stockedMessage(matches);

  resultsEl.innerHTML = `
    <div class="dl-tiles">
      <div class="dl-tile ok"><div class="v">${summary.available}</div><div class="k">fully available</div></div>
      <div class="dl-tile part"><div class="v">${summary.partial}</div><div class="k">not enough copies</div></div>
      <div class="dl-tile miss"><div class="v">${summary.missing}</div><div class="k">not stocked</div></div>
    </div>

    <div class="dl-list">${matches.map(renderDecklistRow).join('')}</div>

    ${summary.topDecks.length ? `
      <h2 style="font-size:15px;margin:22px 0 10px">Decks covering the most of your list</h2>
      <div class="dl-list">${summary.topDecks.map((d) => `
        <div class="dl-row ok">
          <div class="dl-mark"></div>
          <div><span class="dl-name">
            <a href="${esc(d.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.deckName)}</a>
          </span>${d.discount ? ` <span class="cp-off">${d.discount}% off</span>` : ''}</div>
          <div class="dl-have"><b>${d.cards}</b> of your cards</div>
        </div>`).join('')}</div>` : ''}

    ${exportBlock(
      'Stocked', stocked.length,
      'Send this to the seller. Grouped by deck with its link, and a card they are short of is asked for at the number they actually have.',
      message,
    )}

    ${exportBlock(
      'Not stocked', missing.length,
      'Copy this back into your deck builder, or watch for them and let the site tell you when they turn up.',
      missing.map((m) => `${m.wanted} ${m.entry.name}`).join('\n'),
      // Watching is the obvious next move for a card nobody stocks, and it is
      // the one thing this list is otherwise a dead end for.
      `<button type="button" class="btn secondary" id="wish-missing">${
        missing.every((m) => inWishlist(wishlist, m.entry.name))
          ? 'All watched' : 'Watch these'}</button>`,
    )}`;
}

/**
 * Send the cards nobody stocks to the wishlist.
 *
 * The list is re-derived from the box rather than kept in a variable: pressing
 * this is no more work than pressing "Check list", and a remembered copy could
 * disagree with what is on screen after an index refresh.
 */
resultsEl.addEventListener('click', (ev) => {
  if (!ev.target.closest('#wish-missing') || !index) return;

  const { entries } = parseDecklist(listInput.value);
  const { matches } = matchDecklist(index, entries);
  const missing = matches.filter((m) => m.status === 'missing');

  const before = wishlist.length;
  const today = todayUtc();
  for (const m of missing) wishlist = addToWishlist(wishlist, m.entry.name, today);
  saveWishlist(wishlist);

  renderDecklist();     // the button now reads "All watched"
  updateWishBadge();
  const added = wishlist.length - before;
  // Written after the redraw, which rewrites this line with the parse summary.
  $('list-note').textContent = added
    ? `${added} ${added === 1 ? 'card' : 'cards'} added to your wishlist.`
    : 'Already watching all of them.';
});

/**
 * Copy the list beside the button.
 *
 * Unlike the cart's copy, the text is already on screen here, so a refused
 * clipboard selects the box rather than printing the whole message a second
 * time. Delegated, because the blocks are rebuilt on every check.
 */
resultsEl.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-copy]');
  const box = btn?.closest('.dl-export')?.querySelector('textarea');
  if (!box) return;

  const say = (msg) => {
    btn.textContent = msg;
    // The block may be rebuilt before this fires; writing to a detached
    // button is harmless.
    setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
  };

  try {
    await navigator.clipboard.writeText(box.value);
    say('Copied');
  } catch {
    // Refused outside a secure context, and in some browsers. Pointing at the
    // text that is already there beats failing silently.
    box.select();
    say('Press Ctrl/Cmd+C');
  }
});

listInput.addEventListener('input', () => {
  try { localStorage.setItem(LIST_KEY, listInput.value); } catch { /* private mode */ }
});
$('check-list').addEventListener('click', renderDecklist);
$('clear-list').addEventListener('click', () => {
  listInput.value = '';
  try { localStorage.removeItem(LIST_KEY); } catch { /* private mode */ }
  renderDecklist();
  listInput.focus();
});

// Ctrl/Cmd+Enter checks the list without reaching for the button.
listInput.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') renderDecklist();
});

/* ------------------------------------------------------------------ *
 * Loading the index
 * ------------------------------------------------------------------ */

function renderStatus() {
  const s = index.stats;
  const ageH = (Date.now() - Date.parse(index.generatedAt)) / 3600000;
  const cls = ageH < 36 ? 'ok' : ageH < 96 ? 'warn' : 'bad';
  $('index-status').innerHTML =
    `<span class="dot ${cls}"></span>` +
    `<b>${s.decks}</b> decks &middot; <b>${s.copies.toLocaleString()}</b> cards &middot; ` +
    `<b>${s.names.toLocaleString()}</b> unique names &middot; ` +
    `index built ${esc(fmtDate(index.generatedAt))}`;
  $('foot').textContent = `${s.entries.toLocaleString()} card entries. Scraped from public ManaBox deck pages.`;
}

async function loadIndex() {
  try {
    // Bypass the CDN cache so a fresh build shows up straight after a run.
    const res = await fetch(`index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    index = await res.json();

    renderStatus();
    qInput.disabled = false;
    $('update-btn').disabled = false;
    emptyEl.className = 'empty';

    newBadgeCutoff = arrivalCutoff(index, { days: 7 });
    renderNewCount();

    const params = new URLSearchParams(location.search);
    const initial = params.get('q');
    if (initial) qInput.value = initial;

    try {
      const saved = localStorage.getItem(LIST_KEY);
      if (saved) listInput.value = saved;
    } catch { /* private mode */ }

    updateCartBadge();
    updateWishBadge();

    if (params.has('deck')) { browseDeckId = params.get('deck'); showTab('browse'); }
    else if (params.has('browse')) showTab('browse');
    else if (params.has('cart')) showTab('cart');
    else if (params.has('wish')) showTab('wish');
    else if (params.has('list')) showTab('list');
    else if (params.has('new')) {
      const w = params.get('new');
      if ([...windowSelect.options].some((o) => o.value === w)) windowSelect.value = w;
      showTab('new');
    } else {
      showTab('search');
    }
  } catch {
    $('index-status').innerHTML = '<span class="dot bad"></span>Could not load the card index.';
    emptyEl.className = 'empty';
    emptyEl.innerHTML =
      `The index file is missing. It is produced by the update workflow &mdash; ` +
      `<a href="${actionsUrl()}" target="_blank" rel="noopener noreferrer">run it once</a> ` +
      `and reload this page.`;
  }
}

/* ------------------------------------------------------------------ *
 * Update button: ask GitHub Actions to re-scrape
 * ------------------------------------------------------------------ */

const btn = $('update-btn');
const progressEl = $('progress');
const barFill = $('bar-fill');
const progressText = $('progress-text');

const TOKEN_KEY = 'githubToken';
const api = (path, init = {}) =>
  fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
      ...(init.headers ?? {}),
    },
  });

function askForToken() {
  const t = prompt(
    'Paste a GitHub token to trigger updates.\n\n' +
    'Create a fine-grained token limited to this repository with ' +
    '"Actions: read and write" permission. It is stored only in this browser.',
  );
  if (t) localStorage.setItem(TOKEN_KEY, t.trim());
  return t;
}

const setBusy = (busy) => {
  btn.disabled = busy;
  btn.textContent = busy ? 'Updating...' : 'Update now';
};

function showProgress(text, pct) {
  progressEl.hidden = false;
  progressText.className = 'progress-text';
  progressText.textContent = text;
  if (pct === null) {
    barFill.className = 'indeterminate';
    barFill.style.width = '';
  } else {
    barFill.className = '';
    barFill.style.width = `${Math.min(99, Math.round(pct))}%`;
  }
}

function showError(text) {
  progressEl.hidden = false;
  barFill.className = '';
  barFill.style.width = '100%';
  progressText.className = 'progress-text error';
  progressText.innerHTML = text;
}

/** Poll the dispatched run until it finishes, pacing the bar against its expected length. */
async function followRun(runId, startedAt) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));

    let run;
    try {
      run = await api(`/actions/runs/${runId}`).then((r) => r.json());
    } catch {
      showError('Lost contact with GitHub while the update was running.');
      setBusy(false);
      return;
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    if (run.status === 'queued') {
      showProgress('Waiting for a GitHub runner...', null);
      continue;
    }
    if (run.status !== 'completed') {
      showProgress(
        `Scraping decks... (${Math.round(elapsed)}s)`,
        (elapsed / CONFIG.expectedRunSeconds) * 100,
      );
      continue;
    }

    setBusy(false);
    if (run.conclusion !== 'success') {
      showError(
        `Update ${esc(run.conclusion ?? 'failed')} &mdash; ` +
        `<a href="${esc(run.html_url)}" target="_blank" rel="noopener noreferrer">see the log</a>.`,
      );
      return;
    }

    // Pages needs a moment to publish the new commit before the file changes.
    barFill.className = '';
    barFill.style.width = '100%';
    progressText.className = 'progress-text';
    progressText.textContent = 'Update finished. Fetching the new index...';

    await new Promise((r) => setTimeout(r, 5000));
    const before = index?.generatedAt;
    await loadIndex();

    progressText.className = 'progress-text done';
    progressText.textContent = index?.generatedAt !== before
      ? `Updated: ${index.stats.decks} decks, ${index.stats.copies.toLocaleString()} cards.`
      : 'Update finished. The published page may take a minute to refresh; reload shortly.';

    renderNewCount();
    if (activeTab === 'new') renderArrivals();
    else if (activeTab === 'list') renderDecklist();
    else if (activeTab === 'browse') renderBrowse();
    else runSearch(qInput.value);
    setTimeout(() => { progressEl.hidden = true; }, 10000);
    return;
  }
}

/** Find the run our dispatch created. There is no id in the dispatch response. */
async function findRun(since) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await api(
        `/actions/workflows/${CONFIG.workflow}/runs?event=workflow_dispatch&per_page=5`,
      ).then((r) => r.json());
      const run = (res.workflow_runs ?? []).find((r) => Date.parse(r.created_at) >= since - 60_000);
      if (run) return run;
    } catch { /* keep trying */ }
  }
  return null;
}

btn.addEventListener('click', async () => {
  if (!localStorage.getItem(TOKEN_KEY) && !askForToken()) return;

  setBusy(true);
  showProgress('Asking GitHub to run the scraper...', null);
  const since = Date.now();

  let res;
  try {
    res = await api(`/actions/workflows/${CONFIG.workflow}/dispatches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: CONFIG.ref }),
    });
  } catch {
    setBusy(false);
    showError('Could not reach GitHub.');
    return;
  }

  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(TOKEN_KEY);
    setBusy(false);
    showError('That token was rejected. Check it has "Actions: read and write" on this repository, then try again.');
    return;
  }
  if (res.status === 404) {
    setBusy(false);
    showError(
      `Workflow not found. Confirm <code>${esc(CONFIG.workflow)}</code> exists on the ` +
      `<code>${esc(CONFIG.ref)}</code> branch, and that the token can see this repository.`,
    );
    return;
  }
  if (!res.ok) {
    setBusy(false);
    showError(`GitHub refused the request (HTTP ${res.status}).`);
    return;
  }

  showProgress('Update queued...', null);
  const run = await findRun(since);
  if (!run) {
    setBusy(false);
    showError(
      `The update started but its run could not be found. ` +
      `<a href="${actionsUrl()}" target="_blank" rel="noopener noreferrer">Check the Actions tab</a>.`,
    );
    return;
  }
  followRun(run.id, since);
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

let timer;
qInput.addEventListener('input', () => {
  clearTimeout(timer);
  const q = qInput.value;
  timer = setTimeout(() => runSearch(q), 120);
});

qInput.addEventListener('change', () => {
  const url = new URL(location.href);
  qInput.value ? url.searchParams.set('q', qInput.value) : url.searchParams.delete('q');
  history.replaceState(null, '', url);
});

/* ------------------------------------------------------------------ *
 * Cart
 * ------------------------------------------------------------------ */

const cartCountEl = $('cart-count');
const cartPricesEl = $('cart-prices');

/**
 * The badge counts copies the seller could actually supply, not copies asked
 * for. A deck that thins after something was added leaves a line wanting more
 * than remains, and a badge reading 104 above a cart that says "5 cards" would
 * be the most visible number on the page and the wrong one. The shortfall is
 * still shown inside the cart rather than silently absorbed.
 */
function updateCartBadge() {
  const n = index ? resolveCart(cart, index).copies : cartCount(cart);
  cartCountEl.hidden = n === 0;
  cartCountEl.textContent = String(n);
}

/**
 * Add or adjust from a result row without redrawing the list.
 *
 * Browsing a deck can put a thousand rows on the page, and rebuilding all of
 * them to change one number would lose the reader's place for no reason.
 */
resultsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-add], [data-step], [data-wish]');
  if (!btn) return;
  ev.preventDefault();

  const ref = Number(btn.dataset.add ?? btn.dataset.step ?? btn.dataset.wish);
  const hit = rendered[ref];
  if (!hit) return;

  if (btn.dataset.wish !== undefined) {
    const name = hit.card.name;
    wishlist = inWishlist(wishlist, name)
      ? removeWish(wishlist, wishKey(name))
      : addToWishlist(wishlist, name, todayUtc());
    saveWishlist(wishlist);
    // The cell is read before the swap: replacing outerHTML detaches the
    // button, and closest() on a detached node finds nothing.
    const cell = btn.closest('.cartcell');
    btn.outerHTML = wishControl(hit.card, ref);
    // The pressed button has just been replaced; focus would otherwise fall to
    // the document top mid-interaction.
    cell?.querySelector('[data-wish]')?.focus();
    updateWishBadge();
    return;
  }

  cart = addToCart(cart, hit.deckId, hit.card, btn.dataset.step ? Number(btn.dataset.by) : 1);
  saveCart(cart);

  const cell = btn.closest('.cartcell');
  if (cell) {
    cell.innerHTML = rowControls(hit.card, hit.deckId, ref);
    // The control the reader was pressing has just been replaced. Put focus on
    // whatever now stands in its place, or the caret falls to the document top
    // mid-interaction.
    (cell.querySelector('[data-step][data-by="1"]:not([disabled])') ??
     cell.querySelector('[data-step], [data-add]'))?.focus();
  }
  updateCartBadge();
});

/** One deck's worth of the cart. */
function cartGroup(group) {
  const rows = group.items.map((item) => {
    const c = item.card;
    const short = item.issue === 'fewer';
    // Registered the same way a result row is, so the preview panel opens here
    // too: reviewing a list is exactly when you want to see what you picked.
    const ref = rendered.push({ card: c, deckId: group.deckId }) - 1;
    return `
      <div class="cart-row${short ? ' is-short' : ''}">
        <div class="cart-q">
          <button type="button" class="cart-x" data-drop="${esc(item.line.key)}"
                  aria-label="Remove ${esc(item.line.name)}">&times;</button>
          <span class="stepper" role="group" aria-label="Copies of ${esc(item.line.name)}">
            <button type="button" data-cart-step="${esc(item.line.key)}" data-by="-1"
                    data-cap="${item.available}" aria-label="One fewer">&minus;</button>
            <b>${item.want}</b>
            <button type="button" data-cart-step="${esc(item.line.key)}" data-by="1"
                    data-cap="${item.available}" aria-label="One more"
                    ${item.want >= item.available ? 'disabled title="That is all this deck has"' : ''}>+</button>
          </span>
        </div>
        <div>
          <div class="cart-name">
            <button type="button" class="name" data-card="${ref}"
                    aria-expanded="false" aria-haspopup="dialog"
                    title="Show ${esc(item.line.name)}">${esc(item.line.name)}</button>${c.foil ? '<span class="foil">FOIL</span>' : ''}
          </div>
          <div class="setinfo">
            ${esc(c.setName ?? 'Unknown set')}${c.setId ? ` (${esc(c.setId.toUpperCase())})` : ''}
            ${c.collectorNumber ? ` #${esc(c.collectorNumber)}` : ''}
          </div>
          ${priceNote(c)}
          ${short ? `<div class="cart-warn">You asked for ${item.want}; only ${item.available} left here.</div>` : ''}
          ${cheaperElsewhere(c, { deckId: group.deckId, discount: group.discount })}
        </div>
      </div>`;
  }).join('');

  const subtotal = describeTotals(group.supplied, index?.priceSources);
  // With the discount applied, beside the chip that states it. Null when this
  // deck has none, so the same figure is not printed twice.
  const net = describeDiscounted(
    [{ cards: group.supplied, discount: group.discount }], index?.priceSources);

  return `
    <section class="deck cart-deck">
      <div class="deck-head">
        <span>
          <a href="${esc(group.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(group.deckName)}</a>
          ${group.discount ? `<span class="chip off">${group.discount}% OFF</span>` : ''}
        </span>
        <span class="cart-sub">${subtotal ? esc(subtotal) : ''}${
          net ? `<b class="cart-net">${esc(net)}</b>` : ''}</span>
      </div>
      <div class="cart-rows">${rows}</div>
    </section>`;
}

function renderCart() {
  if (!index) return;
  filtersEl.hidden = true;   // the cart has its own shape
  rendered = [];             // refs are per-render; the preview reads them

  const resolved = resolveCart(cart, index);
  const gone = resolved.unavailable;

  $('cart-note').textContent = '';
  updateCartBadge();

  if (!cart.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = 'Nothing here yet. Press "Add" on any card to start a list.';
    return;
  }

  emptyEl.hidden = true;
  summaryEl.hidden = false;
  const value = describeTotals(resolved.supplied, index?.priceSources);
  // Each deck discounted on its own and then summed: the decks in one cart sit
  // at different tiers, so a single percentage over the whole thing would be
  // wrong for most of it.
  const net = describeDiscounted(
    resolved.groups.map((g) => ({ cards: g.supplied, discount: g.discount })),
    index?.priceSources);

  summaryEl.innerHTML =
    `<b>${resolved.copies}</b> ${resolved.copies === 1 ? 'card' : 'cards'} from ` +
    `<b>${resolved.deckCount}</b> ${resolved.deckCount === 1 ? 'deck' : 'decks'}.` +
    (value ? `<div class="price-total">Reference value ${esc(value)}. Not the seller's price.</div>` : '') +
    // Said in the same breath as the figure, because this one is the most
    // quotable number on the page and the caveat has to travel with it.
    (net ? `<div class="price-total net">With each deck's discount ${esc(net)} &mdash; ` +
           `an estimate: the discount comes off the seller's own price, not these.</div>` : '');

  // Cards that have left the catalogue are listed rather than quietly dropped:
  // a list that shrinks by itself between visits is a list nobody can trust.
  const goneBlock = gone.length
    ? `<section class="deck cart-gone">
         <div class="deck-head"><span>No longer available</span></div>
         <div class="cart-rows">${gone.map((item) => `
           <div class="cart-row is-gone">
             <div class="cart-q">
               <button type="button" class="cart-x" data-drop="${esc(item.line.key)}"
                       aria-label="Remove ${esc(item.line.name)}">&times;</button>
               <b>${item.want}&times;</b>
             </div>
             <div>
               <div class="cart-name">${esc(item.line.name)}</div>
               <div class="cart-warn">This deck no longer lists it. Search for it again to find another copy.</div>
             </div>
           </div>`).join('')}</div>
       </section>`
    : '';

  // The message itself, visible rather than hidden behind a button. The
  // decklist tab reached the same conclusion: you want to read what you are
  // about to send before you send it.
  const message = cartMessage(resolved, {
    includePrices: cartPricesEl.checked,
    sources: index?.priceSources ?? [],
    formatPrice,
  });

  resultsEl.innerHTML = resolved.groups.map(cartGroup).join('') + goneBlock + exportBlock(
    'Your list', resolved.copies,
    'Send this to the seller. Cards that have left a deck are not in it.',
    message,
  );
}

/** Changing a line from inside the cart redraws it: the list just changed. */
resultsEl.addEventListener('click', (ev) => {
  const drop = ev.target.closest('[data-drop]');
  if (drop) {
    cart = removeLine(cart, drop.dataset.drop);
    saveCart(cart);
    return renderCart();
  }

  // Stepping down to nothing removes the line, which is what setQuantity does
  // -- so the x button is a shortcut rather than the only way out.
  const step = ev.target.closest('[data-cart-step]');
  if (!step) return;
  const key = step.dataset.cartStep;
  const want = (cart.find((l) => l.key === key)?.want ?? 0) + Number(step.dataset.by);
  cart = setQuantity(cart, key, want, Number(step.dataset.cap));
  saveCart(cart);
  renderCart();
});

$('cart-clear').addEventListener('click', () => {
  if (!cart.length) return;
  cart = [];
  saveCart(cart);
  renderCart();
});

// The box shows what the checkbox does, so the list is redrawn rather than
// described. The old "Copy list" button and its injected fallback are gone:
// the box carries its own copy button, and the text was already on screen.
cartPricesEl.addEventListener('change', renderCart);

/* ------------------------------------------------------------------ *
 * Wishlist
 * ------------------------------------------------------------------ */

const wishInput = $('wish-q');
const wishCountEl = $('wish-count');

/**
 * The badge counts arrivals, not lines.
 *
 * A wishlist is a standing list that mostly does not change; a badge reading
 * its length would sit there permanently and mean nothing. What is worth a
 * number on the tab is the thing you would want to be told: cards that turned
 * up since you asked for them.
 */
function updateWishBadge() {
  const n = index ? resolveWishlist(wishlist, index).arrived : 0;
  wishCountEl.hidden = n === 0;
  wishCountEl.textContent = String(n);
  wishCountEl.title = `${n} wishlisted ${n === 1 ? 'card has' : 'cards have'} arrived since you asked`;
}

/** One wishlist row. */
function wishRow(row) {
  const { line, best } = row;

  const where = row.state === 'waiting'
    ? '<div class="dl-where">Not in stock. You will see it here when it arrives.</div>'
    : `<div class="dl-where">
         ${best.quantity}&times; in
         <a href="${esc(best.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(best.deckName)}</a>
         ${row.discount ? `<span class="cp-off">${row.discount}% off</span>` : ''}
         ${row.sources.length > 1
           ? `&middot; +${row.sources.length - 1} other ${row.sources.length === 2 ? 'deck' : 'decks'}`
           : ''}
       </div>`;

  return `
    <div class="dl-row wish-row ${row.state === 'arrived' ? 'ok' : row.state === 'stocked' ? 'part' : 'miss'}">
      <div class="dl-mark"></div>
      <div>
        <button type="button" class="cart-x" data-unwish="${esc(line.key)}"
                aria-label="Stop watching ${esc(line.name)}">&times;</button>
        <span class="dl-name">${esc(line.name)}</span>
        ${row.state === 'arrived' ? '<span class="new-badge">ARRIVED</span>' : ''}
        ${where}
        ${row.state === 'arrived'
          ? `<div class="cart-warn">Arrived ${esc(fmtDate(row.arrivedAt))}, after you asked for it.</div>`
          : ''}
      </div>
      <div class="dl-have">${row.state === 'waiting' ? '&mdash;' : `<b>${row.available}</b> available`}</div>
    </div>`;
}

function renderWishlist() {
  if (!index) return;
  filtersEl.hidden = true;   // the wishlist has its own shape

  const { rows, arrived, stocked, waiting } = resolveWishlist(wishlist, index);
  $('wish-note').textContent = '';
  updateWishBadge();

  if (!rows.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent =
      'Nothing watched yet. Search for a card above and press Enter, or star one ' +
      'in the results. It does not have to be in stock.';
    return;
  }

  emptyEl.hidden = true;
  summaryEl.hidden = false;
  const parts = [];
  if (arrived) parts.push(`<b>${arrived}</b> arrived since you asked`);
  if (stocked) parts.push(`<b>${stocked}</b> in stock`);
  if (waiting) parts.push(`<b>${waiting}</b> still waiting`);
  summaryEl.innerHTML = `${parts.join(' &middot; ')}.`;

  resultsEl.innerHTML = `<section class="deck"><div class="cart-rows">${
    rows.map(wishRow).join('')}</div></section>`;
}

/**
 * Add whatever is typed in the box.
 *
 * Run through `parseDecklist` rather than taken raw, so a name pasted with its
 * quantity or set still in front of it -- "4 Sol Ring", "1 Sol Ring (SLD) 2467"
 * -- is understood instead of being watched under that whole string. A
 * wishlist line is the card name; the rest is dropped on purpose.
 */
function addTypedWish() {
  const { entries } = parseDecklist(wishInput.value);
  if (!entries.length) {
    $('wish-note').textContent = 'Type a card name first.';
    return;
  }

  const before = wishlist.length;
  const today = todayUtc();
  // Stored under the catalogue's own spelling when it has one, so a list typed
  // in lower case still reads like the cards do.
  const name = catalogueName(index, entries[0].name) ?? entries[0].name;
  for (const entry of entries) {
    wishlist = addToWishlist(wishlist, catalogueName(index, entry.name) ?? entry.name, today);
  }
  saveWishlist(wishlist);

  const added = wishlist.length - before;
  wishInput.value = '';
  renderWishlist();

  // Named rather than counted, because one is added at a time and the reader
  // needs to see their typing landed on the card they meant. A name nothing
  // matches is still added -- that is what this list is for -- but it is said
  // out loud, since a half-typed name looks exactly like a card nobody has.
  $('wish-note').textContent =
    !added ? `${name} is already on the list.` :
    entries.length > 1 ? `${added} added.` :
    catalogueName(index, name) ? `${name} added.` :
    `Nobody stocks "${name}" — watching it as typed.`;
  wishInput.focus();
}

$('wish-save').addEventListener('click', addTypedWish);

/**
 * Suggestions come from the seller's catalogue, which is the half of the job
 * that can be helped with. A name nothing matches is still added as typed --
 * holding cards nobody stocks is the whole point of this list.
 */
wishInput.addEventListener('input', () => {
  $('wish-suggestions').innerHTML = suggest(index, wishInput.value, 10)
    .map((n) => `<option value="${esc(n)}">`).join('');
});

wishInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); addTypedWish(); }
});

$('wish-clear').addEventListener('click', () => {
  if (!wishlist.length) return;
  wishlist = [];
  saveWishlist(wishlist);
  renderWishlist();
});

/** Dropping a line from inside the wishlist redraws it: the list just changed. */
resultsEl.addEventListener('click', (ev) => {
  const drop = ev.target.closest('[data-unwish]');
  if (!drop) return;
  wishlist = removeWish(wishlist, drop.dataset.unwish);
  saveWishlist(wishlist);
  renderWishlist();
});

/* ------------------------------------------------------------------ *
 * Card preview
 * ------------------------------------------------------------------ */

const preview = createPreview(() => index);
preview.attach(resultsEl, (anchor) => rendered[Number(anchor.dataset.card)] ?? null);

$('repo-link').href = repoUrl();
loadIndex();
