// Live Data Refresh: TradingView symbol search and price check.
import { tickerSymbol } from '../core/util.js';
import { pcTickerKey, priceSymbolByTicker } from '../prices/store.js';
import { tvCall, tvResolveSymbol } from '../tv/connector.js';

// The dashboard ticker is not always the TradingView ticker (for example OCCL is NSE:OCCLLTD there). The first guess from
// tvResolveSymbol is checked with a real price request; when TradingView has no data for it, the symbol is looked up by ticker
// and company name, and the working symbol is remembered for this session and for the bar refresh that follows.
const ldSymOk = new Map();
async function ldSearchSymbol(s){
  const key = pcTickerKey(s);
  const norm = x => String(x || '').toLowerCase().replace(/\b(limited|ltd|pvt|private)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(s.name);
  const seen = new Map();
  for(const q of [tickerSymbol(s), s.name]){
    if(!q) continue;
    let p; try { p = await tvCall('mcp-tv-search-symbols', { query: q, type_filter: 'stock' }); } catch(e){ continue; }
    const list = (p && p.data && p.data.symbols) || [];
    list.forEach(r => { if(r && r.symbol && (r.exchange === 'NSE' || r.exchange === 'BSE')) seen.set(r.symbol, r); });
  }
  const cands = Array.from(seen.values()).filter(r => {
    const t = r.symbol.split(':')[1] || '', d = norm(r.description);
    return t === key || (key.length >= 4 && t.startsWith(key)) || (want && (d === want || d.startsWith(want) || want.startsWith(d)));
  });
  for(const ex of ['NSE', 'BSE']){
    const c = cands.filter(r => r.exchange === ex);
    if(c.length === 1) return c[0].symbol;
    const exact = c.filter(r => r.symbol.split(':')[1] === key);
    if(exact.length === 1) return exact[0].symbol;
  }
  throw new Error('Could not match ' + s.name + ' to a TradingView symbol (' + cands.length + ' candidates).');
}
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
  let sym = await tvResolveSymbol(s), q = null;
  try { q = await ldQuote(sym); } catch(e){ if(!(e && e.code === 'tool_error')) throw e; }
  if(!q || q.price == null){
    sym = await ldSearchSymbol(s);
    q = await ldQuote(sym);
    if(q.price == null) throw new Error('TradingView returned no usable price for ' + sym + '.');
    priceSymbolByTicker[key] = sym;
  }
  const out = { sym, price: q.price };
  ldSymOk.set(key, out);
  return out;
}

export { ldQuote, ldSymOk, ldVerifiedSymbol };
