// Applies saved research (stockResearch) on top of the base stock data.
import { stocks } from '../core/stocks.js';
import { applyFundamentalConfidence } from '../core/fundscore.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { renderAnalysisSection } from '../analysis/section.js';
import { setPeerGroupCache } from '../detail/peers.js';
import { rerenderDetail } from '../detail/render.js';

// ---- Research overlay (v1.8) ----
// Research results (Moat, Governance and any other Fundamental factor researched on demand) live in the
// shared database, collection `stockResearch`, one document per stock (id = sanitized ticker symbol),
// NOT in the stocks array. The stocks array stays the pure output of the CSV refresh pipelines, so a
// refresh can rewrite it freely and can never overwrite or lose a researched factor: on every load, and
// live whenever a document changes, the page re-applies each overlay on top of the base data and
// recomputes the score the same way the scoring engine does (verified to reproduce all 2,167 stored
// scores exactly). Document shape:
//   { ticker, asof, changeNote,
//     factors: { <key>: { score?, note?, metrics?: {<label>: <value>}, research: {asof, headline, summary,
//                          positives[], negatives[], sources[{title,url}]} } } }
// Deleting a document reverts that stock to its base (pipeline) values.
const researchOverlayApplied = new Map(); // docId -> stock
let stockByDocIdCache = null;
function stockByDocId(){
  if(!stockByDocIdCache) stockByDocIdCache = new Map(stocks.map(s => [sanitizeDocId(tickerSymbol(s)), s]));
  return stockByDocIdCache;
}
function recomputeFundamentals(s){
  applyFundamentalConfidence(s);
}
function snapshotBase(s){
  if(s.__researchBase) return;
  const m = s.fundamentals;
  s.__researchBase = {
    score: s.score, verdict: s.verdict, changeNote: s.changeNote,
    breakdown: m && m.scoringBreakdown ? { ...m.scoringBreakdown } : null,
    factors: m && Array.isArray(m.factors) ? m.factors.map(f => ({ key: f.key, score: f.score, note: f.note, research: f.research, metrics: f.metrics ? f.metrics.map(x => x.slice()) : f.metrics })) : []
  };
}
function revertResearch(s){
  const b = s.__researchBase;
  if(!b) return;
  delete s.__researchAsof;
  delete s.__fundSummary;
  delete s.__events;
  s.score = b.score; s.verdict = b.verdict;
  if(b.changeNote === undefined) delete s.changeNote; else s.changeNote = b.changeNote;
  const m = s.fundamentals;
  if(m){
    if(b.breakdown) m.scoringBreakdown = { ...b.breakdown };
    b.factors.forEach(bf => {
      const f = m.factors.find(x => x.key === bf.key);
      if(!f) return;
      f.score = bf.score;
      if(bf.note === undefined) delete f.note; else f.note = bf.note;
      if(bf.research === undefined) delete f.research; else f.research = bf.research;
      if(bf.metrics) f.metrics = bf.metrics.map(x => x.slice());
    });
  }
  applyFundamentalConfidence(s);   // marks the factors and rebuilds the score for the restored data
  delete s.__researchBase;
}
function applyResearchDoc(s, doc){
  snapshotBase(s);
  // Strengths / Watch-outs written by Refresh Fundamental Info (read by renderFundOverallSummary in rows.js).
  if(doc && doc.summary && typeof doc.summary === 'object') s.__fundSummary = doc.summary; else delete s.__fundSummary;
  // Dated events (news, results, corporate events) for the price-chart tags, saved by Refresh Fundamental Info.
  if(doc && Array.isArray(doc.events)) s.__events = doc.events; else delete s.__events;
  const m = s.fundamentals;
  if(!m || !Array.isArray(m.factors)) return;
  const fx = (doc && doc.factors) || {};
  Object.keys(fx).forEach(key => {
    const f = m.factors.find(x => x.key === key);
    const o = fx[key];
    if(!f || !o) return;
    if(typeof o.score === 'number' && Number.isFinite(o.score)) f.score = Math.max(0, Math.min(f.weight, o.score));
    if(typeof o.note === 'string') f.note = o.note;
    if(o.research && typeof o.research === 'object') f.research = o.research;
    if(o.metrics && typeof o.metrics === 'object' && Array.isArray(f.metrics)){
      f.metrics = f.metrics.map(([k, v]) => [k, Object.prototype.hasOwnProperty.call(o.metrics, k) ? o.metrics[k] : v]);
    }
  });
  recomputeFundamentals(s);
  if(typeof doc.changeNote === 'string' && doc.changeNote) s.changeNote = doc.changeNote;
  // Date the research was saved (for the Analysis "Researched" column): the doc's own asof, else the
  // newest per-factor research.asof.
  let ra = (doc && typeof doc.asof === 'string') ? doc.asof : null;
  if(!ra){
    Object.keys(fx).forEach(k => { const x = fx[k] && fx[k].research && fx[k].research.asof; if(typeof x === 'string' && (!ra || x > ra)) ra = x; });
  }
  if(ra) s.__researchAsof = ra; else delete s.__researchAsof;
}
// Re-applies every research document on top of the base data. Idempotent: each stock is first put
// back to its base values, so a changed or deleted document is always reflected exactly.
function applyResearchOverlay(docs){
  const index = stockByDocId();
  const next = new Map();
  docs.forEach(d => { const s = index.get(d.id); if(s) next.set(d.id, { s, data: d.data }); });
  let changed = false;
  for(const [id, s] of researchOverlayApplied){
    if(!next.has(id)){ revertResearch(s); changed = true; }
  }
  for(const [id, { s, data }] of next){
    revertResearch(s);
    applyResearchDoc(s, data);
    changed = true;
  }
  researchOverlayApplied.clear();
  for(const [id, { s }] of next) researchOverlayApplied.set(id, s);
  if(!changed) return;
  setPeerGroupCache(null);
  rerenderDetail();
  const analysisSectionEl = document.getElementById('section-analysis');
  if(analysisSectionEl && analysisSectionEl.classList.contains('active')) renderAnalysisSection();
}

export { applyResearchOverlay, stockByDocId };
