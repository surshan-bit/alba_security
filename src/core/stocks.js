// The stock list and the lookups built from it once at start-up.
import { tickerSymbol } from './util.js';
import { getBootStocks } from '../boot/handoff.js';
import { applyFundamentalConfidence } from './fundscore.js';

const stocks = getBootStocks().slice();
stocks.forEach(applyFundamentalConfidence);   // the score counts only information that can be relied on completely
stocks.sort((a,b)=>b.score-a.score);
// Strings identical for every stock live here once instead of 2,167 times in the data line
// (cuts ~3.4 MB of script to parse). A per-stock value, if present, always wins.
const FUND_MODEL_TEXT = "9-factor model v3 (Traditional + Buffett + Valuation). Mechanical factors computed directly from the uploaded screener.in-style fundamentals CSV (44-column schema), now incorporating Altman Z Score, Current Ratio, multi-year ROE/ROCE averages, free/operating cash flow support, CROIC, institutional (FII/DII) holding change, and 5-year historical P/E alongside the original fields. Moat & Governance use a data-driven mechanical proxy (industry-relative percentile ranking) pending individual research. Contingent Liabilities, Graham Number and NCAVPS are shown as informational cross-checks and are not part of the score.";
const FUND_NOTE_TEXT = "9-factor model v3: mechanical factors (Financial Health, Profitability, Growth, Valuation, Earnings Predictability, Capital Reinvestment Efficiency, Margin of Safety) computed from screener.in-style fundamentals data, now including Altman Z Score, Current Ratio, average debtor days, multi-year ROE/ROCE blends, free/operating cash-flow support checks, CROIC (replacing ROIC where available), FII/DII holding-change, and 5-year historical P/E. Financial Health, Profitability, Growth, Valuation and Reinvestment rank each stock against its exact peers — the same Industry Group and the same industry (falling back to the wider Industry Group, then to all stocks, when fewer than 10 peers have data); Margin of Safety is always ranked against the full population. Moat & Governance use a data-driven mechanical proxy pending individual research. Contingent Liabilities, Graham Number and NCAVPS are shown for context but are not scored.";
for(const s of stocks){ const fx = s.fundamentals; if(!fx) continue;
  if(!fx.model) fx.model = FUND_MODEL_TEXT;
  if(fx.scoringBreakdown && !fx.scoringBreakdown.note) fx.scoringBreakdown.note = FUND_NOTE_TEXT; }

const verdictLabel = {buy:"Strong", mbuy:"Good", hold:"Hold", avoid:"Avoid", pending:"Pending Research"};

// Precomputed once so row rendering never needs an O(n) stocks.indexOf() scan.
const stockIndex = new Map(stocks.map((s, i) => [s, i]));

// Precomputed once so looking a stock up by its ticker symbol (e.g. resolving a bulk-refresh
// selection) is O(1) instead of an O(n) stocks.find() per ticker.
const stockByTickerSymbol = new Map(stocks.map(s => [tickerSymbol(s), s]));

export { stockByTickerSymbol, stockIndex, stocks, verdictLabel };
