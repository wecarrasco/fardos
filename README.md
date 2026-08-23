# MTG Card Search Aggregator

Search a Magic: The Gathering card name and see **every ManaBox deck on a seller's
Linktree that currently stocks it** — with quantity, foil status, printing, and a link
straight to the deck page.

The seller edits their Linktree almost daily, so this is a refresh pipeline rather than
a one-off scrape. Pressing **Update now** in the web UI re-reads the Linktree page and
every deck it lists, replaces the stored card rows, and logs what changed.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional; sensible defaults are built in
npm start                 # http://localhost:3000
```

Then press **Update now** in the page. The first update takes about two minutes for 63
decks, with a live progress bar. After that the data is stored locally, so the app opens
instantly and you only press the button again when you want fresher data.

Requires Node.js 20 or newer (developed on 22).

---

## How to change the target Linktree

Set `LINKTREE_USERNAME` in `.env` — that is the only change needed:

```bash
LINKTREE_USERNAME=SomeOtherSeller     # scrapes https://linktr.ee/SomeOtherSeller
```

Then run `npm run refresh`. Decks belonging to the previous account stop appearing in
search results on the next run (they are no longer listed on the page, so they are
marked inactive). To start from a genuinely clean slate, delete `data/mtg.db` first.

You can also scrape a different account ad hoc without touching config:

```bash
npm run scrape:linktree -- --user SomeOtherSeller
```

## Updating the content

Content changes only when you ask for it. There is no background job.

- **In the browser** - press **Update now**. It reports live progress ("Updating deck
  24 of 63 ..."), then a summary of what changed. Search results and the freshness line
  refresh themselves when it finishes.
- **From the terminal** - `npm run refresh` does the same work and exits. Handy if you
  ever want to automate it with a real cron entry at the OS level.

Either way the run is identical: re-read Linktree, re-scrape every listed deck, replace
each deck's card rows, and record what changed.

A second update cannot start while one is running -- the button disables itself and the
API answers `409`. Reloading the page mid-update reattaches to the run in progress.

The status dot beside the deck count turns amber after 24 hours and red after 72
(`STALE_AFTER_HOURS`). It is a nudge about staleness, nothing more.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the app |
| `npm run dev` | Same, with reload on file changes |
| `npm run refresh` | Update the data from the terminal, then exit |
| `npm run scrape:linktree` | Print discovered deck links (add `--json` to pipe) |
| `npm run scrape:deck -- <deckId\|url>` | Print one parsed deck (add `--json`) |
| `npm test` | Run the test suite (offline, ~1s) |
| `npm run typecheck` | TypeScript check (src, tests and scripts) |
| `npm run build` | Compile to `dist/` for production |
| `npm run serve` | Run the compiled build (`dist/`), no `tsx` needed |
| `npm run fixtures:update` | Re-download the saved test pages |

The two scraper commands hit the network directly and never touch the database, which
makes them the right tool for checking a parser after a site change.

---

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/search?q=sol+ring` | Matching cards grouped by deck |
| `GET /api/suggest?q=sol` | Card-name suggestions for typeahead |
| `GET /api/decks` | All active decks |
| `GET /api/changes?limit=50` | Recent additions, removals, and content changes |
| `GET /api/stats` | Index size and last run |
| `GET /healthz` | Liveness. Always `200` while the process serves, even with an empty index |
| `GET /readyz` | Readiness. `200` only once there is data; `503` before the first update |
| `POST /api/refresh` | Start an update (`202`, or `409` if one is already running) |
| `GET /api/refresh/status` | Live progress of the running update |

Search is case- and accent-insensitive and matches substrings, so `seance` finds
`Séance Board` and `bolt` finds `Thunderbolt`. Exact matches rank above prefix matches
above substring matches.

---

## How it works

```
Linktree page ──> linktree.ts ──> deck links (id, url, text, section)
                                        │
                                        ▼
ManaBox deck pages ──> manabox.ts ──> deck snapshots (cards, foil, sets, edit date)
                                        │
                                        ▼
                              repo.ts ──> SQLite (replace-per-deck upsert)
                                        │
                                        ▼
                          app.ts ──> /api/search ──> public/ frontend
```

### Parsing

`src/scrapers/linktree.ts` reads the anchors Linktree tags with
`data-testid="LinkClickTriggerLink"` and takes each link's section from the `<h3>` inside
its enclosing `LinkCollectionStack`. Links above the first stack are genuinely
ungrouped, not a parse failure.

