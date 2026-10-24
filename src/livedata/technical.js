// Live Data Refresh: Technical Info (price, MoS, bars, technical score).
import { dbCapabilityPromise } from '../core/store.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { marginOfSafety } from '../core/mos.js';
import { pcTickerKey } from '../prices/store.js';
import { tvIstDate, tvMcp } from '../tv/connector.js';
import { setPriceJobHook, priceJobs, refreshOneNow } from '../prices/refresh.js';
import { ldMosText, ldRupees, ldSet } from './bar.js';
import { ldSymOk, ldVerifiedSymbol } from './symbols.js';
import { getLdBatch } from './batch.js';

// ------------------------------------------------------------------------------------------------------------------
// Refresh Technical Info
// ------------------------------------------------------------------------------------------------------------------
async function ldRunTechnical(s){
  const key = pcTickerKey(s);
  const set = (pct, msg) => ldSet(key, 'tech', { state: 'running', pct, msg });
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
  const mosAt = pr => marginOfSafety(iv, pr);
  const oldMos = mosAt(oldPx), newMos = mosAt(px);
  set(20, 'Saving the price…');
  const id = sanitizeDocId(tickerSymbol(s));
  const ref = db.doc('stockUpdates/' + id);
  const cur = await ref.get();
  const val = { currentPrice: px, asof: tvIstDate(), at: new Date().toISOString(), source: 'TradingView (' + sym + ')' };
  if(cur && cur.exists) await ref.update({ valuation: val }); else await ref.set({ ticker: tickerSymbol(s), valuation: val });

  // 2 and 3. Weekly and monthly bars (delta only when bars are stored), then MACD/RSI and the Technical Score.
  const STAGES = {
    symbol: [26, 'Finding the TradingView symbol…'],
    refetch: [50, 'Prices were adjusted, fetching the full history again…'],
    recent: [38, 'Fetching only the new weekly and monthly bars…'],
    history: [38, 'Fetching weekly and monthly history…'],
    bars: [70, 'Saving the bars…'],
    technical: [88, 'Computing MACD and RSI and saving the Technical Score…']
  };
  const hook = (k, state, msg, stage) => {
    if(k !== key) return;
    if(state === 'queued') set(24, 'Preparing the bar download…');
    else if(STAGES[stage]) set(STAGES[stage][0], STAGES[stage][1]);
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
