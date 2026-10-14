---
name: "fundamental-research-style"
description: "Use whenever writing or updating Fundamental Score research for the Alba Securities dashboard (factor cards, Strengths and Watch-outs, Global and Macro, Moat and Governance, research notes) so it is plain-language and bullet-first."
---

# Fundamental research writing style

Apply these two rules to every piece of Fundamental Score research, whether it is written in a Claude conversation, by a script, or by the dashboard itself.

## The two rules

1. **Business-user friendly, no jargon.** Write for a business owner who has never studied finance. Use everyday words and no abbreviations. If a figure helps, put it in brackets after the plain statement, for example "Cheaper than most peers (P/E 14.4)". If a technical term is truly unavoidable, explain it in a few words in brackets.
2. **Bullets, not paragraphs.** One idea per bullet, under 20 words, starting with the point itself. Never write a block of prose longer than two short sentences.

## Plain-word replacements

| Instead of | Write |
|---|---|
| ROCE, ROE | profit earned on the money invested in the business |
| D/E | debt compared with the owners' own money |
| Interest coverage | how easily profit pays the interest bill |
| OPM | profit margin on sales |
| Free cash flow | cash left after running costs and investments |
| P/E | price compared with yearly profit |
| Margin of safety | price below estimated fair value |
| Intrinsic value | estimated fair value |
| Moat | lasting advantage over competitors |
| MACD, RSI | momentum (rising, cooling, stretched, weak) |
| Promoter pledge | owners have borrowed against their shares |
| TTM | last 12 months |
| YoY | compared with a year earlier |

## Supporting habits

- Lead with what it means for the business or the investor, then the number.
- Say plainly when something could not be found or calculated. Never present a data gap as a strength. Mention it as a watch-out only when it limits how far the score can be trusted.
- No hype, no filler, no stacked hedges. Do not repeat a point in two places.
- Only cite sources that were actually read. Never invent a figure, date or web address.

## Where this applies in the dashboard

The fields below are stored per stock and shown on the stock detail screen:

- Factor card research: `headline` (one plain sentence), `points` (3 or 4 short bullets), `positives` and `negatives` (up to 4 short bullets each), `sources`. Do not write a `summary` paragraph; it is only read for older records.
- Strengths and Watch-outs box: up to 4 bullets each, one short sentence per bullet, with a tone of strong or good for strengths and caution or concern for watch-outs.
- Global and Macro Information: up to 5 positive and 5 negative short items, each with a source and, when it was actually read, its link.

The dashboard's own Refresh Fundamental Info button already carries these rules (the `LD_STYLE` text in `js/livedata.js`). If the rules here change, change that text too so the two stay in step.

## Quick check before saving

- Could a shop owner read every line without looking anything up?
- Is every block of text a bullet or at most two short sentences?
- Does any gap or missing figure appear as a strength? If so, move it or remove it.