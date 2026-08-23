'use strict';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const n = (v) => (v ?? 0).toLocaleString();

const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '-';

const dateTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' }) : '-';

/** Table from rows, with an optional right-aligned numeric column set. */
function table(headers, rows, opts = {}) {
  if (!rows.length) return `<div class="card"><table><tr><td class="setinfo">${esc(opts.empty ?? 'Nothing yet.')}</td></tr></table></div>`;
  const numeric = new Set(opts.numeric ?? []);
  // A bar-chart table has no meaningful column names; skip the header entirely
  // rather than rendering an empty strip.
  const head = headers.some((h) => h)
    ? `<tr>${headers.map((h, i) => `<th class="${numeric.has(i) ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr>`
    : '';
  return `<div class="card"><table>
    ${head}
    ${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric.has(i) ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}
  </table></div>`;
}

/** Horizontal proportion bar, for rarity/type/set breakdowns. */
function barRows(rows, labelKey, valueKey) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  return rows.map((r) => [
    `<div class="bar-row"><div>${esc(r[labelKey])}
        <div class="bar-track"><span style="width:${(r[valueKey] / max) * 100}%"></span></div>
      </div><div class="num">${n(r[valueKey])}</div></div>`,
  ]);
}

function chart(perDay) {
  if (!perDay.length) return '<div class="card"><table><tr><td class="setinfo">No searches recorded yet.</td></tr></table></div>';
  const max = Math.max(1, ...perDay.map((d) => d.searches));
  const cols = perDay.map((d) =>
    `<div class="col ${d.searches ? '' : 'zero'}" style="height:${(d.searches / max) * 100}%"
          data-label="${esc(shortDate(d.day))}: ${d.searches} searches, ${d.visitors} visitors"></div>`).join('');
  return `<div class="card">
    <div class="chart">${cols}</div>
    <div class="chart-axis"><span>${esc(shortDate(perDay[0].day))}</span>
      <span>peak ${max}/day</span>
      <span>${esc(shortDate(perDay[perDay.length - 1].day))}</span></div>
  </div>`;
}

