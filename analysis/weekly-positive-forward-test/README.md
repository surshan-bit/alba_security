# Weekly Positive: forward test and success bar (fixed 2026-10-15, before any result)

Question: do the **fundamental and margin-of-safety rules** of the Weekly Positive strategy add anything beyond its price rules?

## Set-up
- **Strategy under test:** `Weekly Positive`. Rules: W Tech Rating bullish (or none), MoS rating green, Fundamental score >= 5.5,
  Technical score >= 5.5, weekly change >= 1 %. Goal: +5 % within 30 days.
- **Control:** `Weekly Positive (price rules only)`. Same rules without the Fundamental score and MoS rating rules.
- **Run on 2026-10-15** with "Track these picks" (Strategies screen): Weekly Positive = 50 picks. Track the control on the same day.
- **Repeat every Thursday for 8 weeks** (both strategies, same day), so about 400 picks accumulate. A single 50-pick run can be off by about 7 points
  in hit rate through chance alone.
- First look at 2026-11-14 (first runs complete) is for information only. The decision is made once at least 6 weekly runs have completed their 30 days.

## Success bar (all four must hold, pooled over all completed runs)
1. **Hit rate:** share of picks that reached +5 % within 30 days is at least **5 points higher** than the control's.
2. **Return:** average 30-day return (latest price at day 30 against entry price, minus 0.4 % round-trip cost) is at least **1 point higher** than the control's.
3. **Downside:** share of picks that are down 10 % or more at day 30 is **no more than 2 points higher** than the control's.
4. **Consistency:** Weekly Positive's hit rate beats the control's in at least **2 of every 3** completed weekly runs.

Anything less means the fundamental rules are **unproven** and the strategy should be simplified or rethought. Passing means "worth continuing to track",
not proof, and not advice to invest.

## What the price rules alone showed in a back-test (2026-10-15)
135 stocks, weekly, +5 % reached within 4 weekly bars (~30 days), valuation left out (it cannot be replayed):

| Group | Reached +5 % | Avg 4-week return | Fell 10 %+ |
|---|---|---|---|
| Price rules passed (1,585 cases) | 66.5 % | +1.6 % | 18.0 % |
| All stocks, any week | 65.8 % | +0.9 % | 15.9 % |
| Weekly gain >= 1 % only | 65.7 % | +1.2 % | 16.2 % |

The price rules add no measurable edge over the base rate. This agrees with `analysis/technical-backtest` (the Technical score adds nothing beyond simple momentum).

## Known weaknesses
- Only today's stocks are tested (survivors); only about two years of full indicator history; one market regime.
- Weekly highs overstate how often a +5 % move could actually be captured; 66 % of random small-cap stock-weeks reach it, so the goal alone is a low bar.
- The tracked picks of consecutive weeks overlap in stocks, so runs are not fully independent.
