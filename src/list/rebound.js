// "Rebound" filter: down last week, up this week. Last week's move comes from the saved weekly bars (loaded with ensureAllPriceBars);
// this week's is the W % chg figure saved with the stock. A stock without either figure does not qualify.
import { lastWeekMove } from '../prices/periodmove.js';
import { pcTickerKey, priceHistoryByTicker } from '../prices/store.js';

function isRebound(s){
  const raw = s.technical && s.technical.raw, wk = raw ? raw.weekPctChange : null;
  if(!(wk > 0)) return false;
  const d = priceHistoryByTicker[pcTickerKey(s)], last = d ? lastWeekMove(d['1W']) : null;
  return last !== null && last < 0;
}

export { isRebound };
