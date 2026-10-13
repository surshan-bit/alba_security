// Live Data Refresh: Technical Info (price, MoS, bars, technical score).
import { dbCapabilityPromise } from '../core/store.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { pcTickerKey } from '../prices/store.js';
import { tvIstDate, tvMcp } from '../tv/connector.js';
import { setPriceJobHook, priceJobs, refreshOneNow } from '../prices/refresh.js';
import { ldMosText, ldRupees, ldSet } from './bar.js';
import { setLdPhase } from './claude.js';
import { ldSymOk, ldVerifiedSymbol } from './symbols.js';
import { getLdBatch } from './batch.js';

// ------------------------------------------------------------------------------------------------------------------
// Refresh Technical Info
// ------------------------------------------------------------------------------------------------------------------
async function ldRunTechnical(s){
  const key = pcTickerKey(s);
  const set = (pct, msg) => ldSet(key, 'tech', { state: 'running', pct, msg });
  setLdPhase('tv');
  set(3, 'Connecting to TradingView…');
  const db = await dbCapabilityPromise;
  if(!db) throw new Error('The database is not available in this view.');
  if(!(await tvMcp())) throw Object.assign(new Error('The TradingView connector is not available in this view.'), { code: 'no_mcp' });

  // 1. Current price, then Margin of Safety against the CSV intrinsic value.
  set(8, 'Finding the TradingView symbol and current price…');
  ldSymOk.delete(key);   // price is read fresh every click; the symbol itself is re-checked cheaply
  const stopNow = () => { if(getLdBatch() && getLdBatch().running && getLdBatch().stop) throw { code: 'cancelled' }; };
  stopNow();
  const { sym, price: px } = await ldVerifiedSymbol(s);
  stopNow();
  const v = s.valuation || {};
  const iv = typeof v.intrinsicValue === 'number' && v.intrinsicValue > 0 ? v.intrinsicValue : null;
  const oldPx = typeof v.currentPrice === 'number' ? v.currentPrice : null;
  const mosAt = pr => (iv != null && pr != null) ? ((iv - pr) / iv) * 100 : null;
  const oldMos = mosAt(oldPx), newMos = mosAt(px);
  set(20, 'Saving the price…');
  const id = sanitizeDocId(tickerSymbol(s));
  const ref = db.doc('stockUpdates/' + id);
  const cur = await ref.get();
  const val = { currentPrice: px, asof: tvIstDate(), source: 'TradingView (' + sym + ')' };
  if(cur && cur.exists) await ref.update({ valuation: val }); else await ref.set({ ticker: tickerSymbol(s), valuation: val });

  // 2 and 3. Weekly and monthly bars (delta only when bars are stored), then MACD/RSI and the Technical Score.
  const hook = (k, state, msg) => {
    if(k !== key) return;
    const m = String(msg || '');
    if(state === 'queued') set(24, 'Preparing the bar download…');
    else if(/finding the TradingView symbol/.test(m)) set(26, 'Finding the TradingView symbol…');
    else if(/refetching/.test(m)) set(50, 'Prices were adjusted, fetching the full history again…');
    else if(/fetching recent/.test(m)) set(38, 'Fetching only the new weekly and monthly bars…');
    else if(/fetching weekly/.test(m)) set(38, 'Fetching weekly and monthly history…');
    else if(/saving bars/.test(m)) set(70, 'Saving the bars…');
    else if(/saving technical/.test(m)) set(88, 'Computing MACD and RSI and saving the Technical Score…');
  };
  stopNow();
  setPriceJobHook(key, hook);
  try { await refreshOneNow(s); } finally { setPriceJobHook(key, null); }
  const j = priceJobs.get(key);
  if(!j || j.state !== 'ok') throw new Error((j && j.msg) ? j.msg : 'The price history refresh did not finish.');
  const pxText = ldRupees(px) + (oldPx != null && oldPx !== px ? ' (was ' + ldRupees(oldPx) + ')' : '');
  const mosText = iv == null ? 'no intrinsic value on file, MoS not computed' : 'MoS ' + ldMosText(oldMos) + ' → ' + ldMosText(newMos);
  return 'Price ' + pxText + '; ' + mosText + '. ' + j.msg + '.';
}

export { ldRunTechnical };