function render(m) {
  const a = m.activity;
  const inv = m.inventory;

  document.getElementById('range-note').textContent =
    `${n(a.searches)} searches from ${n(a.visitors)} visitors in the last ${m.windowDays} days.`;

  document.getElementById('content').innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="v">${n(a.searches)}</div><div class="k">searches</div></div>
      <div class="tile"><div class="v">${n(a.visitors)}</div><div class="k">visitors</div></div>
      <div class="tile"><div class="v">${n(a.searchesToday)}</div><div class="k">searches today</div></div>
      <div class="tile"><div class="v">${n(a.uniqueQueries)}</div><div class="k">distinct queries</div></div>
      <div class="tile"><div class="v">${n(a.clicks)}</div><div class="k">deck opens</div></div>
      <div class="tile"><div class="v">${a.missRate ?? 0}%</div><div class="k">found nothing</div></div>
    </div>

    <h2>Searches per day</h2>
    ${chart(m.perDay)}

    <h2>Not in stock <span class="hint">people searched for these and got no results &mdash; your restock list</span></h2>
    ${table(['Search', 'Times', 'Last asked'],
      m.missedSearches.map((r) => [`<span class="miss">${esc(r.query)}</span>`, n(r.searches), esc(dateTime(r.lastSeen))]),
      { numeric: [1], empty: 'Every search so far has found something.' })}

    <div class="two-col">
      <div>
        <h2>Top searches</h2>
        ${table(['Search', 'Times', 'Avg decks'],
          m.topSearches.map((r) => [esc(r.query), n(r.searches), r.avgDecks ?? 0]),
          { numeric: [1, 2] })}
      </div>
      <div>
        <h2>Most opened decks</h2>
        ${table(['Deck', 'Opens'],
          m.topClickedDecks.map((r) => [
            r.deckUrl ? `<a href="${esc(r.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.deckName)}</a>` : esc(r.deckName),
            n(r.clicks)]),
          { numeric: [1], empty: 'No deck links opened yet.' })}
      </div>
    </div>

    <div class="two-col">
      <div>
        <h2>Most opened cards</h2>
        ${table(['Card', 'Opens'], m.topClickedCards.map((r) => [esc(r.cardName), n(r.clicks)]),
          { numeric: [1], empty: 'No card links opened yet.' })}
      </div>
      <div>
        <h2>Busiest hours <span class="hint">local to the server</span></h2>
        ${table(['Hour', 'Searches'],
          m.perHour.map((r) => [`${esc(r.hour)}:00`, n(r.searches)]), { numeric: [1] })}
      </div>
    </div>

    <h2>Inventory <span class="hint">from the current index, not from visitor activity</span></h2>
    <div class="tiles">
      <div class="tile"><div class="v">${n(inv.decks)}</div><div class="k">active decks</div></div>
      <div class="tile"><div class="v">${n(inv.copies)}</div><div class="k">total copies</div></div>
      <div class="tile"><div class="v">${n(inv.names)}</div><div class="k">distinct cards</div></div>
      <div class="tile"><div class="v">${n(inv.entries)}</div><div class="k">entries (printings)</div></div>
      <div class="tile"><div class="v">${inv.foilPct ?? 0}%</div><div class="k">foil <b>(${n(inv.foilCopies)})</b></div></div>
    </div>

    <div class="two-col">
      <div>
        <h2>By rarity</h2>
        ${table(['', ''], barRows(inv.byRarity, 'rarity', 'copies'))}
      </div>
      <div>
        <h2>By card type</h2>
        ${table(['', ''], barRows(inv.byType, 'typeName', 'copies'))}
      </div>
    </div>

    <div class="two-col">
      <div>
        <h2>Biggest sets</h2>
        ${table(['Set', 'Copies'],
          inv.topSets.map((r) => [`${esc(r.setName)} <span class="pill">${esc((r.setId || '').toUpperCase())}</span>`, n(r.copies)]),
          { numeric: [1] })}
      </div>
      <div>
        <h2>Most stocked cards</h2>
        ${table(['Card', 'Copies', 'Decks'],
          inv.mostStocked.map((r) => [esc(r.cardName), n(r.copies), n(r.decks)]), { numeric: [1, 2] })}
      </div>
    </div>

    <h2>Update history</h2>
    ${table(['Started', 'Status', 'Decks', 'Added', 'Removed', 'Changed', 'Failed', 'Cards'],
      m.runs.map((r) => [
        esc(dateTime(r.started_at)),
        `<span class="pill ${r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'bad' : ''}">${esc(r.status)}</span>`,
        n(r.decks_found), n(r.decks_added), n(r.decks_removed),
        n(r.decks_changed), n(r.decks_failed), n(r.cards_total),
      ]), { numeric: [2, 3, 4, 5, 6, 7] })}

    <h2>Recent catalogue changes</h2>
    ${table(['When', 'Change', 'Deck'],
      m.recentChanges.map((r) => [
        esc(dateTime(r.created_at)),
        `<span class="pill">${esc(r.change_type)}</span>`,
        r.deck_url ? `<a href="${esc(r.deck_url)}" target="_blank" rel="noopener noreferrer">${esc(r.deck_name)}</a>` : esc(r.deck_name),
      ]))}

    <p class="setinfo" style="margin:24px 0 40px">
      Searches are recorded without cookies, IP addresses or user agents. Visitor counts use a
      salted hash that changes daily, so they cannot be linked across days or back to a person.
    </p>`;
}

async function load() {
  const days = document.getElementById('range').value;
  const token = localStorage.getItem('refreshToken');

  try {
    const res = await fetch(`/api/metrics?days=${days}`, {
      headers: token ? { 'x-refresh-token': token } : {},
    });

    if (res.status === 401) {
      const t = prompt('This server requires an admin token to view stats:');
      if (t) { localStorage.setItem('refreshToken', t); return load(); }
      document.getElementById('content').innerHTML = '<p class="empty">A token is required to view stats.</p>';
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    document.getElementById('content').innerHTML = '<p class="empty">Could not load metrics.</p>';
  }
}

document.getElementById('range').addEventListener('change', load);
load();
