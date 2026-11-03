# Rocky (paper trading)

Persona and mandate: see PERSONA.md.

Rocky is the paper-trading swing agent on the Alba dashboard's Positive MoS list. No real orders, ever.

| File | What |
|---|---|
| `agent.py` | All decision logic: `build`, `daily`, `weekly` modes. Exported verbatim from the db doc `agent/code.json` (key `py`). |
| `dashboard.html` | The read-only page published at https://claude.ai/artifact/V5LDfJsKmyg2ZvD897ggP2 (reads db collection `agent`). |
| `tests/test_agent.py` | Unit tests: exits, entries/sizing, risk blocks, group cap, learning gate. |
| `make_code_doc.py` | Builds `code.json` from `agent.py` for upload. |

## Test
    python3 -m unittest discover -s agent/tests

## Deploy a change
The scheduled tasks ("Alba Agent Daily Run", Mon-Fri 17:00 IST; "Alba Agent Weekly Audit", Fri 18:00 IST) load the code from the agent artifact's db, so git is the source and the db is the deploy target.
1. Edit `agent.py`, run the tests, commit.
2. `python3 agent/make_code_doc.py /tmp/code.json`
3. ArtifactData `set` on url `https://claude.ai/artifact/V5LDfJsKmyg2ZvD897ggP2`, collection `agent`, doc_id `code`, file_path `/tmp/code.json`, `if_version` = current version (read it first).
4. Dashboard changes: edit `dashboard.html`, republish it to the same artifact URL.

## Data (stays in the artifact dbs)
- Agent db (`agent/`): `state`, `picks`, `weights`, `learn`, `log`, `compact`, `code`.
- Dashboard db (read-only for the agent): `stockData`, `liveSnapshot`, `barsRecent`.

## Rocky page in the dashboard
The dashboard (Alba Securities v1.346+) has a **Rocky** menu item. It only reads the dashboard database collection `rocky` (docs `state`, `picks`, `weights`, `learn`, `log`), which is a copy of the agent's own docs. The scheduled runs write that copy as their step 7 (daily: state, picks, log; weekly: weights, learn); they may write only the `rocky` collection of the dashboard. Source: `src/rocky/`, `src/sections/rocky.js`, `styles/rocky.css` in the dashboard repo.

## Run steps (what the scheduled tasks do)
Daily: copy `agent/*` and `liveSnapshot` to a work dir, check newest `asof` is within 4 days, run `python3 -I agent.py daily WORK [--nifty X]`, write back `state`, `picks`, `log`, then copy the same three to the dashboard's `rocky` collection.
Weekly: also copy `stockData`, `barsRecent`; run `build` (expect 400-500 stocks, abort upload if < 300) then `weekly`; write back `compact`, `weights`, `learn`, then copy `weights` and `learn` to the dashboard's `rocky` collection.

## Known issues
- `daily()` sets `asof` via `'asof' in dir()` and raises NameError if there are no liveSnapshot files; the task's freshness check normally prevents this.
- `daily` computes `ub` but never uses it.
- Stops/targets are checked on daily closes, so gaps fill worse than modelled.
- No benchmark series is charted even though `--nifty` is stored in the curve.

## Backtest (backtest.py)
`python3 agent/backtest.py DIR [--json out.json]` replays weekly bars (priceHistory `*_1W.json`) and compares exit/gate rule sets on identical entry signals. Latest output: `BACKTEST_RESULTS.txt`. Price/volume rules only; no fundamentals; survivorship bias; weekly bars (stop assumed first if both hit in one bar). Tests: `tests/test_backtest.py`.

## Findings so far (see GRID_RESULTS.txt, ROBUSTNESS_RESULTS.txt; one ~4-year regime, price rules only)
- Ranking is noisy: the same rule gave +6% or +71% total return after a one-week change in the ranking formula. With random ordering of valid candidates the spread for one rule is about -10% to +58%. Don't trust any single run.
- The 1:3 reward:risk target with a headroom gate, combined with the market-breadth filter (share of stocks with a positive 4-week return >= 50-60%), was positive in 8 of 8 random orderings (median +30% to +44%), with lower drawdowns. The fixed +10% target was mixed (5-7 of 8 positive).
- Breakout-on-volume and relative-strength entries were no better than the base entry (trend + RSI + momentum + near highs); the pullback entry had too few trades.
- Everything still trails an equal-weight buy-and-hold of the same stocks (+192%) in this small-cap bull window. Treat as "less bad", not "proven edge".
- Live: `REGIME_MIN = 0.6` in agent.py (no new entries when fewer than 60% of the scored universe is up over 1 month; exits still run).

## 1:3 gate (live)
`trade_plan()` in agent.py: stop = ATR-based 4.5-9%, target = entry + 3 x risk, accepted only if the 40-week high (compact `hi`) >= target or entry is within 3% of that high; no high on record -> rejected. Rejected stocks are listed in picks.json `gated` and on the dashboard. New positions carry `maxd` = 70 days; positions opened before the gate keep the old +10% target and 30-day limit.

## Entry filters (live since the 6th version of the agent code)
`entry_blocks()` in agent.py blocks a stock unless: price is above a **rising 10-week average** (`ma10`, `ma10p` in compact.json, from the weekly bars), **weekly RSI is 45-75**, the **1-month change is positive**, and price is **within 15% of the 40-week high**. Missing data blocks the stock. Backtest (`backtest.py`, 8 random orderings, 1:3 gate + regime filter): hard entry filters beat a liquidity-only entry (profit factor 1.39 vs 1.19, 8/8 vs 7/8 seeds positive, median +44% vs +23%); a nearer-resistance check did not help and was not added. Results are noisy; one regime of about 4 years.
Needs the weekly run to have rebuilt compact.json (until then every stock is blocked as 'No trend data').

## High-risk tier (monthly RSI above 70)
`risk_tier()` in agent.py: a stock whose monthly RSI (live column 6) is **above 70, or unknown**, is tiered `high`; others are `standard`. High-risk positions risk **0.5%** of equity per trade (standard: 1%) and the position-size cap is halved too (6.25% of equity instead of 12.5%). `tier`, `risk` and `mrsi` are stored on each picked stock and each new position; positions opened earlier carry no tier and count as standard.
Why (backtest, 3 weeks after entry, weekly signals): reached +10% in 38% of cases at monthly RSI 70-80 (27% below 50), but were down 7% at some point in 50% (36% below 50); the median trade is about flat, the extra return comes from a few big winners. Note: the daily universe (compact) only holds stocks with a monthly RSI of 30-80 at build time. In practice the 12.5% position cap, not the 1% risk limit, binds for stops under about 8%, so standard positions often risk 0.6-0.9%.
