---
name: "tradingview-watchlist-symbol-mapping"
description: "Use when syncing any TradingView watchlist for the Alba Securities dashboard (Alba Securities, Alba - Green, Alba - Orange, Alba - Red), to avoid raw numeric BSE codes and to sync all four lists correctly and safely."
---

# TradingView watchlist sync for the Alba dashboard

**Since 2026-10-10 (dashboard v1.21) the sync runs inside the dashboard page.** The owner presses "Sync now" in the TradingView Watchlist Sync section of the Data Refresh page; the page builds the four lists from the stored stock data and rewrites them in TradingView through the viewer's own TradingView connector (the page's `mcp` capability, tools list/create/add/delete/update watchlist plus symbol search). No Claude run is needed. If asked to run a sync, tell the user to use the page button; do not rebuild the pipeline in the conversation. The code is `js/wlsync.js` in the artifact (https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh); the stock data is in the artifact database (`stockMeta/main`, `stockData/cNNN`, `stockMeta/bseAlpha`), never in index.html.

## What the page does
1. Loads the stored stocks and the BSE alpha map. Strong (`buy`) and Good (`mbuy`) only. MoS = (intrinsicValue - currentPrice) / intrinsicValue * 100 for stocks with both values; Green >= 0%, Orange -25% <= MoS < 0%, Red < -25%; a Strong/Good stock without valuation data is excluded from the three MoS lists. NSE code -> `NSE:<code>`; BSE-only -> `BSE:<alpha>` from `stockMeta/bseAlpha`, never `BSE:<digits>` (the page refuses to send one); a stock with no alpha mapping is left out and reported.
2. For each list in turn (Alba Securities, Alba - Green, Alba - Orange, Alba - Red): reads the current lists; if the list already holds exactly the intended symbols it is left alone. Otherwise it creates the new list under a temporary name (`<name> (syncing)`), adds symbols in batches of 300, re-reads and checks it, and only then deletes the old list (one delete per step, then re-reads all lists and stops if anything else went missing) and renames the new list to the canonical name.
3. Symbols TradingView silently drops are retried once, then looked up on the other Indian exchange (NSE:X really being BSE:X, for example RESONANCE) via symbol search; what still cannot be placed is reported and the run is marked `partial`. If more than max(10, 3%) are dropped, the old list is left untouched and the run stops (the temp list is cleaned up by the next run).
4. Logs the run in `watchlistSyncLog` (status completed / partial / failed, qualified, Strong, Good, added, removed, droppedTickers, note) and keeps the 3 newest. Uses the lock `importJobs/watchlist`.

## When Claude is involved
- **A BSE-only stock reported as having no TradingView symbol**: call `mcp-tv-search-symbols` with the company name; pick the result with `exchange == "BSE"`, `type == "stock"` and a matching description (watch for near-duplicates, e.g. Jasch Industries vs Jasch Gauging Technologies); add it with ArtifactData `update` on `stockMeta/bseAlpha` ({"<code>": "<alpha>"}; the chart link, price refresh and Technical import use it too). Never fall back to `BSE:<code>`.
- **A hyphen or & symbol reported as unverified**: confirm with `mcp-tv-search-symbols` and, if the real symbol differs from the provisional underscore form, add it to `WL_CONFIRMED` in `js/wlsync.js` and to the table below.
- **Page code changes**: edit `js/wlsync.js`, test against a simulated TradingView before publishing, and keep the declared tool list in step (`mcp-watchlist-list/create/add-to/delete/update-watchlist`, `mcp-tv-search-symbols`).

## The four watchlists
| Watchlist | Contents |
|---|---|
| **Alba Securities** | Verdict Strong (`buy`) or Good (`mbuy`) |
| **Alba - Green** | Strong/Good with MoS >= 0% |
| **Alba - Orange** | Strong/Good with -25% <= MoS < 0% |
| **Alba - Red** | Strong/Good with MoS < -25% |

The three MoS lists are subsets of the Strong/Good set, never computed over the full valuation universe (an earlier run did that and had to be corrected). TradingView's native colored/flagged lists are read-only through the connected tool (add/remove return 404; confirmed by direct testing); that is why the buckets are ordinary custom lists. The sync never touches other lists (colored lists, "Screener Peg" and so on).

## CRITICAL SAFETY RULE: never delete multiple watchlists in one parallel batch
A real incident: 3 parallel `mcp-watchlist-delete-watchlist` calls (each with a correct id) returned `delete_last` errors on all three yet deleted 5 lists, including two never targeted ("Alba Securities", "Screener Peg"). Deletion looks index-based under concurrency and the error text does not say what was deleted. The page therefore deletes one list at a time and re-lists after every delete. If you ever delete by hand: one delete per tool-call batch, re-list and confirm only the intended list is gone before the next, and stop at once if another list is missing.

## Why raw BSE codes fail (real bug)
A BSE-only stock was once mapped as `BSE:<raw numeric scrip code>` (e.g. `BSE:523411`), which TradingView shows as a bare red number with no name or logo. TradingView resolves BSE stocks by alpha ticker, like NSE: `523411` ("ADC India") is `BSE:ADCINDIA`. Never construct `BSE:<digits>`; use `stockMeta/bseAlpha` (255 entries after 2026-10-09), then search by company name. Cache every new mapping.

## Hyphen vs underscore and & in symbols (real bug)
On 2026-09-30 two stocks were added with the dashboard's hyphen: `NSE:KLBRENG-B` and `NSE:NAM-INDIA`; TradingView's real symbols use an underscore. Tickers with `&` keep it in TradingView (`NSE:J&KBANK`, `NSE:GVT&D` are accepted and present in the live lists). Never pass an unverified ticker with `-` or `&` straight through; verify per stock with `mcp-tv-search-symbols`. Confirmed so far (the page's `WL_CONFIRMED` must match this table):

| Dashboard ticker | Company | Correct symbol |
|---|---|---|
| `KLBRENG-B` | Kilburn Engineering Ltd | `NSE:KLBRENG_B` (also `BSE:KLBRENG_B`) |
| `NAM-INDIA` | Nippon Life India Asset Management Ltd | `NSE:NAM_INDIA` (also `BSE:NAM_INDIA`) |
| `J&KBANK` | Jammu & Kashmir Bank | `NSE:J&KBANK` |
| `GVT&D` | GE Vernova T&D India | `NSE:GVT&D` |

Other hyphenated tickers seen but not currently Strong/Good: `BAJAJ-AUTO` (probably correct as-is; confirm), `BOSCH-HCIL`, `MCCHRLS-B`, `UMIYA-MRO`.