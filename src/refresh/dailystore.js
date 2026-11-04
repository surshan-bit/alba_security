// The saved daily (1D) bars of a stock (v1.355): one document per stock in the collection priceHistory1D, laid out like the weekly and monthly documents in priceHistory
// (id e.g. NSE_TCS_1D, bars as [t,o,h,l,c,v], t = unix seconds UTC, newest last). The daily bars have a collection of their own, so the loaders of the weekly and
// monthly bars, which read priceHistory whole and use the newest save time of a stock's documents, never see them. Only the stocks of the strategy chosen for the
// daily import have a document (see dailymacd.js).
import { sanitizeDocId } from '../core/util.js';
import { tvIstDate } from '../tv/connector.js';

const DAILY_COLLECTION = 'priceHistory1D';
const dailyDocPath = sym => { const [exch, tick] = String(sym).split(':'); return DAILY_COLLECTION + '/' + sanitizeDocId(exch + '_' + tick) + '_1D'; };

// The saved bars of the stock whose TradingView symbol is `sym`, oldest first, or null when it has none.
async function loadDailyBars(db, sym){
  const d = await db.doc(dailyDocPath(sym)).get();
  const x = d && d.exists ? d.data() : null;
  return x && Array.isArray(x.bars) && x.bars.length ? x.bars : null;
}

// Saves the stock's bars. `who` = { sym, key, name }. A stock saved before gets only the fields that change; a new one gets the whole document.
async function saveDailyBars(db, who, bars, isNew){
  const ref = db.doc(dailyDocPath(who.sym));
  const fields = { bars, count: bars.length, firstBar: tvIstDate(bars[0][0]), lastBar: tvIstDate(bars[bars.length - 1][0]), fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  if(!isNew){ await ref.update(fields); return; }
  await ref.set({ symbol: who.sym, ticker: who.key, name: who.name, interval: '1D', currency: 'INR', adjustment: 'split-adjusted', source: 'TradingView connector (screener page)',
    timeNote: 't = bar open, unix seconds UTC; add 19800 for IST', columns: ['t', 'o', 'h', 'l', 'c', 'v'], historyNote: 'Fetched for the strategy chosen for the daily import; the last bar is still forming.', ...fields });
}

export { loadDailyBars, saveDailyBars };
