---
name: "fundamental-score-csv-refresh-v3"
description: "Fundamental Score refresh for the Alba Securities dashboard now runs inside the dashboard (Data Refresh, Import data). Use only to explain it, troubleshoot or restore after a failed import, or run the old scripted fallback."
---

# Fundamental Score refresh (v3, exact-industry peers)

**Since 2026-10-09 (dashboard v1.19) this refresh does NOT run in Claude chat.** The owner uploads the screener.in CSV on the dashboard's Data Refresh page (it is kept in the asset store and logged in `fundamentalCsvUploadLog`) and presses **Import data**. The page scores every stock with the v3 engine, shows a progress bar, backs up the current data first, writes the changed chunks, verifies, and marks the log entry `processed`. Do not ask the user to paste anything into chat. If they ask Claude to refresh fundamentals, tell them to use that button.

Artifact: https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh. Code: `js/fundimport.js` (engine + apply logic ported unchanged from the devTools scripts `fundamental_engine` and `apply_fundamental`, plus backup, write, rollback and restore). Only the owner can import or restore.

## What the page guarantees
- Header must match the 44-column schema below; otherwise nothing is written.
- Backup first: `backupLog` document {kind:"stocks-backup", format:"stocks.json", dataVersion, createdAt, stockCount, bytes, assetId, assetUrl} plus the asset (the whole stock list as JSON). Newest 5 kept. Older entries without `format:"stocks.json"` are legacy (pre-database) and are ignored.
- Integrity checks (numeric factors, factor sum = score within 0.05, weights 10, verdict bands 8/6/5, `pillars.val`, no duplicate tickers, no stocks/Global/Technical content lost). A large number of 1.0+ point moves (>40) asks the owner to confirm.
- Only changed chunks are written; `stockMeta/main` is written LAST (version + 1). On any failure the previous chunks are put back automatically.
- New tickers are added with safe defaults: no `screenerConsolidated` flag (page links to the consolidated Screener.in page) and no `stockMeta/bseAlpha` entry for BSE-only codes. Fix a blank link or missing chart only when the user reports one (check both screener.in URLs with WebFetch first).
- One import at a time: `importJobs/fundamental` {status: running|done|failed, startedAt}. A `running` lock older than 20 minutes is ignored. After a crash, set it to `failed` with ArtifactData.

## Troubleshooting
- Check `importJobs/fundamental` (status, error) and `fundamentalCsvUploadLog` (status, processedNote).
- Restore: the owner clicks Restore on a backup in the Data Refresh page. Without the page: fetch the backup asset (`/_blob/<assetId>`), split it into chunks of at most ~200 KB (each chunk document must stay under 256 KiB), write the chunks, then write `stockMeta/main` last with a higher version and the new `index{symbol: chunkId}`.
- Regression after a model change: OCCLLTD 6.59, GESHIP 6.37, SHANTIGOLD 6.40 on the 6 Oct 2026 CSV. If a validation stock moves by more than about 0.3, investigate before importing.
- Verdict changes cascade to the Strong/Good TradingView watchlists and the Global & Macro scope. Report counts; do not re-sync watchlists unless asked.
- The engine lives in `js/fundimport.js` and in the devTools document `fundamental_engine` (and the asset `2f88d25544daf1a1d6f24adafab9a035`). If the scoring model changes, change it in `js/fundimport.js` and keep the devTools copy in step.

## Fallback (only if the page import cannot be used)
The saved scripts still work from a Claude session: install them from `devTools` (`ArtifactData list` with out_dir), fetch `stockData` + `stockMeta/main`, then `python3 -I stockdb.py merge`, `bash refresh_fundamental.sh <csv> <db> <run> <csv date>`, write `run/out/writes_NN.json` with ArtifactData `batch` in order (meta last), read `stockMeta/main` back. Take a backup first as above.

## Expected CSV schema (44 columns)
```
Name, BSE Code, NSE Code, ISIN Code, Industry Group, Industry, Current Price, Intrinsic Value,
Book value, Profit growth, Profit growth 3Years, Profit growth 5Years, Sales growth 3Years,
Return on invested capital, Return on capital employed, Return on equity, OPM, Price to Earning,
Industry PE, PEG Ratio, Pledged percentage, Interest Coverage, Debt to equity,
Change in promoter holding, Piotroski score, Quick ratio, Altman Z Score, Current ratio,
Contingent liabilities, Average return on equity 7Years, Average return on equity 10Years,
Median return on capital employed 10Years, Free cash flow 3years, Free cash flow 5years,
Operating cash flow 3years, Operating cash flow 5years, CROIC, Graham,
Change in FII holding 3Years, Change in DII holding 3Years, Historical PE 5Years,
Average debtor days 3years, NCAVPS, Number of Shareholders
```
`Average return on invested capital 3Years` / `5Years` were tested and deliberately excluded from the model; ignore them if a future export includes them.