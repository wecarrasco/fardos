import { CONFIG, repoUrl, actionsUrl } from './config.js';
import { search, suggest } from './search.js';
import { normalizeCardName } from './normalize.js';

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

/** Wrap the matched span of a card name in <mark>, matching on the folded form. */
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
  const at = normed.indexOf(nq);
  if (at === -1) return esc(name);

  const start = map[at] ?? 0;
  const end = at + nq.length < map.length ? map[at + nq.length] : name.length;
  return esc(name.slice(0, start)) + '<mark>' + esc(name.slice(start, end)) + '</mark>' +
         esc(name.slice(end));
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

function renderResults(data) {
  if (!data.decks.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.className = 'empty';
    emptyEl.textContent = `No deck currently lists a card matching "${data.query}".`;
    return;
  }

  emptyEl.hidden = true;
  summaryEl.hidden = false;
  summaryEl.innerHTML =
    `<b>${data.totalCopies}</b> ${data.totalCopies === 1 ? 'copy' : 'copies'} ` +
    `across <b>${data.deckCount}</b> ${data.deckCount === 1 ? 'deck' : 'decks'} ` +
    `(<b>${data.hitCount}</b> matching ${data.hitCount === 1 ? 'entry' : 'entries'}).`;

  resultsEl.innerHTML = data.decks.map((d) => `
    <section class="deck">
      <div class="deck-head">
        <div class="deck-title">
          <a href="${esc(d.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(d.deckName)}</a>
          ${d.category ? `<span class="chip">${esc(d.category)}</span>` : ''}
        </div>
        <div class="deck-meta">
          ${d.totalQuantity} matching ${d.totalQuantity === 1 ? 'copy' : 'copies'}
          &middot; deck updated ${esc(fmtDate(d.deckUpdatedAt))}
        </div>
      </div>
      <table>
        ${d.cards.map((c) => `
          <tr>
            <td class="qty">${c.quantity}&times;</td>
            <td>
              <span class="name">${highlight(c.name, data.query)}</span>
              ${c.foil ? '<span class="foil">FOIL</span>' : ''}
              <div class="setinfo">
                ${esc(c.setName ?? 'Unknown set')}${c.setId ? ` (${esc(c.setId.toUpperCase())})` : ''}
                ${c.collectorNumber ? ` #${esc(c.collectorNumber)}` : ''}
                ${c.rarity ? ` &middot; ${esc(c.rarity)}` : ''}
                ${c.typeName ? ` &middot; ${esc(c.typeName)}` : ''}
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

    const initial = new URLSearchParams(location.search).get('q');
    if (initial) { qInput.value = initial; runSearch(initial); }
    qInput.focus();
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

    if (qInput.value.trim()) runSearch(qInput.value);
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

$('repo-link').href = repoUrl();
loadIndex();
