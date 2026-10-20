// Recent bars in chunks (v1.208). Refresh all stocks used to rewrite each stock's two priceHistory documents (about 30 KB) for one new bar, which
// is about 2,000 saves a week and the slowest part of a run (the database takes only a few saves a second). Now the newest weekly and monthly bars of
// every stock are saved in a few records, 50 stocks each, in the collection barsRecent:
//   barsRecent/<c001...> = { v: 1, at: ISO time, rows: [ { k, y, w: [ ...last weekly bars ], m: [ ...last monthly bars ] }, ... ] }
//   k = the stock's ticker key, y = its TradingView symbol, bars are [t,o,h,l,c,v].
// The page lays these rows on top of each stock's own priceHistory documents when it loads the bars (store.js): the stock's own bars before the first
// recent bar, then the recent bars. A stock's own documents are only rewritten now and then (compaction) and whenever the stock is refreshed on its own;
// a recent row older than those documents is ignored, so a newer full save always wins.
import { weekBucket, monthBucket } from '../refresh/historyplan.js';

const KEEP_W = 40, KEEP_M = 12;   // bars kept per stock in the chunks
const COMPACT_LAG = 6;            // a stock whose own documents are this many weekly bars behind is written in full again (a limited number per run)
const recentByKey = new Map();    // ticker key -> { at: ms, w, m } from the chunks
const fullLast = new Map();       // ticker key -> { w, m }: the newest bar time in the stock's own priceHistory documents

// The stock's own bars with the recent bars laid on top: everything before the first recent bar is the stock's own.
function mergeRecent(full, recent, bucket){
  if(!Array.isArray(full) || !full.length || !Array.isArray(recent) || !recent.length) return full;
  const first = bucket(recent[0][0]);
  return full.filter(b => bucket(b[0]) < first).concat(recent);
}
// What the page should use for one stock: its own bars (`bars` = { '1W', '1M' }, saved at `fetchedAt`) plus the recent rows when those are newer.
function withRecent(key, bars, fetchedAt){
  const w0 = bars['1W'], m0 = bars['1M'];
  if(w0 && w0.length) fullLast.set(key, { w: w0[w0.length - 1][0], m: m0 && m0.length ? m0[m0.length - 1][0] : null });
  const r = recentByKey.get(key);
  if(!r || !w0 || !w0.length || !(r.at > (Date.parse(fetchedAt) || 0))) return { bars, fetched: fetchedAt };
  const out = Object.assign({}, bars, { '1W': mergeRecent(w0, r.w, weekBucket) });
  if(m0 && m0.length) out['1M'] = mergeRecent(m0, r.m, monthBucket);
  return { bars: out, fetched: new Date(r.at).toISOString() };
}
// The chunk rows read from the database (docs = [{ id, data }]).
function setRecentFromDocs(docs){
  recentByKey.clear();
  docs.forEach(d => {
    const c = d.data, at = c && Date.parse(c.at);
    if(!c || !Array.isArray(c.rows) || !at) return;
    c.rows.forEach(r => {
      if(!r || typeof r.k !== 'string' || !Array.isArray(r.w)) return;
      const old = recentByKey.get(r.k);
      if(!old || old.at < at) recentByKey.set(r.k, { at, w: r.w, m: Array.isArray(r.m) ? r.m : [] });
    });
  });
}
// One stock's recent weekly and monthly bars (by ticker key), or null when the chunks hold none.
function recentBarsOf(key){ const r = recentByKey.get(key); return r ? { w: r.w, m: r.m } : null; }
function noteRecentSaved(key, at, W, M){ recentByKey.set(key, { at, w: W.slice(-KEEP_W), m: M.slice(-KEEP_M) }); }
// A stock's own document of one kind ('1W' or '1M') now holds these bars.
function noteFullSaved(key, iv, rows){
  const f = fullLast.get(key) || { w: null, m: null };
  f[iv === '1W' ? 'w' : 'm'] = rows[rows.length - 1][0];
  fullLast.set(key, f);
}
// How many weekly bars the stock has beyond what its own documents hold (the compaction measure).
function lagOf(key, W){
  const f = fullLast.get(key);
  return f && W && W.length ? W.filter(b => b[0] > f.w).length : 0;
}
const recentRow = (key, sym, W, M) => ({ k: key, y: sym || null, w: W.slice(-KEEP_W), m: M.slice(-KEEP_M) });

export { COMPACT_LAG, lagOf, noteFullSaved, noteRecentSaved, recentBarsOf, recentRow, setRecentFromDocs, withRecent };
