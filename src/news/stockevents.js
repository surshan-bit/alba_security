// Refresh events: reads the upcoming dividend and results dates of the stocks on the Stock events tab
// from TradingView and saves them into news/events beside the research items. TradingView has no board-meeting dates, so those still
// come from a research session.
import { dbCapabilityPromise } from '../core/store.js';
import { tickerSymbol } from '../core/util.js';
import { tvCall, tvErrorText, tvIsFatal, tvIstDate, tvMcp } from '../tv/connector.js';
import { isinSymbolCached, resolveIsinSymbols } from '../tv/isin.js';
import { buildTvEvents, mergeTvEvents } from './model.js';

const BATCH = 50;        // symbols per TradingView quote call (the tool's limit)
const RESOLVE_MAX = 40;  // stocks whose TradingView symbol is searched per press (the rest were never refreshed before); the others are skipped
const todayIst = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

/** @type {{ state: string, msg: string }} */
let run = { state: 'idle', msg: '' };
const getEventsRun = () => run;

const DAY_MS = 86400000, IST_MS = 19800000, WINDOW_DAYS = 90, DIVIDEND_LIMIT = 200;
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

// Makes sure the stocks have TradingView symbols (looking up a few more if some are missing) and returns symbol -> { ticker, name }.
async function symbolsOf(list){
  await resolveIsinSymbols([]);   // loads the saved symbols
  const missing = list.filter(s => !isinSymbolCached(s));
  if(missing.length) await resolveIsinSymbols(missing.slice(0, RESOLVE_MAX)).catch(e => { if(tvIsFatal(e)) throw e; });
  const symOf = new Map();
  list.forEach(s => { const sym = isinSymbolCached(s); if(sym) symOf.set(sym, { ticker: tickerSymbol(s), name: s.name }); });
  if(!symOf.size) throw new Error('None of these stocks has a TradingView symbol yet. Run Refresh Fundamental Info on them first.');
  return symOf;
}
// TradingView's dividend list only answers for a whole market (asking for named stocks returns nothing), so the next 90 days of India
// come in one call and are matched to these stocks by their code; either exchange's row will do.
async function dividendRows(symOf, win){
  const byCode = new Map(), codeOf = (sym) => sym.split(':').pop();
  symOf.forEach((who, sym) => byCode.set(codeOf(sym), sym));
  const p = await tvCall('mcp-tv-get-dividends-calendar', { market: 'india', date_from: win.today, date_to: win.to, limit: DIVIDEND_LIMIT });
  const rows = p && Array.isArray(p.data) ? p.data : [];
  const mine = rows.filter(r => r && typeof r.symbol === 'string' && byCode.has(codeOf(r.symbol)));
  return { divRows: mine.map(r => Object.assign({}, r, { symbol: byCode.get(codeOf(r.symbol)) })), capped: rows.length >= DIVIDEND_LIMIT };
}
// The results dates inside the window from one batch answer.
function earningsFrom(data, win){
  const out = [];
  Object.keys(data).forEach(sym => {
    const sec = data[sym] && data[sym].earnings_release_next_date;
    if(!Number.isFinite(sec) || sec <= 0) return;
    const d = tvIstDate(sec);
    if(d >= win.today && d <= win.to) out.push({ symbol: sym, release_next_date: d, next_date_confirmed: false });
  });
  return out;
}
// The next results date is a quote field (the earnings calendar tool has nothing for Indian stocks): TradingView's own date, which is
// the company's announced board meeting once there is one and an estimate before that. Only dates in the next 90 days are kept.
async function earningsRows(syms, win, set){
  const earnRows = [];
  let failed = 0;
  for(let i = 0; i < syms.length; i += BATCH){
    set('running', 'Reading results dates… ' + Math.min(i + BATCH, syms.length) + ' of ' + syms.length);
    try {
      const q = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: syms.slice(i, i + BATCH), columns: ['earnings_release_next_date'] });
      earnRows.push(...earningsFrom(q && q.data && typeof q.data === 'object' ? q.data : {}, win));
    } catch(e){ if(tvIsFatal(e)) throw e; failed++; }
  }
  return { earnRows, failed };
}
// Merges the fresh dates into news/events (created on the first save).
async function saveEvents(db, symOf, fresh, today){
  const ref = db.doc('news/events'), cur = await ref.get(), prev = cur && cur.exists ? (cur.data() || {}) : {};
  const items = mergeTvEvents(prev.items, new Set(Array.from(symOf.values()).map(x => x.ticker)), fresh, today);
  const upd = { items, tvAt: new Date().toISOString() };
  if(cur && cur.exists) await ref.update(upd); else await ref.set(upd);
}
function doneMessage({ checked, total, fresh, failed, capped }){
  const nDiv = fresh.filter(x => x.type === 'dividend').length, nRes = fresh.length - nDiv;
  return 'Checked ' + checked + ' of ' + total + ' stocks: ' + plural(nDiv, 'dividend date') + ' and ' + plural(nRes, 'results date') + ' in the next 90 days. Results dates are TradingView\'s (an estimate until the company announces its board meeting); board-meeting dates are not available.'
    + (checked < total ? ' ' + (total - checked) + ' skipped (no TradingView symbol yet).' : '') + (failed ? ' ' + plural(failed, 'results call') + ' failed.' : '') + (capped ? ' TradingView listed ' + DIVIDEND_LIMIT + ' dividends (its limit), so a few may be missing.' : '');
}

async function refreshStockEvents(list, onChange){
  if(run.state === 'running') return;
  const set = (state, msg) => { run = { state, msg }; onChange(); };
  set('running', 'Finding TradingView symbols…');
  try {
    if(!(await tvMcp())) throw new Error('The TradingView connector is not available in this view.');
    const db = await dbCapabilityPromise;
    if(!db) throw new Error('The database is not available in this view.');
    const symOf = await symbolsOf(list), now = Date.now() + IST_MS;
    const win = { today: todayIst(), to: new Date(now + WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10) };
    set('running', 'Reading dividend dates…');
    const { divRows, capped } = await dividendRows(symOf, win);
    const { earnRows, failed } = await earningsRows(Array.from(symOf.keys()), win, set);
    const fresh = buildTvEvents(divRows, earnRows, symOf, win.today);
    await saveEvents(db, symOf, fresh, win.today);
    set('done', doneMessage({ checked: symOf.size, total: list.length, fresh, failed, capped }));
  } catch(e){
    set('error', tvErrorText(e) || String((e && e.message) || e));
  }
}

export { getEventsRun, refreshStockEvents };
