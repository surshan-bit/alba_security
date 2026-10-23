// Price history cache: lazy per-stock loading from the database.
import { stocks } from '../core/stocks.js';
import { tickerKey } from '../core/util.js';
import { dbCapabilityPromise } from '../core/store.js';
import { priceFetchedAt } from '../research/status.js';
import { getShownIndex, renderDetail } from '../detail/render.js';
import { setRecentFromDocs, withRecent } from './recent.js';

// ---- Price history chart (experimental, OCCL only for now) ----
// Weekly / Monthly candlesticks + volume from the shared database collection `priceHistory`
// (one document per symbol and timeframe, id e.g. NSE_OCCLLTD_1D, bars as [t,o,h,l,c,v], t = unix seconds UTC).
// Hovering a bar shades the same period in the other two charts. Rendered inside the Technical Score panel.
const priceHistoryByTicker = {};
const priceSymbolByTicker = {};   // dashboard ticker -> TradingView symbol used the last time bars were stored
const pcTickerKey = tickerKey;
// ---- Lazy price history ----
// The `priceHistory` collection holds every stock's weekly + monthly bars (about 1.5 MB), so it is NOT read at startup.
// Bars are fetched one stock at a time, with a filtered query, the first time that stock's detail page opens (or when
// the Analysis "Triggered" column needs its fetch time). Results are cached for the session.
// The recent bars saved in chunks (collection barsRecent, see recent.js), read once per session and again after a refresh saves new ones.
let recentPromise = null;
function loadRecentBars(force){
  if(recentPromise && !force) return recentPromise;
  recentPromise = (async () => {
    const db = await dbCapabilityPromise;
    if(!db) return [];
    try {
      const snap = await db.collection('barsRecent').get();
      const docs = [];
      snap.docs.forEach(d => { if(d.exists) docs.push({ id: d.id, data: d.data() }); });
      setRecentFromDocs(docs);
      return docs;
    } catch(e){ console.error('Recent bars unavailable', e); return []; }
  })();
  return recentPromise;
}
const priceLoaded = new Set();      // tickers whose bars were fetched (or saved) this session
var priceLoading = new Map();     // ticker -> in-flight promise
function priceApply(key, bars, symbol, fetchedAt){
  priceHistoryByTicker[key] = bars;
  if(symbol) priceSymbolByTicker[key] = symbol;
  if(fetchedAt) priceFetchedAt.set(key, fetchedAt);
  priceLoaded.add(key);
}
function ensurePriceBars(s){
  const key = pcTickerKey(s);
  if(!key || priceLoaded.has(key)) return Promise.resolve(false);
  if(priceLoading.has(key)) return priceLoading.get(key);
  const p = (async () => {
    const db = await dbCapabilityPromise;
    if(!db) return false;
    try {
      await loadRecentBars();
      const snap = await db.collection('priceHistory').where('ticker', '==', key).get();
      let bars = {}; let sym = null, fetched = null;
      snap.docs.forEach(d => {
        if(!d.exists) return;
        const x = d.data();
        if(x && x.interval && Array.isArray(x.bars)){ bars[x.interval] = x.bars; if(x.symbol) sym = x.symbol; }
        if(x && x.fetchedAt && (!fetched || new Date(x.fetchedAt) > new Date(fetched))) fetched = x.fetchedAt;
      });
      const w = withRecent(key, bars, fetched);
      priceApply(key, w.bars, sym, w.fetched);
      return true;
    } catch(e){ console.error('Price history unavailable', e); return false; }
    finally { priceLoading.delete(key); }
  })();
  priceLoading.set(key, p);
  return p;
}
// Every stock's bars at once (about 1.5 MB), for the Business page's longer periods. Done once per session.
let allBarsPromise = null;
function ensureAllPriceBars(){
  if(allBarsPromise) return allBarsPromise;
  allBarsPromise = (async () => {
    const db = await dbCapabilityPromise;
    if(!db) return false;
    try {
      await loadRecentBars();
      const snap = await db.collection('priceHistory').get();
      const by = new Map();
      snap.docs.forEach(d => {
        if(!d.exists) return;
        const x = d.data();
        if(!x || !x.ticker || !x.interval || !Array.isArray(x.bars)) return;
        if(!by.has(x.ticker)) by.set(x.ticker, { bars: {}, sym: null, fetched: null });
        const e = by.get(x.ticker);
        e.bars[x.interval] = x.bars; if(x.symbol) e.sym = x.symbol;
        if(x.fetchedAt && (!e.fetched || new Date(x.fetchedAt) > new Date(e.fetched))) e.fetched = x.fetchedAt;
      });
      by.forEach((e, key) => { if(!priceLoaded.has(key)){ const w = withRecent(key, e.bars, e.fetched); priceApply(key, w.bars, e.sym, w.fetched); } });
      return true;
    } catch(e){ console.error('Price history unavailable', e); allBarsPromise = null; return false; }
  })();
  return allBarsPromise;
}
// Kick off the load for the open stock and redraw it once its bars arrive.
function loadPriceBarsFor(s, idx){
  if(!s || priceLoaded.has(pcTickerKey(s))) return;
  ensurePriceBars(s).then(got => {
    if(!got) return;
    if(getShownIndex() === idx && stocks[idx] === s) renderDetail(idx);
  });
}

export { ensureAllPriceBars, ensurePriceBars, loadPriceBarsFor, loadRecentBars, pcTickerKey, priceApply, priceHistoryByTicker, priceLoaded, priceSymbolByTicker };
