# MTG Card Search Aggregator

Search a Magic: The Gathering card name and see **every ManaBox deck on a seller's
Linktree that currently stocks it** — with quantity, foil status, printing, and a link
straight to the deck page. A **New arrivals** tab lists what the seller has added
recently.

A static site. No server, no database. GitHub Actions scrapes the sites and publishes a
JSON index; GitHub Pages serves it; the browser does the searching.

**Live:** https://wecarrasco.github.io/fardos/

---

## How it works

```
GitHub Actions  (twice daily, or the "Update now" button)
  ├─ runs the scrapers
  ├─ writes index.json  (1.4 MB, 149 KB over the wire)
  └─ publishes to the gh-pages branch

GitHub Pages
  └─ the browser loads index.json once, then searches locally
```

Scraping happens at build time because it has to: neither `linktr.ee` nor `manabox.app`
sends CORS headers, so a browser cannot fetch them. Once the index has loaded, every
search runs in memory in a few milliseconds with no network at all.

---

## First-time setup

**1. Push the repository**

```bash
git remote add origin git@github.com:wecarrasco/fardos.git
git push -u origin main
```

**2. Run the workflow once**

Actions → **Update card index** → **Run workflow**. It takes about three minutes and
creates the `gh-pages` branch.

**3. Turn on Pages**

Settings → Pages → Source: **Deploy from a branch** → `gh-pages` / `(root)`.

The site appears at `https://wecarrasco.github.io/fardos/` a minute later.

**4. Create a token for the update button** (each person who needs it)

Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- **Repository access:** Only select repositories → `fardos`
- **Permissions:** Repository permissions → **Actions: Read and write**
- Nothing else.

The web page prompts for it the first time you press **Update now** and keeps it in that
browser's local storage. It is never committed and never leaves your machine except to
`api.github.com`.

If it leaks, the worst anyone can do is trigger or cancel workflow runs on this one
repository. They cannot read or push code, or touch anything else in your account. Note
that fine-grained tokens expire — when the button starts returning 401, generate a new
one and the page will ask for it again.

---

## Updating the content

Three ways, all the same job:

- **The button.** Press **Update now** on the site. It calls the GitHub API, then polls
  the run and shows real progress. When the run finishes the page reloads the index by
  itself.
- **The schedule.** The workflow runs at 08:00 and 20:00 UTC. GitHub treats scheduled
  jobs as best-effort, so expect some drift.
- **The Actions tab.** Run workflow, manually.

Each run re-reads the Linktree page, re-scrapes every deck it lists, and republishes the
index. The commit message on `gh-pages` records what changed, e.g.
`Index: 63 decks, 22968 cards, 2 added, 4 changed`.

---

## Pointing it at a different seller

Change `LINKTREE_USERNAME` in [`src/config.ts`](src/config.ts) (or set it as an
environment variable), then run the workflow. That is the only change needed.

For a different repository, update [`web/config.js`](web/config.js) — `owner` and `repo`
are what the update button calls.

---

## Local development

```bash
npm install
npm run build:index     # scrape and build into dist-site/ (~3 min)
npm run serve:site      # http://localhost:4173
```

| Command | What it does |
| --- | --- |
| `npm run build:index` | Scrape and build the static site into `dist-site/` |
| `npm run serve:site` | Serve `dist-site/` locally |
| `npm test` | Test suite (offline, ~1s) |
| `npm run typecheck` | TypeScript check |
| `npm run scrape:linktree` | Print discovered deck links (`--json` to pipe) |
| `npm run scrape:deck -- <id>` | Print one parsed deck (`--json`) |
| `npm run fixtures:update` | Re-download the saved test pages |

The two scraper commands hit the network directly and write nothing, which makes them
the right tool for checking a parser after a site change.

The update button will not work against `localhost` unless you have a token in that
browser — it calls the real GitHub API either way.

---

## New arrivals

The site has a **New arrivals** tab listing cards that entered the catalogue recently,
over a window you pick: since the last update, or the last 7 / 30 / 90 days. Cards inside
the window also carry a green **NEW** badge in ordinary search results.

