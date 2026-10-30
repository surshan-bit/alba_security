// Refresh events: reads the upcoming dividend dates (and results dates, where TradingView has them) of the stocks on the Stock events tab
// from TradingView and saves them into news/events beside the research items. TradingView has no board-meeting dates and, for most Indian
// stocks, no results dates, so those still come from a research session.
import { dbCapabilityPromise } from '../core/store.js';
import { tickerSymbol } from '../core/util.js';
import { tvCall, tvErrorText, tvIsFatal, tvMcp } from '../tv/connector.js';
import { isinSymbolCached, resolveIsinSymbols } from '../tv/isin.js';
import { buildTvEvents, mergeTvEvents } from './model.js';

const BATCH = 40;        // symbols per TradingView call
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
    const syms = Array.from(symOf.keys()), today = todayIst(), divRows = [], earnRows = [];
    let failed = 0;
    for(let i = 0; i < syms.length; i += BATCH){
      set('running', 'Reading events… ' + Math.min(i + BATCH, syms.length) + ' of ' + syms.length);
      const part = syms.slice(i, i + BATCH);
      const read = async (tool, input, sink, pick) => {
        try {
          const rows = pick(await tvCall(tool, input));
          if(Array.isArray(rows)) sink.push(...rows);
        } catch(e){ if(tvIsFatal(e)) throw e; failed++; }
      };
      await read('mcp-tv-get-dividends-calendar', { symbols: part }, divRows, (/** @type {any} */ p) => p && p.data);
      await read('mcp-tv-get-earnings-calendar', { symbols: part, date_from: today, date_to: new Date(Date.now() + 19800000 + 180 * 86400000).toISOString().slice(0, 10) }, earnRows, (/** @type {any} */ p) => p && p.data && p.data.earnings);
    }
    if(failed >= 2 * Math.ceil(syms.length / BATCH)) throw new Error('TradingView returned no data.');
    const fresh = buildTvEvents(divRows, earnRows, symOf, today);
    const ref = db.doc('news/events'), cur = await ref.get(), prev = cur && cur.exists ? (cur.data() || {}) : {};
    const items = mergeTvEvents(prev.items, new Set(Array.from(symOf.values()).map(x => x.ticker)), fresh, today);
    const upd = { items, tvAt: new Date().toISOString() };
    if(cur && cur.exists) await ref.update(upd); else await ref.set(upd);
    const nDiv = fresh.filter(x => x.type === 'dividend').length, nRes = fresh.filter(x => x.type === 'results').length;
    set('done', 'Checked ' + symOf.size + ' of ' + list.length + ' stocks: ' + nDiv + ' dividend date' + (nDiv === 1 ? '' : 's') + ', ' + nRes + ' results date' + (nRes === 1 ? '' : 's') + '.' + (symOf.size < list.length ? ' ' + (list.length - symOf.size) + ' skipped (no TradingView symbol yet).' : '') + (failed ? ' ' + failed + ' call' + (failed === 1 ? '' : 's') + ' failed.' : ''));
  } catch(e){
    set('error', tvErrorText(e) || String((e && e.message) || e));
  }
}

export { getEventsRun, refreshStockEvents };
