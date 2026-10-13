// How complete a stock's fundamental and technical data is (badges).
import { FUND_METRIC_LABEL } from './fundmetrics.js';

// ---- Data-completeness ("confidence") computation (added 2026-09-30) ----
// A factor counts as complete only if none of its underlying CSV-sourced metrics were missing
// when scored. The scoring engine (scoring_engine.js) always fills a missing metric's displayed
// value with the literal string "n/a" in that factor's `metrics` array (see pushFactor()) —
// checking for that literal is more precise than pattern-matching the human-readable `note` text
// (which only some factors phrase as "insufficient data"), and it works identically across all
// 9 factors including the Moat/Governance data-driven proxies, whose notes never use that phrase
// even when their own percentile input is missing.
function fundamentalFactorIsComplete(f){
  if(!f) return true;
  if(!Array.isArray(f.metrics)) return !f.excluded;
  return !f.excluded && !f.metrics.some(m => Array.isArray(m) && m[1] === 'n/a');
}
function fundMissingMetrics(f){
  return (f.metrics || []).filter(m => Array.isArray(m) && m[1] === 'n/a').map(m => FUND_METRIC_LABEL[m[0]] || m[0]);
}
function fundamentalCompleteness(s){
  const factors = (s.fundamentals && Array.isArray(s.fundamentals.factors)) ? s.fundamentals.factors : [];
  const total = 9; // the fixed 9-factor model (see fundamentals.model)
  const complete = factors.filter(fundamentalFactorIsComplete).length;
  // Named so the "5/9 factors" badge's tooltip can say WHICH 4 are incomplete, not just the
  // count — added 2026-10-06 after being asked how to tell which factors are missing data
  // without opening every card.
  const incompleteNames = factors.filter(f => !fundamentalFactorIsComplete(f) && !f.excluded).map(f => f.name);
  const excludedNames = factors.filter(f => f.excluded).map(f => f.name);
  // Factors that still have gaps AFTER being individually researched: the figures were looked for
  // and genuinely don't exist (for example no multi-year history), so they are not "still to do".
  const researchedGapNames = factors.filter(f => !fundamentalFactorIsComplete(f) && f.research).map(f => f.name);
  return {complete, total, incompleteNames, researchedGapNames, excludedNames};
}
// The 5 technical components the composite score is built from. A component TradingView's own
// export didn't have enough history for is stored as `null` on technical.states (see
// technical.reason, which names the same missing component(s) in prose) — counting non-null
// states directly is equivalent to parsing that reason text but doesn't depend on its wording.
const TECH_STATE_KEYS = ['monthMacd','weekMacd','monthRsi','weekRsi','valuation'];
function technicalCompleteness(s){
  const total = TECH_STATE_KEYS.length;
  const st = s.technical && s.technical.states;
  if(!st) return {complete:0, total};
  const complete = TECH_STATE_KEYS.filter(k => st[k] != null).length;
  return {complete, total};
}
function completenessBadge(c, unitLabel){
  const cls = c.complete === c.total ? 'complete' : 'incomplete';
  const rg = c.researchedGapNames || [];
  const open = (c.incompleteNames || []).filter(n => !rg.includes(n));
  const ex = c.excludedNames || [];
  const detail = (ex.length ? ` — not scored (not 100% reliable): ${ex.join(', ')}` : '')
    + (open.length ? ` — missing data in: ${open.join(', ')}` : '')
    + (rg.length ? ` — researched, but the figures are not available (see each factor's card): ${rg.join(', ')}` : '');
  const extra = rg.length ? ` · ${rg.length} researched, data unavailable` : '';
  return `<span class="completeness-badge ${cls}" title="${c.complete} of ${c.total} ${unitLabel} had usable underlying data in the latest refresh${detail}">${c.complete}/${c.total} ${unitLabel}${extra}</span>`;
}

export { completenessBadge, fundMissingMetrics, fundamentalCompleteness, technicalCompleteness };
