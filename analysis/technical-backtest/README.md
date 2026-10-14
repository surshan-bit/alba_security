# Technical-score back-test (2026-10-14, app v1.171)

Question: does the technical score, as it would have read at a past date, line up with the stock's later return?

## How it was run
1. `node generate-rows.js` (run from this folder, with `npm ci` done in the repo root). For every stock in the price backup
   (`alba_security_data/db/priceHistory`, `*_1W` weekly + `*_1M` monthly bars) and every week from bar 40 on, it calls the app's own
   `computeTechnical` (`src/engine/technical.js`) using **only bars available at that date** (the still-forming last weekly bar is dropped;
   only *completed* monthly bars are used). The valuation component is left out (no history), so the score is rescaled over
   the MACD/RSI parts. Output: `rows.json` (not committed; regenerate it).
2. `python3 analyze.py` (numpy, pandas, scipy). Per date it takes the rank correlation (Spearman IC) between score and the stock's
   return over the next 4 / 13 / 26 weeks, for dates with at least 20 stocks, and compares it with plain 13-week momentum.

## Result (141 stocks, weekly, 2022-07 to 2026-04, 195 dates)
| Horizon | Technical score IC | 13-week momentum IC | Reading |
|---|---|---|---|
| 4 weeks | -0.013 | -0.005 | nothing |
| 13 weeks | +0.025 (positive on 69% of dates) | +0.027 | weak |
| 26 weeks | +0.056 (positive on 76% of dates, ~1.9 s.e. after overlap adjustment) | +0.056 | weak, borderline |

Quintile excess return over 26 weeks, lowest to highest score: -4.3%, +1.8%, -1.4%, +1.1%, +2.7% (not monotonic).
Mean 26-week return by band: 0-3 16.7%, 3-5 13.6%, 5-7 16.6%, 7-10 19.6%. First and second half of the period agree.
**The score adds nothing measurable beyond simple momentum.**

## Caveats
- The 141 stocks are the ones on the dashboard today (chosen with hindsight; survivors and Growth List picks).
- One market regime, about four years; trading costs ignored.
- Windows overlap; the adjustment (effective n = dates / horizon) is rough, not a proper significance test.
- Valuation pillar and the **fundamental score are not tested**: no score history exists for them. See the note on score history in the repo's
  release skill / the follow-up that records scores at every import.
