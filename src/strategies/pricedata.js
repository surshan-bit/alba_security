// All stocks' stored weekly and monthly bars, read in one go (about 1.5 MB) the first time a feature needs them
// (learning rules, judging tracked picks) and kept for the session. -> Map(symbol -> { w, m, fetchedAt }).
import { dbCapabilityPromise } from '../core/store.js';
import { stockByTickerSymbolAny } from '../core/stocks.js';
import { loadRecentBars } from '../prices/store.js';
import { withRecent } from '../prices/recent.js';

let cache = null;
async function loadPriceSet(force){
  if(cache && !force) return cache;
  const out = new Map();
  const db = await dbCapabilityPromise;
  if(db){
    await loadRecentBars(force);
    const snap = await db.collection('priceHistory').get();
    snap.docs.forEach(d => {
      if(!d.exists) return;
      const x = d.data();
      if(!x || !x.ticker || !Array.isArray(x.bars)) return;
      const e = out.get(x.ticker) || { w: null, m: null, fetchedAt: null };
      if(x.interval === '1W') e.w = x.bars; else if(x.interval === '1M') e.m = x.bars;
      if(x.fetchedAt && (!e.fetchedAt || x.fetchedAt > e.fetchedAt)) e.fetchedAt = x.fetchedAt;
      out.set(x.ticker, e);
    });
  }
  out.forEach((e, key) => { const s = stockByTickerSymbolAny.get(key); if(s && s.active === false) out.delete(key); });   // inactive stocks are left out of strategies
  out.forEach((e, key) => {   // the recent bars saved in chunks go on top of each stock's own documents
    const w = withRecent(key, { '1W': e.w, '1M': e.m }, e.fetchedAt);
    e.w = w.bars['1W']; e.m = w.bars['1M']; e.fetchedAt = w.fetched;
  });
  cache = out;
  return out;
}

export { loadPriceSet };
