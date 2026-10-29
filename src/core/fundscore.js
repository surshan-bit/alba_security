// Which Fundamental Score factors count, and the score built from them.
// Only information that can be relied on completely is scored: figures computed from the imported data, and
// Moat / Governance only once they carry researched findings with a cited source. A factor that is an estimate
// (the Moat and Governance peer-ranking proxies without sourced research) or has no data at all is shown as
// "not scored" and left out; the score, verdict and the block scores are then worked out over the factors that
// count, scaled to 10. A factor that does not apply to the company at all (na) is left out the same way, never as average. No imports, so it can be used from the start-up code as well as the overlays.
const PROXY_KEYS = new Set(['moat', 'gov']);
const CATEGORY_KEYS = { Traditional: 'traditionalSubscore', Buffett: 'buffettSubscore', Valuation: 'valuationSubscore' };
function hasSource(f){ const r = f && f.research; return !!(r && Array.isArray(r.sources) && r.sources.length); }
// v1.318: research with no news or filing link still counts when it rests on figures the refresh was given: it has written points, none of them is marked
// "not verified" (ok === false), and at least one rests on the CSV or TradingView data. Research made only of Claude's own view does not count.
function dataBacked(f){
  const r = f && f.research, pts = r && Array.isArray(r.points) ? r.points : [];
  if(!pts.length) return false;
  const objs = pts.filter(p => p && typeof p === 'object');
  return objs.length === pts.length && objs.every(p => p.ok !== false) && objs.some(p => Array.isArray(p.basis) && p.basis.some(b => b === 'csv' || /^tv-/.test(b)));
}
const researched = f => hasSource(f) || dataBacked(f);
// null when the factor counts, otherwise the reason it is left out.
function exclusionReason(f){
  if(!f) return 'no data';
  if(f.na) return 'it does not apply to ' + f.na;   // set by the import for a bank's or insurer's Financial Health
  if(PROXY_KEYS.has(f.key) && !researched(f)) return 'an estimate from peer rankings, not individually researched with a cited source';
  if(Array.isArray(f.metrics) && f.metrics.length && f.metrics.every(m => Array.isArray(m) && m[1] === 'n/a')) return 'no data available';
  // The import stores a factor it could not compute (missing input) as score 0. A real computed factor is never exactly 0
  // (percentile ranks are at least 100/n), so a 0 with no researched source means "no data": leave it out, do not count it as worst.
  if((typeof f.score !== 'number' || f.score === 0) && !researched(f)) return 'not enough data to score this factor';
  return null;
}
const r2 = x => Math.round(x * 100) / 100;
function bandOf(score){ return score >= 8 ? 'buy' : score >= 6 ? 'mbuy' : score >= 5 ? 'hold' : 'avoid'; }
// [factor, score] pairs that count. A factor with no data counts as neutral (half its weight) so missing data neither
// flatters nor sinks a stock; the Moat / Governance proxies stay out for every stock alike.
function countedPairs(factors){
  const ok = [];
  factors.forEach(f => {
    const why = exclusionReason(f);
    if(!why) ok.push([f, typeof f.score === 'number' ? f.score : 0]);
    else if(!f.na && !(PROXY_KEYS.has(f.key) && !researched(f))) ok.push([f, f.weight / 2]);   // a factor that does not apply is dropped, not counted as average
  });
  return ok;
}
// The score the factors add up to (what applyFundamentalConfidence stores); the data integrity check compares with it.
function expectedScore(factors){
  const ok = countedPairs(factors), w = ok.reduce((a, [f]) => a + f.weight, 0);
  return w > 0 ? r2(ok.reduce((a, [, v]) => a + v, 0) / w * 10) : null;
}
// Marks every factor (f.excluded = reason, or removed) and rewrites the stock's score, verdict and block scores.
function applyFundamentalConfidence(s){
  const m = s && s.fundamentals;
  if(!m || !Array.isArray(m.factors) || !m.factors.length) return;
  m.factors.forEach(f => { const why = exclusionReason(f); if(why) f.excluded = why; else delete f.excluded; });
  const ok = countedPairs(m.factors);
  const sub = {};
  Object.keys(CATEGORY_KEYS).forEach(cat => {
    const fs = ok.filter(([f]) => f.category === cat), w = fs.reduce((a, [f]) => a + f.weight, 0);
    sub[CATEGORY_KEYS[cat]] = w > 0 ? r2(fs.reduce((a, [, v]) => a + v, 0) / w * 10) : null;
  });
  const w = ok.reduce((a, [f]) => a + f.weight, 0);
  if(w <= 0) return;   // nothing can be relied on: leave the stored score as it was
  const score = r2(ok.reduce((a, [, v]) => a + v, 0) / w * 10);
  s.score = score; s.verdict = bandOf(score);
  m.scoringBreakdown = Object.assign({}, m.scoringBreakdown, sub, { overallComposite: score });
}
export { applyFundamentalConfidence, expectedScore, hasSource };
