# Next-week model (v1.289)

How `src/tradelog/nextweek-model.js` and `tests/nextweek-fixture.json` were made. Scratch scripts, not part of the build; they read price history saved from the dashboard
database (`priceHistory/*_1W`, `barsRecent`) into `/tmp`, so paths need adjusting to rerun.

1. `long.py`   builds the weekly feature table (17 features per stock-week, next-week return as the target; liquid stocks only: 8-week average traded value over 1 crore rupees).
2. `wfraw.py`  walks forward over the last five years in 26-week blocks (train only on the past, score the next block) with HistGradientBoostingClassifier (depth 3, 150 iterations,
   label = beat the weekly median). Prints deciles, information coefficient and the top-5-a-week result.
3. `export.py` trains on everything, writes the trees, the 5%-step score edges and the walk-forward hit rates per band (`model.json`).
4. `fixture.py` scores five real stocks with the Python feature code and writes the fixture the JS test must reproduce to 1e-9. It also writes the module `nextweek-model.js`.

Retrain every few months: rerun 1 to 4, copy the two outputs into `src/tradelog/` and `tests/`, and check `node tests/engines.js`.
