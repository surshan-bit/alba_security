// Applies saved updates (stockUpdates: price, technical, global) on top of the base stock data.
import { refreshAnalysisSoon } from '../analysis/section.js';
import { setPeerGroupCache } from '../detail/peers.js';
import { rerenderDetail } from '../detail/render.js';
import { paintFreshness } from '../joblogs/freshness.js';
import { mergedDoc } from './livesnapshot.js';
import { stockByDocId } from './research.js';

// ---- stockUpdates overlay (added 2026-10-07) ----
// Part B (technical block) and Part C (globalFactors) of a research run are saved as one document per
// stock in the collection stockUpdates (doc id = ticker, same as stockResearch), instead of being
// patched into this page, so a research run never has to read or republish the page. Shape:
// { ticker, asof, globalFactors?: {scope, asof, positive[], negative[]},
//   technical?: {score, reason, asof, states:{...}, raw:{...}} }.
// Applied on load on top of the stock list; a document wins only if its asof is the same as or
// newer than the stored block's asof, so a later page refresh that carries newer data is not
// hidden by an older document. Delete the document to revert that stock. Never touches
// pillars.val or valuation.
const updatesOverlayApplied = new Map(); // docId -> stock
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
function snapshotUpdBase(s){
  if(s.__updBase) return;
  s.__updBase = { globalFactors: clone(s.globalFactors), technical: clone(s.technical), currentPrice: s.valuation ? s.valuation.currentPrice : undefined };
}
function revertUpdates(s){
  const b = s.__updBase;
  if(!b) return;
  if(b.globalFactors === undefined) delete s.globalFactors; else s.globalFactors = clone(b.globalFactors);
  if(b.technical === undefined) delete s.technical; else s.technical = clone(b.technical);
  if(s.valuation){ if(b.currentPrice === undefined) delete s.valuation.currentPrice; else s.valuation.currentPrice = b.currentPrice; }
  delete s.__livePrice;
  delete s.liquidity;
  delete s.__updBase;
  delete s.__updAsof;
}
function applyUpdatesDoc(s, doc){
  snapshotUpdBase(s);
  const newer = (a, b) => typeof a === 'string' && (typeof b !== 'string' || a >= b);
  const g = doc && doc.globalFactors;
  if(g && typeof g === 'object' && (Array.isArray(g.positive) || Array.isArray(g.negative))){
    const bg = s.__updBase.globalFactors;
    if(newer(g.asof, bg && bg.asof)) s.globalFactors = clone(g);
  }
  // Live price from the Refresh Technical Info button: replaces valuation.currentPrice (Margin of Safety is always computed
  // from it and the CSV intrinsic value, so it follows). Skipped when the stored valuation carries a newer date of its own.
  const pv = doc && doc.valuation;
  if(pv && typeof pv === 'object' && typeof pv.currentPrice === 'number' && pv.currentPrice > 0 && s.valuation){
    const baseAsof = typeof s.valuation.asof === 'string' ? s.valuation.asof : (typeof s.valuation.priceAsof === 'string' ? s.valuation.priceAsof : null);
    if(newer(pv.asof, baseAsof)){
      s.valuation.currentPrice = pv.currentPrice;
      s.__livePrice = { asof: pv.asof || null, source: pv.source || '' };
    }
  }
  // Average daily volume (30 days) from the TradingView refresh: kept as its own block, so a strategy can skip thinly traded stocks.
  const lq = doc && doc.liquidity;
  if(lq && typeof lq === 'object' && typeof lq.avgVolume === 'number' && lq.avgVolume >= 0) s.liquidity = { avgVolume: lq.avgVolume, asof: lq.asof || null };
  const t = doc && doc.technical;
  if(t && typeof t === 'object'){
    const bt = s.__updBase.technical;
    if(newer(t.asof, bt && bt.asof)){
      const cur = s.technical ? clone(s.technical) : {};
      Object.keys(t).forEach(k => {
        if((k === 'states' || k === 'raw') && t[k] && typeof t[k] === 'object') cur[k] = Object.assign({}, cur[k] || {}, t[k]);
        else cur[k] = t[k];
      });
      s.technical = cur;
    }
  }
  const ua = doc && typeof doc.asof === 'string' ? doc.asof : null;
  if(ua) s.__updAsof = ua; else delete s.__updAsof;
}
let lastDocs = new Map();   // docId -> the stock's own saved update (stockUpdates)
let snapRows = new Map();   // docId -> { row, asof, at } from the newest liveSnapshot chunk that carries the stock
function applyUpdatesOverlay(docs){
  lastDocs = new Map(docs.map(d => [d.id, d.data]));
  rebuildOverlay();
}
// Chunk records of the live snapshot (collection liveSnapshot, see overlays/livesnapshot.js): one row per stock.
function applySnapshotOverlay(chunkDocs){
  const next = new Map();
  chunkDocs.forEach(d => {
    const c = d.data;
    if(!c || !Array.isArray(c.rows) || typeof c.asof !== 'string') return;
    const at = typeof c.at === 'string' ? c.at : null;
    c.rows.forEach(row => {
      if(!row || typeof row.k !== 'string' || !Array.isArray(row.c)) return;
      const old = next.get(row.k);
      if(old && (old.at || '') > (at || '')) return;
      next.set(row.k, { row, asof: c.asof, at });
    });
  });
  snapRows = next;
  rebuildOverlay();
}
function rebuildOverlay(){
  const index = stockByDocId();
  const next = new Map();
  const ids = new Set([...lastDocs.keys(), ...snapRows.keys()]);
  ids.forEach(id => {
    const s = index.get(id);
    if(!s) return;
    let data = lastDocs.get(id);
    try { data = mergedDoc(s, data, snapRows.get(id)); } catch(e){ console.error('Live snapshot row ' + id + ' could not be merged', e); }
    if(data) next.set(id, { s, data });
  });
  let changed = false;
  for(const [id, s] of updatesOverlayApplied){
    if(!next.has(id)){ revertUpdates(s); changed = true; }
  }
  for(const [id, { s, data }] of next){
    revertUpdates(s);
    // One odd document must never stop the others from being applied.
    try { applyUpdatesDoc(s, data); } catch(e){ console.error('Stock update ' + id + ' could not be applied', e); }
    changed = true;
  }
  updatesOverlayApplied.clear();
  for(const [id, { s }] of next) updatesOverlayApplied.set(id, s);
  if(!changed) return;
  setPeerGroupCache(null);
  rerenderDetail();
  paintFreshness();   // the Data Refresh age bars follow every saved update, not only the page load
  const analysisSectionEl = document.getElementById('section-analysis');
  if(analysisSectionEl && analysisSectionEl.classList.contains('active')) refreshAnalysisSoon();
}

export { applySnapshotOverlay, applyUpdatesOverlay };