### What counts as new

A *printing* — name, set, collector number and foil finish together — that was not in the
previous index. Some consequences worth knowing:

- **A card moved between decks is not new.** Identity is catalogue-wide, so reshuffling
  decks does not resurface cards as arrivals.
- **A different printing of a card you already stock is new.** A second copy from another
  set, or a foil version of a card you had in non-foil, is genuinely new stock.
- **Restocking is not an arrival.** Going from 1 copy to 12 changes the quantity, not the
  printing, so it does not appear here.
- **A card that leaves and returns reads as new**, which matches how a buyer would see it.
- **A card that sells out disappears from the list**, even inside the 7-day window. The
  index only ever describes current stock, so a card added in the morning and sold by
  evening is simply gone — listing something unbuyable would send people to an empty deck
  page. Selling *some* copies changes only the quantity, so the card stays listed as a
  recent arrival with its count reduced.

### The two kinds of window

**Day ranges** (7 / 30 / 90) ask "what arrived recently" and are the default, so a card
added in the morning stays listed for a week regardless of how many quiet builds run in
between. This is the window most people want.

**"Since the last update"** asks "what did the most recent build bring in", and is empty
whenever that build added nothing — which is most of them. That is the honest answer, not
a fault, so the empty state points at the day ranges instead of leaving a dead end.

It is answered by an explicit list of the printings each build added, stored in the index,
rather than by comparing dates. Two builds run on the same day, and a date comparison
could not tell the evening's arrivals from the morning's — it would keep showing the
morning's cards after a quiet evening build.

### How it survives twice-daily builds

Each build stamps every card with `firstSeen`, the date its printing first appeared, and
carries that date forward on every later build. Without this, "new" could only ever mean
"since the previous build" — and with the workflow running twice a day, anything added in
the morning would vanish from the list by evening.

**The first build stamps nothing.** With no history there is no way to tell a genuine
arrival from a card that has been in stock for months, and announcing the entire
8,000-card catalogue as new would be worse than announcing none of it. Cards already in
stock when tracking began stay undated and never appear as arrivals; the list fills in
naturally as real changes happen.

Carrying a date on every card costs about **13 KB** gzipped, because the dates repeat and
compress well.

---

## Parsing

`src/scrapers/linktree.ts` reads the anchors Linktree tags with
`data-testid="LinkClickTriggerLink"` and takes each link's section from the `<h3>` inside
its enclosing `LinkCollectionStack`. Links above the first stack are genuinely
ungrouped, not a parse failure.

`src/scrapers/manabox.ts` prefers the **JSON payload ManaBox embeds** in the
`<astro-island props="...">` hydration attribute, which carries the full card list
including set, collector number, rarity, and a `variant` field that gives foil status
exactly. If that payload disappears, it logs an anomaly and falls back to parsing the
rendered rows.

Two things to know before touching this code:

- **Every card is rendered twice**, once for a desktop wrapper and once for mobile. The
  DOM fallback selects only `div.hidden.md\:block` — one row per entry. It does *not*
  dedupe by card name, because a deck can legitimately hold the same card in two
  printings (the sample deck has Seedborn Muse in both Tenth Edition and Battlebond).
- **Card types are bare integers.** `CARD_TYPE_NAMES` was worked out empirically: types
  1–5 and 7 by matching per-type quantity totals against the rendered group headings,
  type 0 (Planeswalker) and type 6 (Battle) from their members, and type 8 from
  ManaBox's own "Other" heading on the token decks.

---

## Resilience

Both sites are scraped without an official API, so their markup can change without
warning. The design assumes it will:

- **Selectors are isolated.** `LINKTREE_SELECTORS` and `MANABOX_SELECTORS` sit at the top
  of their modules; a markup change should be a one-block edit.
- **Parsers are pure functions.** `parseLinktree(html)` and `parseDeckPage(html, id)` take
  HTML and return data, so they can be tested against a saved page with no network.