`src/scrapers/manabox.ts` prefers the **JSON payload ManaBox embeds** in the
`<astro-island props="...">` hydration attribute, which carries the full card list
including set, collector number, rarity, and a `variant` field that gives foil status
exactly. If that payload ever disappears, it logs an anomaly and falls back to parsing
the rendered rows.

Two details worth knowing if you ever touch this code:

- **Every card is rendered twice**, once for a desktop wrapper and once for mobile. The
  DOM fallback selects only `div.hidden.md\:block` — exactly one row per entry. It does
  *not* dedupe by card name, because a deck can legitimately hold the same card in two
  printings (the sample deck has Seedborn Muse in both Tenth Edition and Battlebond).
- **Card types are bare integers.** The mapping in `CARD_TYPE_NAMES` was established
  empirically: types 1–5 and 7 by matching per-type quantity totals against the rendered
  group headings, type 0 (Planeswalker) and type 6 (Battle) from their members, and
  type 8 from ManaBox's own "Other" heading on the token decks.

### Storage

`decks` holds one row per deck; `deck_cards` holds one row per *entry*, not per card
name, so distinct printings and foil/non-foil copies stay separate. On each refresh a
deck's card rows are deleted and re-inserted in a single transaction — search always
reflects the newest scrape rather than an accumulation.

`scrape_runs` and `deck_changes` record run history and individual change events, so
"what did the seller do since yesterday" is a query rather than a log grep.

### Change detection

Each deck gets an order-independent content hash over
`name | quantity | foil | set | collector number`. A reordering by ManaBox is not a
change; any quantity, foil, or printing edit is. The refresh logs and stores four kinds
of event: `added`, `removed`, `restored` (a retired deck reappearing), and
`cards_changed`.

---

## Resilience

Both sites are scraped without an official API, so their markup can change without
warning. The design assumes that will happen:

- **Selectors are isolated.** `LINKTREE_SELECTORS` and `MANABOX_SELECTORS` sit at the top
  of their modules; a markup change should be a one-block edit.
- **Parsers are pure functions.** `parseLinktree(html)` and `parseDeckPage(html, id)` take
  HTML and return data, so you can test them against a saved page with no network.
- **Zero results are treated as suspicious, not as truth.** A parse returning no decks or
  no cards logs `SCRAPE ANOMALY`, because an empty result almost always means a layout
  change rather than an empty page.
- **An empty Linktree aborts the run.** If the page yields zero decks the run is marked
  `failed` and the database is left untouched. Wiping the index over a layout change
  would be far worse than serving slightly stale data.
- **Every deck's total is cross-checked.** Parsed quantities are compared against the
  "N cards" count the page states for itself, and a mismatch is logged per deck.
- **One bad deck cannot abort a run.** Failures are counted, recorded, and skipped; a deck
  returning 404/410 is marked inactive and its cards are dropped from search.
- **Updates cannot overlap.** A second request while one is running is refused rather
  than queued. Runs left open by a killed process are reconciled on the next boot.

All logging goes to **stderr**, so `--json` output on stdout stays pipeable.

---

## Tests

```bash
npm test
```

75 tests, about a second, **no network access**. They run against gzipped copies of
real pages in `test/fixtures/`, so the suite is deterministic even though the live
decks change daily.

Built on Node's own `node:test` runner — no test framework dependency.

### What the fixtures pin down

| Fixture | Guards |
| --- | --- |
| `linktree.html.gz` | 63 links, 5 section headings, ungrouped links above the first section |
| `deck-mixed.html.gz` | foils, two printings of one card, types 1-5 and 7 |
| `deck-small.html.gz` | a tiny deck where entries outnumber unique names |
| `deck-planeswalkers.html.gz` | type 0 really is Planeswalker |
| `deck-battles.html.gz` | type 6 really is Battle |
| `deck-tokens.html.gz` | type 8 is the "Other" bucket |

The card-type assertions check membership, not just counts: the planeswalker test fails
if type 0 stops containing cards named like planeswalkers, and the battle test fails if
type 6 stops being the "Invasion of ..." cards. That way the mapping cannot drift
silently into being wrong-but-consistent.

Every deck fixture is also checked against the invariant that matters most — parsed
quantities must equal the total the page states for itself — and against the rule that
no card may fall through to the unmapped `Other (n)` label.

### Degradation is tested too

The suite deliberately breaks each fixture to confirm the fallbacks fire:

- removing Linktree's `data-testid` still finds all 63 links, and logs an anomaly
- removing ManaBox's JSON payload falls back to DOM parsing and produces **identical**
  name, quantity and foil for all 57 entries
- the fallback does not double-count the mobile copy of each row (57, not 114)
- renaming the row class as well yields 0 cards *and* a logged anomaly, never a silent
  empty deck

