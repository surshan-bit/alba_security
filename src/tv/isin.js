// ISIN -> TradingView symbol, the one way technical data is looked up. TradingView takes no ISIN as a symbol, but its symbol search
// finds a stock by ISIN and its `isin` column confirms the match. NSE first, BSE if the stock is not on NSE. Answers are kept in
// stockMeta/isinSymbol ({ "<ISIN>": "NSE:TCS" }) so each stock is searched once. A stock with no ISIN, or no confirmed match, has no symbol.
import { dbCapabilityPromise } from '../core/store.js';
import { tvCall } from './connector.js';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/** @type {Record<string, string>} */
const isinSymbols = {};
let loading = null;
const failed = new Set();   // ISINs that found nothing this session, so one run does not search them twice

const isinOf = s => String((s && s.isin) || '').trim().toUpperCase();
function isinSymbolCached(s){ return isinSymbols[isinOf(s)] || null; }
function loadIsinSymbols(){
  if(!loading) loading = (async () => {
    try { const db = await dbCapabilityPromise; const d = db && await db.doc('stockMeta/isinSymbol').get(); if(d && d.exists) Object.assign(isinSymbols, d.data()); }
    catch(e){ console.error('Could not read the ISIN symbol map', e); }
  })();
  return loading;
}
async function saveIsinSymbols(add){
  try { const db = await dbCapabilityPromise; if(!db) return; const ref = db.doc('stockMeta/isinSymbol'); const cur = await ref.get(); if(cur && cur.exists) await ref.update(add); else await ref.set(add); }
  catch(e){ console.error('Could not save the ISIN symbol map', e); }
}
async function searchIsin(isin){
  const p = await tvCall('mcp-tv-search-symbols', { query: isin, type_filter: 'stock' });
  const list = ((p && p.data && p.data.symbols) || (p && p.symbols) || []).filter(r => r && r.symbol && (r.exchange === 'NSE' || r.exchange === 'BSE'));
  for(const ex of ['NSE', 'BSE']){
    for(const r of list.filter(x => x.exchange === ex)){
      const d = await tvCall('mcp-tv-get-symbol-data', { symbol: r.symbol, columns: ['isin'] }).catch(() => null);
      if(d && d.data && String(d.data.isin).toUpperCase() === isin) return r.symbol;
    }
  }
  return null;
}
// Symbols for these stocks, from the saved map or one search each (4 at a time). Returns the stocks that have none.
async function resolveIsinSymbols(list, workers = 4){
  await loadIsinSymbols();
  const todo = list.filter(s => ISIN_RE.test(isinOf(s)) && !isinSymbols[isinOf(s)] && !failed.has(isinOf(s)));
  const added = {};
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, async () => {
    while(i < todo.length){
      const isin = isinOf(todo[i++]);
      try { const sym = await searchIsin(isin); if(sym){ isinSymbols[isin] = sym; added[isin] = sym; } else failed.add(isin); }
      catch(e){ if(e && (e.code === 'no_mcp' || e.code === 'quota')) throw e; failed.add(isin); }
    }
  }));
  if(Object.keys(added).length) await saveIsinSymbols(added);
  return list.filter(s => !isinSymbols[isinOf(s)]);
}

// Stocks TradingView gave no price for although they have a saved symbol: the company may have been renamed or moved to the other exchange, so the saved
// symbol is dead (an ISIN stays the same). Each one is searched by its ISIN again and, where the search confirms a different symbol, the map is corrected.
// Returns [{ stock, from, to }]. A failed search leaves the saved symbol as it is; no connection or no quota stops the whole lookup.
async function correctIsinSymbols(list, workers = 4){
  await loadIsinSymbols();
  const todo = list.filter(s => ISIN_RE.test(isinOf(s)) && isinSymbols[isinOf(s)]);
  const fixed = [], added = {};
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, async () => {
    while(i < todo.length){
      const s = todo[i++], isin = isinOf(s);
      try {
        const sym = await searchIsin(isin);
        if(sym && sym !== isinSymbols[isin]){ fixed.push({ stock: s, from: isinSymbols[isin], to: sym }); isinSymbols[isin] = sym; added[isin] = sym; }
      } catch(e){ if(e && (e.code === 'no_mcp' || e.code === 'quota')) throw e; /* one failed search only leaves that symbol as it is */ }
    }
  }));
  if(fixed.length) await saveIsinSymbols(added);
  return fixed;
}

// A bulk run does not search TradingView: it pairs each stock's saved ISIN with the TradingView symbol its last run stored (`savedOf(stock)`),
// and keeps the pairs in the same map. Stocks with no saved symbol are returned; they are found by their own Refresh. One save for the whole list.
async function useSavedSymbols(list, savedOf){
  await loadIsinSymbols();
  const added = {};
  for(const s of list){
    const isin = isinOf(s);
    if(!ISIN_RE.test(isin) || isinSymbols[isin]) continue;
    const sym = savedOf(s);
    if(typeof sym === 'string' && /^[A-Z0-9_&-]+:.+/.test(sym)){ isinSymbols[isin] = sym; added[isin] = sym; }
  }
  if(Object.keys(added).length) await saveIsinSymbols(added);
  return list.filter(s => !isinSymbols[isinOf(s)]);
}

export { correctIsinSymbols, isinOf, isinSymbolCached, resolveIsinSymbols, useSavedSymbols };
