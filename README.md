# Alba Securities - Stock Analyzer

A single-page dashboard published as a claude.ai artifact. This file explains how the project is organised and how to change and release it.

> **Source reconciled (2026-10-13).** `src/` now matches the live build (v1.120) again: `app.js`, `chunks/`, `index.html` and `styles.css` rebuilt from it equal the live files apart from the build hashes. `npm run check` passes (199 snapshots match `tests/golden.json`; scoring engines unchanged). The test harness was updated for the batch-refresh cards (Analysis, Strategies, Explorer share `createBatchRounds` in `src/livedata/panel.js`), the collapsible Strategy setup and the folded Explorer News.

> **Platform layer (new, not yet live).** `platform/` lets the app run outside claude.ai: `docstore.js` emulates the db the app uses, `shim.js` installs `window.claude.use(...)`, `supabase-backend.js` stores documents in Supabase (unverified until a project exists), and `supabase/schema.sql` holds the tables and access rules. `npm run platform` runs its contract tests.
>

## Layout

```
index.html                    page shell. Stamped by tools/build.js with a build id and modulepreload links (do not edit the stamped parts)
styles/main.css               the style sources: @imports of styles/01-... to 16-... in cascade order (the ORDER is the cascade)
styles.css                    BUILD OUTPUT: styles/ bundled and minified. Never edit by hand
partials/*.html               static page text (Help, Data Refresh, Knowledge Base), fetched by src/boot/partials.js
js/loader.js                  the only classic script: imports app.js and shows "Could not start" with Retry if that fails
src/                          THE APPLICATION: ES modules, one responsibility per file
  boot/                       start-up (entry: boot/start.js): stock data, partials, status cover, then loads main.js
  identity/                   who is viewing, saved preferences and UI state, saved strategies
  main.js                     the application proper (loaded by boot after the data has arrived)
  sections/                   the pages that load on first use: refreshlog, strategies, business, tradelog
app.js, chunks/*.js           BUILD OUTPUT (ES modules, code-split, hashed chunk names). Never edit by hand
tools/build.js                bundles src/ and styles/ with esbuild and stamps index.html
tools/lint.js                 structure checks (undefined names, start-up order, unused code, mutable exports, import graph)
tests/run.js                  regression harness (jsdom; bundles the same sources into one script, as jsdom cannot run ES modules)
tests/check.js                the pre-publish check: build, syntax, lint, harness vs tests/golden.json, Chromium suites
tests/state.js, browser.js, imports.js   Chromium suites
tests/golden.json             expected snapshot hashes
tests/fixtures/stocks.json    anonymised sample of the stock list used by the harness
```

### How the page loads

`index.html` loads `styles.css?v=ID` and, at the bottom, `js/loader.js`, which does `import('app.js?v=ID')`. `app.js` (small) runs the start-up sequence in `src/boot/` (stock data from the database, partials) and then `import()`s the application chunk. The build id changes with every build, so the page never mixes old and new files; chunk names carry a content hash. Data Refresh, Strategies, Business and Trade Log are loaded the first time their menu item is opened (`core/lazy.js`, parts defined in `ui/navigation.js`); if the download fails the page shows a message with Retry.

### Modules in `src/`