### Updating fixtures

```bash
npm run fixtures:update
```

Re-downloads all six pages. Do this only when a test fails for a reason you believe is a
real site change — then read the diff before committing, because updating a fixture
silently redefines what "correct" means. Expected values in the tests are a snapshot of
the fixture, not of the live site, so a genuine site change usually means editing both.

### A note on trusting the suite

The tests were mutation-checked: each of these deliberate regressions makes the suite go
red, so the assertions have teeth rather than merely passing.

| Injected bug | Tests failed |
| --- | --- |
| type 0 no longer mapped to Planeswalker | 3 |
| DOM fallback counts desktop + mobile rows | 3 |
| upsert accumulates instead of replacing | 4 |
| Linktree section headings ignored | 2 |

---

## Deploying

The app is a normal Node server with a SQLite file, so anything that runs a
container will host it. A `Dockerfile` is included, plus blueprints for two hosts.

### Before you deploy: set a refresh token

On a public URL, leave `POST /api/refresh` unauthenticated and a stranger can make your
server scrape Linktree and ManaBox on demand. Set `REFRESH_TOKEN` to any random string:

```bash
openssl rand -hex 24
```

With it set, the web UI asks for the token the first time you press **Update now** and
remembers it in that browser. Locally, leave it unset and the button just works.

### Fly.io (recommended, keeps your data)

`fly.toml` mounts a volume at `/data`, so the database survives deploys and restarts.

```bash
fly launch --no-deploy --copy-config
fly volumes create mtg_data --size 1
fly secrets set REFRESH_TOKEN="$(openssl rand -hex 24)"
fly deploy
```

Edit `app` and `primary_region` in `fly.toml` first.

### Render

Point a new Blueprint at the repo and it reads `render.yaml`. `REFRESH_TOKEN` is
generated for you; read it from the dashboard when the UI asks.

**Caveat:** persistent disks are a paid feature on Render. On the free plan the
filesystem resets on each deploy and on wake from sleep, so the index starts empty and
you press **Update now** once. The disk block is in `render.yaml`, commented out, for if
you upgrade.

### Either way

- **Point platform health checks at `/healthz`, not `/readyz`.** A fresh deploy has no
  data yet, and `/readyz` answers `503` until the first update -- aimed at the wrong
  path, the platform will restart-loop the container before you can populate it.
- **Free tiers sleep.** Expect a cold start of roughly 30-60s on the first request after
  idle. The update itself runs in-process and takes ~2 minutes, so do not close the tab
  mid-update on a host that sleeps aggressively.
- **Set `LINKTREE_USERNAME`** if you are not scraping the default account.

### Running the built image locally

```bash
npm run build && npm run serve      # no Docker
docker build -t mtg-card-search .
docker run -p 3000:3000 -v mtg-data:/data mtg-card-search
```

`npm run build` compiles to `dist/`, so production runs on plain `node` with only the
four runtime dependencies -- `tsx` and TypeScript stay in devDependencies.

---

## Layout

```
src/
  config.ts             all tunables (username, cron, delays, paths)
  logger.ts             leveled logging + the anomaly channel
  server.ts             Express app, static hosting, graceful shutdown
  scrapers/
    http.ts             fetch with timeout, retries, 404-is-terminal
    linktree.ts         LINKTREE_SELECTORS + parseLinktree()
    manabox.ts          MANABOX_SELECTORS + parseDeckPage() + DOM fallback
  db/
    schema.sql          tables and indexes
    index.ts            connection + migration on boot
    normalize.ts        card-name folding for search
    repo.ts             upserts, change detection, search queries
  jobs/
    refresh.ts          one full refresh pass, with live progress state
  api/search.ts         groups flat hits into per-deck results
  app.ts                Express app (separate from server.ts so tests can mount it)
  cli/                  standalone runners for each piece
test/
  fixtures/             gzipped copies of real pages
  fixture-manifest.ts   what each fixture covers + the gunzip helper
  *.test.ts             parser, storage and API tests
scripts/
  update-fixtures.ts    re-download the fixtures
public/                 frontend (plain HTML/CSS/JS, no build step)
data/mtg.db             SQLite database (created on first run)
```

---

## Notes on politeness

Deck pages are fetched sequentially with a configurable delay (1200 ms default), a 20 s
timeout, and two retries with exponential backoff. One update takes about two minutes
and issues 64 requests. Because updates are manual, the app makes no network requests at
all unless you ask it to. Please leave `FETCH_DELAY_MS` at a reasonable value —
this scrapes someone's public pages.
