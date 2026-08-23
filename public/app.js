'use strict';

const $ = (id) => document.getElementById(id);
const qInput = $('q');
const resultsEl = $('results');
const summaryEl = $('summary');
const emptyEl = $('empty');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Mirror of the server's normalizer, used only to position highlight marks. */
const norm = (s) =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Wrap the matched span of a card name in <mark>, matching on the folded form. */
function highlight(name, query) {
  const nq = norm(query);
  if (!nq) return esc(name);

  // Walk the original string, tracking its normalized offset, so highlight
  // boundaries land correctly even when accents or punctuation were folded away.
  let normed = '';
  const map = [];
  for (let i = 0; i < name.length; i++) {
    const piece = norm(name[i]);
    if (!piece) {
      // Character folded away entirely (punctuation); it belongs to the run
      // that precedes it, so a separator does not break a match visually.
      if (normed.length && !normed.endsWith(' ')) { normed += ' '; map.push(i); }
      continue;
    }
    for (const ch of piece) { normed += ch; map.push(i); }
  }
  const at = normed.indexOf(nq);
  if (at === -1) return esc(name);

  const start = map[at] ?? 0;
  const end = at + nq.length < map.length ? map[at + nq.length] : name.length;
  return esc(name.slice(0, start)) + '<mark>' + esc(name.slice(start, end)) + '</mark>' + esc(name.slice(end));
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

function renderDecks(data) {
  if (!data.decks.length) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = `No active deck currently lists a card matching "${data.query}".`;
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
              <span class="name">${highlight(c.cardName, data.query)}</span>
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

let seq = 0;
async function search(q) {
  const mine = ++seq;
  if (!q.trim()) {
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = 'Type a card name to see which decks have it.';
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (mine !== seq) return; // a newer keystroke already won
    renderDecks(data);
  } catch (err) {
    if (mine !== seq) return;
    emptyEl.hidden = false;
    emptyEl.textContent = 'Search failed - is the server still running?';
  }
}

async function loadSuggestions(q) {
  if (q.trim().length < 2) return;
  try {
    const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    const names = await res.json();
    $('suggestions').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  } catch { /* suggestions are optional */ }
}

async function loadStatus() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    const run = s.lastRun ?? {};
    refreshRequiresToken = Boolean(s.refreshRequiresToken);
    const when = run.finished_at ?? run.started_at;
    if (!s.activeDecks) {
      $('index-status').innerHTML =
        '<span class="dot bad"></span>No data yet - press <b>Update now</b> to fetch the decks ' +
        '(takes about two minutes).';
      $('foot').textContent = '';
      return;
    }

    // Content only changes when someone presses the button, so the dot is a
    // nudge about staleness rather than a health check on a background job.
    const ageH = when ? (Date.now() - Date.parse(when)) / 3600000 : Infinity;
    const cls = ageH < 24 ? 'ok' : ageH < 72 ? 'warn' : 'bad';
    $('index-status').innerHTML =
      `<span class="dot ${cls}"></span>` +
      `<b>${s.activeDecks}</b> decks &middot; ` +
      `<b>${(s.totalCards ?? 0).toLocaleString()}</b> cards &middot; ` +
      `<b>${(s.uniqueNames ?? 0).toLocaleString()}</b> unique names &middot; ` +
      `last updated ${esc(fmtDate(when))}` +
      (run.status && run.status !== 'ok' ? ` (last run: ${esc(run.status)})` : '');
    $('foot').textContent =
      `${s.cardEntries ?? 0} card entries indexed. Data scraped from public ManaBox deck pages.`;
  } catch {
    $('index-status').innerHTML = '<span class="dot bad"></span>Could not reach the server.';
  }
}

/* ---------------------------------------------------------------- *
 * Manual refresh
 * ---------------------------------------------------------------- */

const btn = $('update-btn');
let refreshRequiresToken = false;

/**
 * On a public deployment the server is started with REFRESH_TOKEN set. Ask for
 * it once and keep it in this browser so the button works normally afterwards.
 */
function refreshToken() {
  if (!refreshRequiresToken) return null;
  let t = localStorage.getItem('refreshToken');
  if (!t) {
    t = prompt('This server requires an update token:');
    if (t) localStorage.setItem('refreshToken', t);
  }
  return t;
}
const progressEl = $('progress');
const barFill = $('bar-fill');
const progressText = $('progress-text');
let pollTimer = null;

