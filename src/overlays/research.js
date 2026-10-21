// Applies saved research (stockResearch) on top of the base stock data.
import { stocks } from '../core/stocks.js';
import { renderLoadedPart } from '../core/lazy.js';
import { applyFundamentalConfidence } from '../core/fundscore.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { refreshAnalysisSoon } from '../analysis/section.js';
import { redrawWhenIdle } from '../ui/scrollkeep.js';
import { setPeerGroupCache } from '../detail/peers.js';
import { rerenderDetail, setDetailOpenHook } from '../detail/render.js';
import { dbCapabilityPromise } from '../core/store.js';

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
let stockByDocIdCache = null, cacheFirst = null, cacheLast = null;
function stockByDocId(){
  // Rebuilt whenever the list changed in size or the first/last entry is a different object, so an overlay never lands on a stock that is no longer shown.
  const first = stocks[0], last = stocks[stocks.length - 1];
  if(!stockByDocIdCache || stockByDocIdCache.size !== stocks.length || cacheFirst !== first || cacheLast !== last){
    stockByDocIdCache = new Map(stocks.map(s => [sanitizeDocId(tickerSymbol(s)), s]));
    cacheFirst = first; cacheLast = last;
  }
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
// Redraws what shows research once documents were applied.
function afterResearchChange(){
  setPeerGroupCache(null);
  rerenderDetail();
  const analysisSectionEl = document.getElementById('section-analysis');
  if(analysisSectionEl && analysisSectionEl.classList.contains('active')) refreshAnalysisSoon();
  redrawStrategiesSoon();
}
// Re-applies every research document on top of the base data. Idempotent: each stock is first put
// back to its base values, so a changed or deleted document is always reflected exactly.
function applyResearchOverlay(docs){
  // The last research stays on screen until new research replaces it: a snapshot with no documents at all while some are showing is a
  // failed or cut-off read, not a request to delete every researched stock.
  if(!docs.length && researchOverlayApplied.size) return;
  liveSeen = true;
  saveResearchCache(docs);
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
  if(changed) afterResearchChange();
}
// Applies some documents without touching the stocks that are not named (the saved copy, or one document read on its own).
function applyResearchDocs(docs){
  const index = stockByDocId();
  let changed = false;
  docs.forEach(d => {
    const s = index.get(d.id);
    if(!s) return;
    revertResearch(s);
    applyResearchDoc(s, d.data);
    researchOverlayApplied.set(d.id, s);
    changed = true;
  });
  if(changed) afterResearchChange();
}

// ---- The last research is kept in this browser (IndexedDB) and shown at once on the next load, until the live read arrives ----
// The live read of the whole stockResearch collection is one large message; if it fails or is cut short the page still has the last
// research it saw. A stock opened without research also reads its own document directly.
const CACHE_DB = 'albaResearchCache', CACHE_STORE = 'kv', CACHE_KEY = 'docs';
let liveSeen = false, cacheTimer = null;
const askedAlone = new Set();
function cacheOpen(){
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(CACHE_DB, 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore(CACHE_STORE); } catch(e){ /* the cache is optional */ } };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch(e){ resolve(null); }
  });
}
async function readResearchCache(){
  const idb = await cacheOpen(); if(!idb) return [];
  return new Promise((resolve) => {
    try {
      const q = idb.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(CACHE_KEY);
      q.onsuccess = () => { try { const o = typeof q.result === 'string' ? JSON.parse(q.result) : null; resolve(o ? Object.keys(o).map(id => ({ id, data: o[id] })) : []); } catch(e){ resolve([]); } };
      q.onerror = () => resolve([]);
    } catch(e){ resolve([]); }
  });
}
function saveResearchCache(docs){
  if(cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    cacheTimer = null;
    let json; try { const o = {}; docs.forEach(d => { o[d.id] = d.data; }); json = JSON.stringify(o); } catch(e){ return; }
    const idb = await cacheOpen(); if(!idb) return;
    try {
      const tx = idb.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(json, CACHE_KEY);
      await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
    } catch(e){ /* the cache is optional */ }
  }, 3000);
}
// A stock opened while it has no research on screen: read its own document (small), once per stock.
async function ensureResearch(s){
  const id = sanitizeDocId(tickerSymbol(s));
  if(researchOverlayApplied.has(id) || askedAlone.has(id)) return;
  askedAlone.add(id);
  try {
    const db = await dbCapabilityPromise; if(!db) return;
    const snap = await db.doc('stockResearch/' + id).get();
    if(snap && snap.exists && !researchOverlayApplied.has(id)) applyResearchDocs([{ id, data: snap.data() }]);
  } catch(e){ askedAlone.delete(id); }
}
function init_overlays_research(){
  setDetailOpenHook(ensureResearch);
  readResearchCache().then(docs => { if(docs.length && !liveSeen) applyResearchDocs(docs); });
}
// The Strategies table shows "Research done" too: redraw it as saved research arrives, so it fills in while a refresh runs.
let strategiesRedrawTimer = null;
function redrawStrategiesSoon(){
  const sec = document.getElementById('section-strategies');
  if(!sec || !sec.classList.contains('active') || strategiesRedrawTimer) return;
  strategiesRedrawTimer = setTimeout(() => {
    strategiesRedrawTimer = null;
    const el = document.getElementById('section-strategies');
    try { if(el && el.classList.contains('active')) redrawWhenIdle('strategies', () => renderLoadedPart('strategies')); } catch(e){ /* repaints when opened again */ }
  }, 1200);
}

export { applyResearchOverlay, init_overlays_research, stockByDocId };
