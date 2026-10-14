---
name: "trade-log-tracking"
description: "Use whenever the user says they bought or sold a real position in a stock tracked on the \"Alba Securities - Stock Analyzer\" dashboard (artifact https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh) — e.g. \"I just bought 200 shares of TITAN at 3400 today\", \"I sold my GESHIP position at 1700\", \"close out my HDFCBANK position\". Logs the trade with a snapshot of what the model said at that moment so verdicts can be checked against real outcomes over time."
---

# Trade Log / Track Record tracking

The Alba Securities dashboard makes buy/sell/hold calls on ~1,950 stocks. This skill turns the
user's *real* trades into a running, honest scorecard for that model: every time they act on a
verdict, we snapshot what the dashboard said at that exact moment, and later, when they exit,
we snapshot what it says then too. None of this changes the dashboard's scoring; it only records
outcomes against it. The value comes from the accumulated record across many trades and verdict
buckets, not from any single trade; never treat one winning or losing position as proving or
disproving the model.

## Where trades live (changed 2026-10-09, dashboard v1.18): per user, private

The Trade Log is **personal**. Each signed-in user has their own trades in a private area of the
artifact database that nobody else can read, not even the artifact's owner:

- collection `data/users/<user id>/portfolio/trades`, one document per position, document id
  `<TICKER>-<buy date ISO>` (for example `GESHIP-2026-09-29`).
- With the `ArtifactData` tool write the signed-in person's own area as `data/users/me/portfolio/trades`
  (the tool resolves `me` to the id of the person this session works for). **You can only ever log
  trades for that person.** Never write a trade into another user's area, and never recreate the old
  shared `tradeLog` collection (retired; its one trade was moved to the owner's private area and the
  old document deleted).
- The dashboard's Track Record page reads exactly this path for whoever is viewing, so a trade written
  here shows up for that person with no HTML edit.

**Prefer the page for routine trades.** The Track Record page has "+ Add trade", "Sell" and "Remove"
buttons that look up the stock's score, verdict and data completeness themselves and save the
snapshot, with no Claude run. When the user says they bought or sold something, tell them they can log it
there in a few seconds; do it yourself when they ask you to, or for retroactive or bulk entries.
Only touch the page's code (js/csv.js and js/detail.js in the artifact's published files, not index.html)
if the user asks to change the schema, the panel's layout or the completeness-badge logic itself.

## The trade document schema

```jsonc
{
  "ticker": "GESHIP",          // bare symbol: stock.ticker.split('·')[0].trim()
  "name": "GE Shipping Co",    // stock.name, for display without a dashboard lookup
  "status": "open",            // "open" | "closed"
  "buy": {
    "date": "2026-09-29",      // ISO date the position was actually bought
    "price": 1549.89,          // actual fill price paid
    "quantity": 172,           // shares bought
    "snapshot": {
      "score": 6.64,                          // stock.score at the moment of buy
      "verdict": "mbuy",                      // stock.verdict: "buy"|"mbuy"|"hold"|"avoid"|"pending"
      "fundamentalFactorsComplete": 9,        // see "Data-completeness computation" below
      "fundamentalFactorsTotal": 9,
      "technicalComponentsComplete": 5,
      "technicalComponentsTotal": 5,
      "intrinsicValue": 2184.22,              // stock.valuation.intrinsicValue
      "currentPriceAtSnapshot": 1561,         // stock.valuation.currentPrice at buy time
      "marginOfSafetyPct": 28.53              // (intrinsicValue - currentPriceAtSnapshot) / intrinsicValue * 100
    }
  },
  "sell": null,                // null while open; filled in exactly once, on close
  "loggedAt": "2026-09-30T12:36:38.223Z"   // ISO timestamp this record was last written
}
```

On close, `sell` becomes:

```jsonc
"sell": {
  "date": "2027-01-15",
  "price": 1810.00,
  "quantity": 172,             // normally == buy.quantity; see "Partial closes" below if not
  "realizedReturnPct": 16.78,  // (sell.price - buy.price) / buy.price * 100
  "holdingDays": 108,          // integer days between buy.date and sell.date
  "snapshot": { /* same shape as buy.snapshot, computed at the moment of sale */ }
}
```

## Data-completeness computation