| Folder | What lives there |
| --- | --- |
| `core/` | `stocks` (the stock list and lookups built from it), `fundscore` (which Fundamental Score factors count, and the score over them: only reliable information is scored), `dom` (the shared stock detail panel), `view` (whether page changes are remembered yet), `store` (state backed by the database: db handle, pins, refresh queue, upload and sync logs, Trade Log; private to the module, reached through accessors and actions), `util`, `pins`, `refreshrequests` |
| `list/` | `metrics` (derived numbers and filter predicates: score band, MoS, week and month change) |
| `detail/` | the stock detail page: `render`, `valuation`, `fundamentals` (panel) with `fundcell` (factor card), `fundsummary` (Strengths / Watch-outs), `fundtext` (business lines), `fundmetrics` (metric names and readers), `technical`, `globalfactors`, `peers`, `completeness`, `pending`, `jumpnav` |
| `strategies/` | the Strategies section: `fields` (what a rule can look at), `rules` (testing a stock against rules), `state` (saved strategies and starters), `editor` (rule rows), `results` (qualifying table, why-in-or-out), `section`, plus the goal features: `goal`, `indicators` (EMA/MACD/RSI series, same rules as the Technical Score engine), `samples` (one sample per past week), `learn` (rule search, held-out check), `pricedata`, `learnpanel`, `tracking` (saved lists and judging), `trackpanel` |
| `analysis/` | the Analysis section: `section` (puts it together and redraws), `filterpanel`, `controls` (sliders, toggles), `geometry` (chart scales and static SVG), `tooltip`, `leaderboard`, plus `state`, `selectbar`, `columns` |
| `research/` | research age and trigger status |
| `overlays/` | applying saved research and updates on top of the base stock data |
| `prices/` | price history: `store` (lazy per-stock loading), `chart`, `events` (event tags under the charts), `refresh` |
| `engine/` | `technical` (EMA, MACD, RSI, composite score) |
| `tv/` | TradingView: `connector` (calls, retries, symbols, bars), `links` |
| `livedata/` | the Live Data Refresh buttons: `bar`, `fundamental`, `technical`, `claude`, `symbols`, `panel` (markup shared by the Analysis and Strategies panels), `batch`, `events` (dated news / results / company events saved for the chart tags) |
| `import/` | (loaded with the Data Refresh page) CSV and TradingView imports: `fund-engine`, `fund-import`, `tech-engine`, `tech-import`, `csv-upload`, `csvparse`, `upload-history`, `wlsync` |
| `business/` | the Business page: `calc` (industry table: changes over a period, breadth, news, and the stocks qualifying for the chosen strategy; pure functions), `news` (collects the latest TradingView headlines for chosen stocks on demand and saves them as the stock's events), `panel` (table, period and grouping buttons, price history loaded on first use of a long period). Loaded on first use via `sections/business.js` |
| `tradelog/` | the Trade Log: `panel`, `form` |
| `joblogs/` | Data Refresh page panels: `panels`, `freshness`, `integrity` |
| `sync/` | `subscriptions`: the live database subscriptions |
| `ui/` | `activity` (the notification bell at the top right of every screen: its closed-by-default panel lists a running Live Data Refresh with Stop and View and the notices left by finished ones, and a badge counts the unopened ones; `livedata/batch.js` and `livedata/bar.js` report into it), `suggest` (ranking for stock-name suggestions), `navigation`, `theme`, `restore`, `inlinedetail` (opens a stock's detail inside the page you are on: Analysis, Strategies, Explorer), `deeplink` |
| `app/` | `actions`: debug handle and restoring the last page |

## Conventions

- **Imports are explicit.** A module uses only what it imports; `node tools/lint.js` fails on an undefined name or a missing import.
- **A module cannot assign to another module's variable.** Shared state that several modules change lives behind accessors and named actions, not exported variables: see `core/store.js` (private `state`; `getDb()`, `replaceTradeLog(...)`, `togglePinnedTicker(...)` and so on). Prefer that for new shared state. Exporting a `let`/`var`, or a `set_<name>` function, is a lint error: use a getter (`getX()`) and a setter or action (`setX(v)`) in the owner. State that only one module uses stays private in that module.
- **Start-up code lives in an `init_<module>()` function** and is called from `src/main.js` in a fixed order (before the data arrives: from `src/boot/boot.js`). Code for a page that loads on demand is started by that page's `init()` in `src/sections/`. Module-level code should only declare things. Do not read another module's value at module level unless that module is evaluated first (lint checks this).
- **No unused code.** Lint (`--strict`, used by `check`) fails on a declaration or export nobody uses.
- **Grid standard.** Every data grid (Analysis, Strategies, Business) uses the one set of rules at the top of `styles/15-strategies.css`: header 0.72rem uppercase muted, 9px (header) / 11px (cell) by 8px padding (phones: 9px / 12px by 5px, in `styles/19-phone.css`), one line per cell, columns as wide as their content (`width:max-content`), right-aligned numbers, hover, green/red changes, no visible divider lines (transparent borders keep the spacing). A new grid reuses `.strat-table` (or is added to that selector list) and builds its columns from the shared cells (`STRATEGY_COLUMN_IDS`, `analysisLbCell`, `columnHeaderHtml`); page CSS may only add behaviour such as a sticky first column or a highlight.
- Page-wide globals that are allowed (browser globals and `claude`, the claude.ai runtime; `window.__alba` is the one debug/test handle) are listed in `tools/lint.js`.

## Working on it

```
npm install            once per fresh checkout (needs network)
# edit files in src/ and styles/ (and partials/, js/loader.js)
npm run check          build (app.js, chunks/, styles.css) + syntax + lint + regression harness; must print OK before publishing
npm run update-golden  after reviewing an intended change in behaviour, accept the new snapshots
```

If `check` reports differing snapshots, the new ones are written to `tests/out/`. To see what changed, run the harness on the previous version
(`node tests/run.js <previous project dir> <folder>`) and diff the two folders. Snapshots are hashes of the page after each step, so any visible change shows up, including wording.

## Releasing (publishing the artifact)

1. `npm run check` is green (it rebuilds `app.js`, `chunks/` and `styles.css`).
2. Publish `index.html` as the page, with every changed file in the `files` map (published path -> local path). Always include `app.js`, `styles.css`, `index.html` and ALL of `chunks/*` (the build id changes every time). Remove published chunks that no longer exist locally by mapping them to `null`.
3. Open the live page once and click through Analysis, Explorer, a stock detail page, Data Refresh, Strategies and Trade Log (the last three load on first use). The harness cannot test the real claude.ai runtime (database, connectors, Claude, module loading), only a stand-in for it.
4. To go back, republish the previous files; artifact versions are kept.

## What the harness covers, and what it does not

Covers: boot with saved preferences, the Analysis section (filter buttons, RSI and MoS sliders, axes, colours, sort, tooltip, dot click, pinning, select mode, columns), theme, Trade Log view,  lazy price-history loading, the price-chart event tags and their legend toggles, the Fundamental refresh (up-to-date skip, forced run, Claude tiers and prompt sizes) and the Technical refresh (price, bars, technical score) against a stubbed Claude and TradingView.
Also covered, by `tests/engines.js` (plain Node, no browser; run as part of `npm run check`): the CSV import engines. That is the CSV parser, the fundamental engine (column detection by header text, peer percentiles with the industry / group / all-stocks fallback, the nine factors, verdicts, the earnings-quality discounts) and its apply step (re-scoring listed stocks in place, onboarding new ones, BSE-only codes, what is left untouched), and the technical engine (column detection, MACD and RSI scoring, missing-component rescaling, symbol matching by NSE code, BSE number, hyphen/underscore). All data is made up. `tests/engines.golden.json` holds today's exact scores for that made-up set; after a deliberate scoring change, review why they moved, then `node tests/engines.js --update` (`npm run update-golden` does this too).
Also covered, by `tests/browser.js` (real Chromium through Playwright, ~25 s; part of `npm run check`, or `npm run browser` alone; skipped with a notice if Playwright is not installed): the start-up in `src/boot/` against a stand-in database (first load in chunks, the IndexedDB cache on the second visit, a newer version ignoring the cache, the "data updated" banner, a chunk that fails once, and each message shown when the list cannot load: no database, no index, missing chunk, wrong count, app.js missing), and layout (every section at 1280, 820 and 390 px wide with no sideways scrolling or anything sticking out and no console errors; the Live Data Refresh cards side by side on desktop and stacked on a phone; the three themes).
Also covered, by `tests/state.js` (real Chromium; ~25 s; part of `npm run check`, or `npm run state` alone; skipped with a notice if Playwright is not installed): the state kept in `core/store.js`, seen through the page and checked in the stand-in database. Pins: shown from the database, saved per user, replaced when another device changes them, still saved when clicked before the database capability has arrived (`slowDbAfterApp`), session-only when nobody is signed in (`noUser`). Trade Log: shown from the live collection (`liveCollections`), add (with the duplicate guard and the verdict snapshot), sell (realised return), remove (two clicks), the Cards / Table buttons, the saved Table view used on load, and the signed-out view. These three stand-in options are opt-in in `tests/lib/env.js`.
Also covered, by `tests/ticker.js` (real Chromium; ~25 s; part of `npm run check`, or `npm run ticker` alone; skipped with a notice if Playwright is not installed): the live ticker (`src/live/ticker.js`). The clock is fixed to a Monday during the market session, and the stand-in TradingView answers with a price and its weekly and monthly performance (`Perf.W`, `Perf.1M`). Checked: the one call asks for `close`, `Perf.W` and `Perf.1M`; the Price, MoS, W % chg and M % chg cells of the first 20 rows on screen show the answer and so do the stocks themselves (sorting and filters read the same numbers); a figure TradingView leaves out keeps the earlier value; nothing is saved.
Also covered, by `tests/imports.js` (real Chromium; ~1.5 min; part of `npm run check`, or `npm run imports` alone, `-- --only <text>` to run matching scenarios): the import flows that touch the page and the database, driven through the real buttons against a stand-in database with live listeners and injectable failures, an asset store and a fake TradingView watchlist service. The stock database is made up (about 2,000 companies scored by the real engines, `tests/lib/dataset.js`). Covered: choosing a file (preview counts, what is stored, refused files), the fundamental import (the new stock list is compared with what the engine produces for the same file, only changed chunks are rewritten, the backup holds the previous list, the upload record and lock, a repeat import, restore, the warning prompts with Cancel and "Import anyway", the guards: owner only, no file, missing file, wrong layout, lock and stale lock, too few stocks, backups pruned to five), failures during the write (a refused chunk write, a refused index publish, someone else changing the data meanwhile: all roll back to exactly the old data, and a failing read-back after publishing says the data is live), the technical import (scores, kept readings, prices and margin of safety, BSE symbol lookup, partial files), the upload histories (only the 3 most recent records are kept), and the watchlist sync (first sync, repeat sync, swap order, dropped symbols, too many dropped, the safety stop, leftover temporary list, no connector, lock, too few qualifying stocks, BSE lookup).
Does not cover: the real claude.ai runtime, the real database, and real TradingView or Claude output. CSS and layout are checked only in Chromium against the stand-in database, not on the live page.

## Release history note

The delivery was restructured: one classic `js/loader.js` imports an ES-module `app.js` that loads code-split `chunks/`; `styles.css` is built from `styles/`. `js/identity.js` and `js/boot.js` no longer exist (now `src/identity/` and `src/boot/`).
