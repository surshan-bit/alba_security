// Which Fundamental Score factors count, and the score built from them.
// Only information that can be relied on completely is scored: figures computed from the imported data, and
// Moat / Governance only once they carry researched findings with a cited source. A factor that is an estimate
// (the Moat and Governance peer-ranking proxies without sourced research) or has no data at all is shown as
// "not scored" and left out; the score, verdict and the block scores are then worked out over the factors that
// count, scaled to 10. No imports, so it can be used from the start-up code as well as the overlays.
const PROXY_KEYS = new Set(['moat', 'gov']);
const CATEGORY_KEYS = { Traditional: 'traditionalSubscore', Buffett: 'buffettSubscore', Valuation: 'valuationSubscore' };
function hasSource(f){ const r = f && f.research; return !!(r && Array.isArray(r.sources) && r.sources.length); }
// null when the factor counts, otherwise the reason it is left out.
function exclusionReason(f){
  if(!f) return 'no data';
  if(PROXY_KEYS.has(f.key) && !hasSource(f)) return 'an estimate from peer rankings, not individually researched with a cited source';
  if(Array.isArray(f.metrics) && f.metrics.length && f.metrics.every(m => Array.isArray(m) && m[1] === 'n/a')) return 'no data available';
  // The import stores a factor it could not compute (missing input) as score 0. A real computed factor is never exactly 0
  // (percentile ranks are at least 100/n), so a 0 with no researched source means "no data": leave it out, do not count it as worst.
  if((typeof f.score !== 'number' || f.score === 0) && !hasSource(f)) return 'not enough data to score this factor';
  return null;
}
const r2 = x => Math.round(x * 100) / 100;
function bandOf(score){ return score >= 8 ? 'buy' : score >= 6 ? 'mbuy' : score >= 5 ? 'hold' : 'avoid'; }
// Marks every factor (f.excluded = reason, or removed) and rewrites the stock's score, verdict and block scores.
function applyFundamentalConfidence(s){
  const m = s && s.fundamentals;
  if(!m || !Array.isArray(m.factors) || !m.factors.length) return;
  const ok = [];
  m.factors.forEach(f => {
    const why = exclusionReason(f);
    if(why) f.excluded = why; else { delete f.excluded; ok.push(f); }
  });
  const num = f => (typeof f.score === 'number' ? f.score : 0);
  const sub = {};
  Object.keys(CATEGORY_KEYS).forEach(cat => {
    const fs = ok.filter(f => f.category === cat), w = fs.reduce((a, f) => a + f.weight, 0);
    sub[CATEGORY_KEYS[cat]] = w > 0 ? r2(fs.reduce((a, f) => a + num(f), 0) / w * 10) : null;
  });
  const w = ok.reduce((a, f) => a + f.weight, 0);
  if(w <= 0) return;   // nothing can be relied on: leave the stored score as it was
  const score = r2(ok.reduce((a, f) => a + num(f), 0) / w * 10);
  s.score = score; s.verdict = bandOf(score);
  m.scoringBreakdown = Object.assign({}, m.scoringBreakdown, sub, { overallComposite: score });
}
export { applyFundamentalConfidence, hasSource };
