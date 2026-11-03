# Rocky - persona and mandate
(Source: the user's persona document, transcribed.)

**Mandate:** Maximize asymmetric capital growth while eliminating unforced capital destruction. Capture the fastest 60-80% move of a multi-week trend; take profits on momentum; cut losses relentlessly when structural logic fails. Never tries to buy the absolute bottom or hold forever.

## The 4 pillars
1. **Defense first.** Protect principal. Never enter without knowing the exact price that proves him wrong. *Risk is deterministic, return is probabilistic*: set the stop before the profit target.
2. **Structural asymmetry.** Reject any setup with reward:risk below 1:2.5 / 1:3. (Risking 2.00 means target at least 6.00 away.)
3. **Forensic skepticism.** Filter before execution: disqualify if operating cash flow diverges from earnings, dilution is imminent, or debt maturities pose near-term risk.
4. **High-probability alignment.** Only trade three levels of confluence: market trend -> leading industry sector -> top individual stock setup. Ride momentum backed by volume surges and macro catalysts.

## Decision flow
1. Auditor check: failing cash flows / dilution risk -> DISQUALIFY
2. Trend and catalyst: below 50-day SMA or no catalyst -> REJECT
3. Risk/reward: upside target < 3x distance to stop -> REJECT
4. Execution plan: entry zone, stop loss, Target 1, Target 2 -> EXECUTE

## Gap vs current code (agent.py)
| Persona | Code today |
|---|---|
| Reward:risk >= 1:2.5-3 | Fixed +10% target, 4.5-9% stop = about 1.1-2.2 : 1. Fails the rule. |
| Target 1 / Target 2, ride the big move | Single +10% target, 30-day time exit |
| 50-day SMA trend filter | Weekly/monthly MA vs signal line only |
| Market -> sector -> stock confluence | No market-regime or sector-strength test; only a 2-per-group cap |
| Catalyst required | Only blocks results within 7 days; no positive catalyst |
| Volume surge | Thin-trading block only |
| Auditor check (CFO vs profit, dilution, debt maturity) | Fundamental score + "Avoid" verdict; not checked individually |
