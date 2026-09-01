import { CONFIG, repoUrl, actionsUrl } from './config.js';
import { search, suggest } from './search.js';
import { normalizeCardName } from './normalize.js';
import { newArrivals, arrivalCutoff, isNewCard } from './arrivals.js';
import { createPreview } from './preview.js';
import { betterDealFor, categoryLabel } from './cards.js';
import { parseDecklist, matchDecklist } from './decklist.js';

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
  const abs = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (days <= 0) return `today (${abs})`;
  if (days === 1) return `yesterday (${abs})`;
  return `${days} days ago (${abs})`;
};

/** Cards arriving on or after this date get a NEW badge in either tab. */
let newBadgeCutoff = null;

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

function renderResults(data, opts = {}) {
  if (!data.decks.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
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

  rendered = [];
  resultsEl.innerHTML = data.decks.map((d) => `
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
      <table>
        ${d.cards.map((c) => `
          <tr>
            <td class="qty">${c.quantity}&times;</td>
            <td>
              <button type="button" class="name" data-card="${rendered.push({ card: c, deckId: d.deckId }) - 1}"
                      aria-expanded="false" aria-haspopup="dialog"
                      title="Show card">${data.query ? highlight(c.name, data.query) : esc(c.name)}</button>
              ${c.foil ? '<span class="foil">FOIL</span>' : ''}
              ${opts.allNew || isNewCard(c, newBadgeCutoff) ? '<span class="new-badge">NEW</span>' : ''}
              <div class="setinfo">
                ${esc(c.setName ?? 'Unknown set')}${c.setId ? ` (${esc(c.setId.toUpperCase())})` : ''}
                ${c.collectorNumber ? ` #${esc(c.collectorNumber)}` : ''}
                ${c.rarity ? ` &middot; ${esc(c.rarity)}` : ''}
                ${c.typeName ? ` &middot; ${esc(c.typeName)}` : ''}
                ${c.firstSeen && (opts.allNew || isNewCard(c, newBadgeCutoff)) ? ` &middot; <span class="arrived">added ${esc(fmtDate(c.firstSeen))}</span>` : ''}
              </div>
              ${cheaperElsewhere(c, d)}
            </td>
          </tr>`).join('')}
      </table>
    </section>`).join('');
}

function runSearch(q) {
  if (!index) return;
  if (!q.trim()) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = 'Type a card name to see which decks have it.';
    return;
  }
  renderResults(search(index, q));
  $('suggestions').innerHTML = suggest(index, q, 10)
    .map((n) => `<option value="${esc(n)}">`).join('');
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
  list:   { tab: 'tab-list',   pane: 'pane-list' },
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

  renderResults(data, {
    copiesLabel: 'new',
    allNew: true,
    emptyText,
    summary:
      `<b>${data.printingCount}</b> new ${data.printingCount === 1 ? 'card' : 'cards'} ` +
      `(<b>${data.totalCopies}</b> ${data.totalCopies === 1 ? 'copy' : 'copies'}) ` +
      `across <b>${data.deckCount}</b> ${data.deckCount === 1 ? 'deck' : 'decks'}, ${windowLabel}.`,
  });
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
    $(refs.pane).hidden = !on;
  }

  const url = new URL(location.href);
  url.searchParams.delete('new');
  url.searchParams.delete('list');
  if (which === 'new') url.searchParams.set('new', windowSelect.value);
  if (which === 'list') url.searchParams.set('list', '1');
  history.replaceState(null, '', url);

  // The NEW badge in search results always means "the last 7 days", whatever
  // window the arrivals tab happens to be showing.
  newBadgeCutoff = arrivalCutoff(index, { days: 7 });

  if (which === 'search') { runSearch(qInput.value); qInput.focus(); }
  else if (which === 'new') renderArrivals();
  else { renderDecklist(); listInput.focus(); }
}

for (const [id, refs] of Object.entries(TABS)) {
  $(refs.tab).addEventListener('click', () => showTab(id));
}
windowSelect.addEventListener('change', renderArrivals);

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
  summaryEl.innerHTML =
    `<b>${summary.foundCopies}</b> of <b>${summary.wantedCopies}</b> copies available ` +
    `across <b>${summary.lines}</b> ${summary.lines === 1 ? 'card' : 'cards'}.`;

  const missing = matches.filter((m) => m.status === 'missing');

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

    ${missing.length ? `
      <div class="dl-missing">
        <h2 style="font-size:15px;margin:0 0 4px">Not stocked (${missing.length})</h2>
        <div class="setinfo">Copy this back into your deck builder, or try again after an update.</div>
        <textarea readonly rows="${Math.min(10, missing.length + 1)}">${
          esc(missing.map((m) => `${m.wanted} ${m.entry.name}`).join('\n'))
        }</textarea>
      </div>` : ''}`;
}

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
    emptyEl.textContent = 'Type a card name to see which decks have it.';

    newBadgeCutoff = arrivalCutoff(index, { days: 7 });
    renderNewCount();

    const params = new URLSearchParams(location.search);
    const initial = params.get('q');
    if (initial) qInput.value = initial;

    try {
      const saved = localStorage.getItem(LIST_KEY);
      if (saved) listInput.value = saved;
    } catch { /* private mode */ }

    if (params.has('list')) showTab('list');
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
 * Card preview
 * ------------------------------------------------------------------ */

const preview = createPreview(() => index);
preview.attach(resultsEl, (anchor) => rendered[Number(anchor.dataset.card)] ?? null);

$('repo-link').href = repoUrl();
loadIndex();
