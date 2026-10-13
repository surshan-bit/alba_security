// Research age and trigger status helpers (when a stock was last researched or its research requested).
import { daysSinceDate } from '../core/util.js';
import { renderAnalysisSection } from '../analysis/section.js';
import { ensurePriceBars, pcTickerKey } from '../prices/store.js';

// Days since a stock's research document (stockResearch overlay) was saved — null when the stock
// has never been researched. s.__researchAsof is set by applyResearchDoc and removed by
// revertResearch; it holds the doc's own asof date (YYYY-MM-DD), falling back to the newest
// per-factor research.asof inside the doc.
function stockResearchAsof(s){
  const a = s && s.__researchAsof, b = s && s.__updAsof;
  return a && b ? (a > b ? a : b) : (a || b || null);
}
function stockResearchAgeDays(s){
  const a = stockResearchAsof(s);
  if(!a) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a));
  if(!m) return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}
// ---- "Research triggered" tracking (2026-10-07) ----
// Every click of "Research this stock" (single) or the batch research button in Analysis stamps the
// time into the shared database (collection researchTriggers, doc id = ticker symbol), so the
// Analysis leaderboard can show when research was LAST TRIGGERED for each stock, even if the
// research has not been saved yet. Separate from "Researched", which is when findings were saved.
let researchTriggers = new Map(); // ticker symbol -> ISO time (or YYYY-MM-DD) of the last trigger
// What the last trigger asked for: 'price' = price history only (Part D, which writes ONLY to the priceHistory
// collection and never to stockResearch), 'full' = the research parts. Older trigger documents have no kind.
// Without this, a price-only job could never leave "awaiting save", because its completion signal is a
// priceHistory document, not a stockResearch one (fixed 2026-10-07).
let researchTriggerKinds = new Map();
const priceFetchedAt = new Map(); // dashboard ticker -> newest fetchedAt (ISO) across that stock's priceHistory documents
// Has the work that the last trigger asked for been saved since? Price-only jobs finish when a priceHistory
// document is fetched after the trigger; research jobs when a stockResearch document dated on/after the
// trigger day exists; legacy triggers (no kind) finish on either.
function researchTriggerDone(st, trigAt, kind){
  const dTrig = daysSinceDate(trigAt);
  if(dTrig === null) return false;
  const rd = stockResearchAgeDays(st);
  const researchDone = rd !== null && rd <= dTrig;
  const tMs = new Date(trigAt).getTime();
  const pf = priceFetchedAt.get(pcTickerKey(st));
  const priceDone = !!pf && !isNaN(tMs) && new Date(pf).getTime() > tMs;
  return kind === 'price' ? priceDone : (kind === 'full' ? researchDone : (researchDone || priceDone));
}
// Triggered-column cells need a stock's priceHistory fetch time; load those lazily and redraw once, after the batch.
let analysisPriceLoadTimer = null;
function analysisQueuePriceLoad(s){
  ensurePriceBars(s).then(() => {
    clearTimeout(analysisPriceLoadTimer);
    analysisPriceLoadTimer = setTimeout(() => {
      const el = document.getElementById('section-analysis');
      if(el && el.classList.contains('active')) renderAnalysisSection();
    }, 150);
  });
}

function getResearchTriggers(){ return researchTriggers; }
function getResearchTriggerKinds(){ return researchTriggerKinds; }
function setResearchTriggers(v){ researchTriggers = v; }
function setResearchTriggerKinds(v){ researchTriggerKinds = v; }

export { analysisQueuePriceLoad, getResearchTriggerKinds, getResearchTriggers, priceFetchedAt, researchTriggerDone, setResearchTriggerKinds, setResearchTriggers, stockResearchAgeDays, stockResearchAsof };
