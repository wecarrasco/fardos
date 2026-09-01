import { CONFIG, repoUrl, actionsUrl } from './config.js';
import { search, suggest } from './search.js';
import { normalizeCardName } from './normalize.js';
import { newArrivals, arrivalCutoff, isNewCard } from './arrivals.js';
import { createPreview } from './preview.js';

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
          ${d.category ? `<span class="chip">${esc(d.category)}</span>` : ''}
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

const tabSearch = $('tab-search');
const tabNew = $('tab-new');
const paneSearch = $('pane-search');
const paneNew = $('pane-new');
const windowSelect = $('window');
let activeTab = 'search';

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
  const onSearch = which === 'search';

  tabSearch.classList.toggle('is-active', onSearch);
  tabNew.classList.toggle('is-active', !onSearch);
  tabSearch.setAttribute('aria-selected', String(onSearch));
  tabNew.setAttribute('aria-selected', String(!onSearch));
  paneSearch.hidden = !onSearch;
  paneNew.hidden = onSearch;

  const url = new URL(location.href);
  onSearch ? url.searchParams.delete('new') : url.searchParams.set('new', windowSelect.value);
  history.replaceState(null, '', url);

  if (onSearch) {
    // Search results keep a 7-day badge regardless of the arrivals window.
    newBadgeCutoff = arrivalCutoff(index, { days: 7 });
    runSearch(qInput.value);
    qInput.focus();
  } else {
    renderArrivals();
  }
}

tabSearch.addEventListener('click', () => showTab('search'));
tabNew.addEventListener('click', () => showTab('new'));
windowSelect.addEventListener('change', renderArrivals);

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

    if (params.has('new')) {
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
    activeTab === 'new' ? renderArrivals() : runSearch(qInput.value);
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