- **The workflow runs the tests before scraping.** If a site changed shape, the run fails
  at the fixtures rather than publishing a broken index.
- **An empty result aborts the build.** Zero decks, or decks that all parse to zero cards,
  exits non-zero and publishes nothing — the previously published index stays up. Losing
  a day of freshness beats replacing a working site with an empty one.
- **Every deck's total is cross-checked** against the "N cards" count the page states for
  itself, and a mismatch is logged per deck.
- **One bad deck cannot fail a build.** Failures are counted and skipped; a deck returning
  404/410 is dropped from the index.

Anything that parses to nothing logs `SCRAPE ANOMALY`, because an empty result almost
always means a layout change rather than an empty page. All logging goes to stderr, so
`--json` output on stdout stays pipeable.

---

## Tests

```bash
npm test
```

57 tests, about a second, **no network**. They run against gzipped copies of real pages
in `test/fixtures/`, so the suite is deterministic even though the live decks change
daily. Built on Node's own `node:test` runner — no test framework dependency.

| Fixture | Guards |
| --- | --- |
| `linktree.html.gz` | 63 links, 5 section headings, ungrouped links above the first section |
| `deck-mixed.html.gz` | foils, two printings of one card, types 1–5 and 7 |
| `deck-small.html.gz` | a tiny deck where entries outnumber unique names |
| `deck-planeswalkers.html.gz` | type 0 really is Planeswalker |
| `deck-battles.html.gz` | type 6 really is Battle |
| `deck-tokens.html.gz` | type 8 is the "Other" bucket |

The card-type assertions check membership, not just counts, so the mapping cannot drift
into being wrong-but-consistent. Every deck fixture is also checked against the
invariant that matters most — parsed quantities must equal the total the page states for
itself.

Degradation is tested by deliberately breaking each fixture: removing Linktree's
`data-testid` still finds all 63 links; removing ManaBox's JSON payload falls back to DOM
parsing with **identical** name, quantity and foil for all 57 entries, without
double-counting the mobile copy of each row; breaking both yields 0 cards *and* a logged
anomaly rather than a silent empty deck.

`test/search.test.ts` covers the browser-side search against an index built from the same
fixtures, so the contract between build output and frontend is exercised directly.

### Updating fixtures

```bash
npm run fixtures:update
```

Do this only when a test fails for a reason you believe is a real site change — then read
the diff before committing, because updating a fixture silently redefines what "correct"
means. Expected values in the tests are a snapshot of the fixture, not of the live site,
so a genuine change usually means editing both.

---

## Layout

```
src/
  config.ts             scrape settings (username, delays)
  logger.ts             leveled logging + the anomaly channel
  scrapers/
    http.ts             fetch with timeout, retries, 404-is-terminal
    linktree.ts         LINKTREE_SELECTORS + parseLinktree()
    manabox.ts          MANABOX_SELECTORS + parseDeckPage() + DOM fallback
  cli/                  standalone scrapers for debugging
web/                    the site; copied verbatim into the build output
  index.html
  app.js                UI, index loading, the update button
  search.js             the search itself, plain ESM so Node can test it
  normalize.js          card-name folding, shared by build and browser
  arrivals.js           the New arrivals view
  config.js             repo details for the update button
scripts/
  build-index.ts        scrape -> index.json -> dist-site/
  lib/diff.ts           arrival stamping and deck diffing, kept pure for tests
  update-fixtures.ts    re-download the saved test pages
test/
  fixtures/             gzipped copies of real pages
  *.test.ts             parser and search tests
.github/workflows/
  update-index.yml      scheduled + manual scrape, publishes to gh-pages
```

There is no build step for the frontend: `web/` is plain ES modules, copied as-is.

---

## Notes on politeness

Deck pages are fetched sequentially with a configurable delay (1200 ms default), a 20 s
timeout, and two retries with exponential backoff. One build takes about three minutes
and issues 64 requests, twice a day. Please leave `FETCH_DELAY_MS` at a reasonable value —
this scrapes someone's public pages.
