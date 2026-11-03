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

## Run steps (what the scheduled tasks do)
Daily: copy `agent/*` and `liveSnapshot` to a work dir, check newest `asof` is within 4 days, run `python3 -I agent.py daily WORK [--nifty X]`, write back `state`, `picks`, `log`.
Weekly: also copy `stockData`, `barsRecent`; run `build` (expect 400-500 stocks, abort upload if < 300) then `weekly`; write back `compact`, `weights`, `learn`.

## Known issues
- `daily()` sets `asof` via `'asof' in dir()` and raises NameError if there are no liveSnapshot files; the task's freshness check normally prevents this.
- `daily` computes `ub` but never uses it.
- Stops/targets are checked on daily closes, so gaps fill worse than modelled.
- No benchmark series is charted even though `--nifty` is stored in the curve.

## Backtest (backtest.py)
`python3 agent/backtest.py DIR [--json out.json]` replays weekly bars (priceHistory `*_1W.json`) and compares exit/gate rule sets on identical entry signals. Latest output: `BACKTEST_RESULTS.txt`. Price/volume rules only; no fundamentals; survivorship bias; weekly bars (stop assumed first if both hit in one bar). Tests: `tests/test_backtest.py`.
