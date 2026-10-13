// All stocks' stored weekly and monthly bars, read in one go (about 1.5 MB) the first time a feature needs them
// (learning rules, judging tracked picks) and kept for the session. -> Map(symbol -> { w, m, fetchedAt }).
import { dbCapabilityPromise } from '../core/store.js';

let cache = null;
async function loadPriceSet(force){
  if(cache && !force) return cache;
  const out = new Map();
  const db = await dbCapabilityPromise;
  if(db){
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
  cache = out;
  return out;
}

export { loadPriceSet };