Both snapshots need `fundamentalFactorsComplete`/`Total` and `technicalComponentsComplete`/`Total`.
This must match the dashboard's own functions `fundamentalFactorIsComplete`, `fundamentalCompleteness`
and `technicalCompleteness` (in the artifact's published file `js/detail.js`) so the trade log's numbers
never disagree with what the dashboard itself shows for that stock.

**Fundamental**: a stock has 9 factors in `fundamentals.factors[]`
(`fin, prof, growth, val, moat, gov, predict, reinvest, dcf`). Each factor carries a `metrics`
array of `[label, value]` pairs. A factor counts as **complete** only if none of its metric values
is the literal string `"n/a"`, the exact fallback the scoring engine writes whenever an
underlying CSV input for that metric was missing. This is more reliable than scanning the
human-readable `note` field: some notes say "insufficient data" only when the *whole* factor is
unscoreable, but a partially scored factor (e.g. Earnings Predictability missing just its 5-year
figure) won't say that in its note even though one metric is genuinely missing. Checking `metrics`
catches both cases uniformly, including the two data-driven proxy factors (Moat, Governance) whose
notes never use the "insufficient data" phrase at all.
`fundamentalFactorsComplete` = count of complete factors; `fundamentalFactorsTotal` = 9.

**Technical**: a stock's `technical.states` object has 5 keys:
`monthMacd, weekMacd, monthRsi, weekRsi, valuation`. `technicalComponentsComplete` = count of keys
whose value is non-`null`; `technicalComponentsTotal` = 5. (`technical.reason` also names the
missing component(s) in prose, the same information but less convenient to parse.)

## Looking up the stock (no page read)

The stock list is in the database, never in the page. Do NOT read, grep or republish index.html for a
trade. For one ticker:

1. `ArtifactData` `get` on `stockMeta/main`; `index[<symbol>]` gives the chunk id (the symbol with every
   character outside `A-Za-z0-9_.~:@+-` replaced by `_`).
2. `ArtifactData` `get` on `stockData/<chunk id>` with `out_dir`, then pick the stock whose
   `ticker.split('·')[0].trim()` equals the symbol (a short script over the saved JSON).
3. Read its `score`, `verdict`, `fundamentals.factors`, `technical.states` and
   `valuation.intrinsicValue` / `valuation.currentPrice`.

## Logging a new buy

Ask the user only for what they actually know: **ticker, buy date, fill price, quantity**.
Everything else is looked up as above.

1. Look the stock up (previous section).
2. Compute the four completeness numbers per the section above, and
   `marginOfSafetyPct = (intrinsicValue - currentPriceAtSnapshot) / intrinsicValue * 100`.
3. Write the document with `ArtifactData` (`action: "set"`, `collection: "data/users/me/portfolio/trades"`,
   `doc_id: "<TICKER>-<buy date ISO>"`), `status: "open"`, the `buy` block as above, `sell: null`,
   and `loggedAt` = current ISO timestamp (use a time tool, don't guess the date). If a document with
   that id already exists, tell the user instead of overwriting it.
4. Read it back (`action: "get"`) to confirm the write landed with the right shape, and tell the
   user it's logged and will show on their Track Record page.

## Logging a sell / close

Ask the user for **ticker, sell date, fill price, quantity sold**.

1. Find the open record: `ArtifactData` `action: "query"`, `collection: "data/users/me/portfolio/trades"`,
   `where: [["ticker","eq","<TICKER>"], ["status","eq","open"]]`. If none exists, tell the user; don't
   fabricate a close for a position that was never logged as bought. Offer to log the buy retroactively
   if they want the full history captured, or just log a standalone closed trade if they'd rather not
   reconstruct the entry snapshot.
2. Look up the stock's *current* score/verdict/fundamentals/technical/valuation the same way as for a
   buy, to build `sell.snapshot`.
3. Compute `realizedReturnPct = (sell.price - buy.price) / buy.price * 100` and `holdingDays` as
   the integer number of days between `buy.date` and `sell.date`.
4. Update the document (`ArtifactData` `action: "update"`, pinned with the `if_version` from your
   read in step 1) setting `status: "closed"`, the full `sell` object, and a refreshed `loggedAt`.
5. Read it back to confirm, and tell the user the realized return.

### Partial closes

If the sell quantity is less than the position's `buy.quantity`, ask the user whether this is a
partial exit or the whole position (people don't always say "sold half"). There's no established
convention yet for a partial close in this schema; use judgment: the simplest approach is to
leave the original document `open` with a note of what was partially sold (e.g. add a
non-schema `partialSells: [...]` array) rather than closing it outright, since `status: "closed"`
should mean the position is fully gone. Flag this choice to the user rather than silently picking
one, since it hasn't come up in practice yet and future sessions should stay consistent with
whatever gets decided first.

## Why this matters

Nothing here should ever imply that one trade's outcome validates or invalidates the dashboard's
model; a single GESHIP trade going up or down 10% is noise, not signal. The point of this skill is
purely mechanical: capture the entry and exit conditions faithfully and consistently, trade after
trade, so that once there are enough closed positions the dashboard's own aggregate (average
return by entry-verdict bucket, already computed by `renderTradeLogPanel()` once 2+ trades exist)
starts to say something real about whether "Strong" beats "Good" beats "Hold" in practice.