function showProgress(st) {
  progressEl.hidden = false;
  progressText.className = 'progress-text';

  if (st.phase === 'linktree' || (st.running && !st.decksTotal)) {
    barFill.className = 'indeterminate';
    barFill.style.width = '';
    progressText.textContent = 'Reading the Linktree page...';
    return;
  }

  barFill.className = '';
  const pct = st.decksTotal ? Math.round((st.decksDone / st.decksTotal) * 100) : 0;
  barFill.style.width = pct + '%';
  progressText.textContent =
    `Updating deck ${st.decksDone} of ${st.decksTotal}` +
    (st.currentDeck ? ` - ${st.currentDeck}` : '') + `  (${pct}%)`;
}

function showOutcome(st) {
  barFill.className = '';
  barFill.style.width = '100%';

  if (st.lastError) {
    progressText.className = 'progress-text error';
    progressText.textContent = `Update failed: ${st.lastError}`;
    return;
  }

  const r = st.lastResult;
  if (!r) { progressEl.hidden = true; return; }

  const bits = [`${r.decksFound} decks checked`];
  if (r.decksAdded) bits.push(`${r.decksAdded} added`);
  if (r.decksRemoved) bits.push(`${r.decksRemoved} removed`);
  if (r.decksChanged) bits.push(`${r.decksChanged} changed`);
  if (r.decksFailed) bits.push(`${r.decksFailed} failed`);
  if (!r.decksAdded && !r.decksRemoved && !r.decksChanged) bits.push('nothing changed');

  progressText.className = 'progress-text ' + (r.status === 'failed' ? 'error' : 'done');
  progressText.textContent = `Update ${r.status}: ${bits.join(', ')}.`;
  // Leave the summary up briefly, then get out of the way.
  setTimeout(() => { progressEl.hidden = true; }, 8000);
}

function setBusy(busy) {
  btn.disabled = busy;
  btn.textContent = busy ? 'Updating...' : 'Update now';
}

async function pollRefresh() {
  try {
    const st = await fetch('/api/refresh/status').then((r) => r.json());
    if (st.running) {
      setBusy(true);
      showProgress(st);
      return;
    }

    // The run just ended: stop polling, report, and pull in the new data.
    clearInterval(pollTimer);
    pollTimer = null;
    setBusy(false);
    showOutcome(st);
    loadStatus();
    if (qInput.value.trim()) search(qInput.value);
  } catch {
    clearInterval(pollTimer);
    pollTimer = null;
    setBusy(false);
    progressText.className = 'progress-text error';
    progressText.textContent = 'Lost contact with the server.';
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollRefresh, 1000);
  pollRefresh();
}

btn.addEventListener('click', async () => {
  setBusy(true);
  progressEl.hidden = false;
  progressText.className = 'progress-text';
  progressText.textContent = 'Starting...';
  barFill.className = 'indeterminate';

  try {
    const token = refreshToken();
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: token ? { 'x-refresh-token': token } : {},
    });

    if (res.status === 401) {
      // Wrong token: forget it so the next press asks again.
      localStorage.removeItem('refreshToken');
      throw new Error('unauthorized');
    }
    // 409 means one is already running; follow that run instead of erroring.
    if (!res.ok && res.status !== 409) throw new Error(String(res.status));
    startPolling();
  } catch (err) {
    setBusy(false);
    progressText.className = 'progress-text error';
    progressText.textContent = String(err).includes('unauthorized')
      ? 'That update token was not accepted.'
      : 'Could not start the update.';
  }
});

let timer;
qInput.addEventListener('input', () => {
  clearTimeout(timer);
  const q = qInput.value;
  timer = setTimeout(() => { search(q); loadSuggestions(q); }, 180);
});

// Support deep links like /?q=sol+ring and keep the URL in sync.
const initial = new URLSearchParams(location.search).get('q');
if (initial) { qInput.value = initial; search(initial); }
qInput.addEventListener('change', () => {
  const url = new URL(location.href);
  qInput.value ? url.searchParams.set('q', qInput.value) : url.searchParams.delete('q');
  history.replaceState(null, '', url);
});

loadStatus();
setInterval(loadStatus, 60000);

// If a refresh was already running when this page loaded, show its progress.
fetch('/api/refresh/status')
  .then((r) => r.json())
  .then((st) => { if (st.running) startPolling(); })
  .catch(() => {});
