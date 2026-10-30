// Refresh events: reads the upcoming dividend dates of the stocks on the Stock events tab
// from TradingView and saves them into news/events beside the research items. TradingView has no board-meeting dates and, for most Indian
// stocks, no results dates, so those still come from a research session.
import { dbCapabilityPromise } from '../core/store.js';
import { tickerSymbol } from '../core/util.js';
import { tvCall, tvErrorText, tvIsFatal, tvMcp } from '../tv/connector.js';
import { isinSymbolCached, resolveIsinSymbols } from '../tv/isin.js';
import { buildTvEvents, mergeTvEvents } from './model.js';

const RESOLVE_MAX = 40;  // stocks whose TradingView symbol is searched per press (the rest were never refreshed before); the others are skipped
const todayIst = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

/** @type {{ state: string, msg: string }} */
let run = { state: 'idle', msg: '' };
const getEventsRun = () => run;

async function refreshStockEvents(list, onChange){
  if(run.state === 'running') return;
  const set = (state, msg) => { run = { state, msg }; onChange(); };
  set('running', 'Finding TradingView symbols…');
  try {
    if(!(await tvMcp())) throw new Error('The TradingView connector is not available in this view.');
    const db = await dbCapabilityPromise;
    if(!db) throw new Error('The database is not available in this view.');
    await resolveIsinSymbols([]);   // loads the saved symbols
    const missing = list.filter(s => !isinSymbolCached(s));
    if(missing.length) await resolveIsinSymbols(missing.slice(0, RESOLVE_MAX)).catch(e => { if(tvIsFatal(e)) throw e; });
    const symOf = new Map();
    list.forEach(s => { const sym = isinSymbolCached(s); if(sym) symOf.set(sym, { ticker: tickerSymbol(s), name: s.name }); });
    if(!symOf.size) throw new Error('None of these stocks has a TradingView symbol yet. Run Refresh Fundamental Info on them first.');
    // TradingView's dividend list only answers for a whole market (asking for named stocks returns nothing), so the next 90 days of India
    // come in one call and are matched to these stocks by their code; either exchange's row will do.
    const byCode = new Map();
    symOf.forEach((who, sym) => byCode.set(sym.split(':').pop(), sym));
    const today = todayIst(), to = new Date(Date.now() + 19800000 + 90 * 86400000).toISOString().slice(0, 10);
    set('running', 'Reading dividend dates…');
    const p = await tvCall('mcp-tv-get-dividends-calendar', { market: 'india', date_from: today, date_to: to, limit: 200 });
    const rows = p && Array.isArray(p.data) ? p.data : [];
    const divRows = rows.filter(r => r && typeof r.symbol === 'string' && byCode.has(r.symbol.split(':').pop())).map(r => Object.assign({}, r, { symbol: byCode.get(r.symbol.split(':').pop()) }));
    const capped = rows.length >= 200;
    const fresh = buildTvEvents(divRows, [], symOf, today);
    const ref = db.doc('news/events'), cur = await ref.get(), prev = cur && cur.exists ? (cur.data() || {}) : {};
    const items = mergeTvEvents(prev.items, new Set(Array.from(symOf.values()).map(x => x.ticker)), fresh, today);
    const upd = { items, tvAt: new Date().toISOString() };
    if(cur && cur.exists) await ref.update(upd); else await ref.set(upd);
    const nDiv = fresh.length;
    set('done', 'Checked ' + symOf.size + ' of ' + list.length + ' stocks: ' + nDiv + ' dividend date' + (nDiv === 1 ? '' : 's') + ' in the next 90 days. TradingView has no results or board-meeting dates for Indian stocks.' + (symOf.size < list.length ? ' ' + (list.length - symOf.size) + ' skipped (no TradingView symbol yet).' : '') + (capped ? ' TradingView listed 200 dividends (its limit), so a few may be missing.' : ''));
  } catch(e){
    set('error', tvErrorText(e) || String((e && e.message) || e));
  }
}

export { getEventsRun, refreshStockEvents };
