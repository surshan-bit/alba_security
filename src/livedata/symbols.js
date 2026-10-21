// Live Data Refresh: TradingView symbol search and price check.
import { pcTickerKey } from '../prices/store.js';
import { tvCall, tvResolveSymbol } from '../tv/connector.js';

// The symbol comes from the stock's ISIN (tvResolveSymbol) and is remembered for this session and for the bar refresh that follows.
const ldSymOk = new Map();
// One TradingView look at a symbol: the current price. Returns { price }, with price null when there is no usable price.
const ldNum = v => { const n = (v == null || v === '') ? NaN : Number(v); return isFinite(n) ? n : null; };
async function ldQuote(sym){
  const p = await tvCall('mcp-tv-get-symbol-data', { symbol: sym, columns: ['close'] });
  const d = p && p.data ? p.data : {};
  const price = ldNum(d.close);
  return { price: price != null && price > 0 ? price : null };
}
async function ldVerifiedSymbol(s){
  const key = pcTickerKey(s);
  if(ldSymOk.has(key)) return ldSymOk.get(key);
  const sym = await tvResolveSymbol(s), q = await ldQuote(sym);
  if(q.price == null) throw new Error('TradingView returned no usable price for ' + sym + '.');
  const out = { sym, price: q.price };
  ldSymOk.set(key, out);
  return out;
}

export { ldQuote, ldSymOk, ldVerifiedSymbol };
