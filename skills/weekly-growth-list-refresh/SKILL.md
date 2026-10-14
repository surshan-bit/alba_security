---
name: "weekly-growth-list-refresh"
description: "Use when a new weekly Growth List CSV export needs to be merged into the Alba Securities stock dashboard (stock_dashboard.html) covering Fundamental, Technical, Valuation, and Global Factors sections."
---

# Weekly Growth List refresh (Technical Score) - runs in the dashboard, not in Claude

**Storage: the stock list lives in the artifact database (ArtifactData, url https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh), never in the page. NEVER read, edit or republish index.html for a data change.** `merge-io.js` and `runMerge` are retired.

**Since 2026-10-09 (dashboard v1.20) the Technical Score CSV import runs entirely inside the dashboard page, and so does the Fundamental one.** The owner uploads the TradingView Growth List on the Data Refresh page and presses "Import data" in the Technical Score section. The page matches, scores, refreshes prices and margins of safety, takes an automatic backup, writes the changed chunks with a progress bar and verifies the result. No Claude run is needed, and the old "Import Data opens a Claude conversation" button is gone. If someone asks Claude to process a Growth List CSV, tell them to use the page; do not rebuild the pipeline in the conversation.

The dashboard has four sections per stock, each with its own cadence and its own CSV. Do NOT treat the two CSVs as interchangeable.

| Section | Cadence | Source |
|---|---|---|
| Technical Score (RSI/MACD composite) | Whenever a new TradingView Growth List CSV is uploaded, every matched stock (mechanical, in the page). The page can also refresh it per stock or in bulk from TradingView bars ("Refresh price & technicals"). | Technical Score CSV upload (Import data button), or the page button |
| Fundamental Analysis | Whenever a new screener.in CSV is uploaded, every matched stock | Fundamental Score CSV upload (Import data button on the page; skill `fundamental-score-csv-refresh-v3` describes it) |
| Valuation Snapshot | Tied 1:1 to the Fundamental Score CSV (mechanical DCF from the same file) | Fundamental Score CSV upload |
| Global & Macro Factors | Its own manual "Refresh Data" trigger, independent of both CSVs | Manual web research only |

## CRITICAL: only the Fundamental Score CSV onboards new stocks
The Technical Score (Growth List) CSV NEVER creates a stock. A Growth List symbol with no dashboard match is skipped entirely (not added, not scored). A symbol in the screener.in CSV with no match is a new-ticker onboarding, handled by the Fundamental import. The Growth List CSV has only technical data, so an onboarding from it would produce an incomplete record.

## A. What the in-page Technical import does (js/techimport.js)
- Reads the newest `technicalCsvUploadLog` record with status `uploaded` and fetches that exact asset (`/_blob/<assetId>`), so a stale file can never be reused. Refuses a file with no Symbol column or with most MACD/RSI columns missing.
- Loads the stored stock data (`stockMeta/main` + `stockData/cNNN`) and the BSE code -> TradingView symbol map (`stockMeta/bseAlpha`, a flat map; 255 entries after 2026-10-09). Backs up the current data (newest 5 kept in `backupLog`, shared with the Fundamental import and restorable from either section), scores, runs integrity checks, writes only the changed chunks (meta last, rollback on failure), then reads back to verify. Takes the shared lock `importJobs/fundamental`, so the two imports never run together.
- Matching: `ticker.split('·')[0].trim().toUpperCase()` against the CSV `Symbol`, then the BSE alpha map for numeric tickers, then the hyphen/underscore variant. Header text is matched case-insensitively and "Moving average convergence divergence" is read as MACD (TradingView spells it either way).
- Composite 0-10 with the partial-data rule: MACD per timeframe state `bull_above`/`bear_above`/`bull_below`/`bear_below` with fraction 1 / 0.5 / 1/3 / 0, monthly weight 2.5 and weekly weight 1.5; RSI zones >=70 overbought 0.8, >=55 strong 2.0, >=45 neutral 1.2, >=30 weak 0.4, else oversold 0, monthly and weekly weight 2.0 each; valuation points `(pillars.val/10)*2.0` with weight 2.0. Only components present count; composite = (available points / available weights) * 10, rounded to 2 decimals; the `reason` text names missing components. Writes `stock.technical = {score, states, raw, reason, asof}` with asof = the upload date (IST).
- Curated blocks are kept: if the CSV row lacks a component that the stock's stored technical block already has (hand-written or BSE-derived readings such as AIIL and BALUFORGE), the stored block is left as is and listed on the result card. Stocks with no CSV row, or with `pillars.val` missing, keep their block.
- Price & MoS: the CSV `Price` column (rows whose `Price - Currency` is INR) becomes `valuation.currentPrice` (2 dp) and `valuation.asof` for every matched stock with an `intrinsicValue`, and the dcf factor's "Current price" / "Margin of safety" rows and the note text follow. intrinsicValue, Graham Number, NCAVPS and every factor score are never changed from this CSV.
- Marks the upload log record `processed` with a note, and keeps the 3 newest log records.

## B. When Claude is involved
- **New BSE-only stock**: it has no TradingView symbol in `stockMeta/bseAlpha`, so the import cannot match it. Resolve its alpha symbol via `mcp-tv-search-symbols` (see `tradingview-watchlist-symbol-mapping`; never construct `BSE:<numeric code>`), add it with ArtifactData `update` on `stockMeta/bseAlpha`, and the next import picks it up. Four micro-caps (505720, 531525, 526477, 526211) have no CSV row and stay unscored.
- **Something looks wrong after an import**: use Restore on the Data Refresh page (either section) to go back to the backup taken just before.
- **Page code changes** (scoring rules, columns): edit js/techimport.js in the artifact; keep it in step with this description, and test against a real Growth List with a Node harness before publishing.
- **Fundamental CSV**: the Import data button in the Fundamental section; see `fundamental-score-csv-refresh-v3`. Researched factors (Moat, Governance and others) live in `stockResearch` and are applied on load; never write to or delete it during a refresh. Only non-mechanical research is delegated to subagents: about 20-25 stocks per agent and at most 2 agents in parallel.

## Overlay notes
`stockResearch`, `stockUpdates` (technical block and company-level Global & Macro items, one doc per ticker) and `priceHistory` are separate collections that a data refresh never touches. A `stockUpdates` technical block whose `asof` is the same as or newer than the stock's own `technical.asof` still overrides the base block on load, so stamp CSV-derived blocks with the CSV's date; if an older page-side refresh wins unexpectedly, delete that document's `technical` field.

## Key constraints learned the hard way
- Technical Score CSV never onboards a stock; unmatched Growth List symbols are skipped.
- A missing technical component does not freeze the stock: score from what is available and rescale to 0-10. Only a total match-miss or missing `pillars.val` freezes the reading.
- A ticker dropped from a CSV is never deleted; only its own section stays frozen at the last values.
- Never touch `s.pillars`: dormant in the UI but required by the technical valuation blend.
- Scoring ~2,100 stocks takes well under a second; the cost used to be orchestration in a Claude run, which is why both CSV imports now run in the page.
- WebSearch has a hard session-wide cap (~200 calls) shared across all agents and WebFetch a separate limit that can take hours to reset; keep real research to 2 parallel agents. Analyst target ranges: show low-high with sources, never one collapsed number.