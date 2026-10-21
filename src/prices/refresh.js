// Fetches price bars from TradingView, saves them and recomputes the technical score.
import { dbCapabilityPromise } from '../core/store.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { priceHistoryStatus } from '../detail/pending.js';
import { noteFullSaved } from './recent.js';
import { ensurePriceBars, pcTickerKey, priceApply, priceHistoryByTicker } from './store.js';
import { weekStartS, monthStartS, weekBucket, monthBucket, TOLERANCE } from '../refresh/historyplan.js';
import { computeTechnical } from '../engine/technical.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp, tvMergeDelta, tvResolveSymbol, tvToRows, tvValidate } from '../tv/connector.js';

const priceJobs = new Map();   // dashboard ticker key -> { state: 'queued'|'running'|'ok'|'error', msg, at }
const priceJobHooks = new Map();   // ticker key -> function followed by the Live Data Refresh for that stock's progress
function priceJobSet(key, state, msg){
  priceJobs.set(key, { state, msg, at: Date.now() });
  const hook = priceJobHooks.get(key);
  if(typeof hook === 'function'){ try { hook(key, state, msg); } catch(e){} }
}
// lean: the bulk refresh asks only for the bar type that is out of date (weekly every week, monthly once a month): half the TradingView calls,
// which matters because the connector has a daily call quota.
async function refreshOneStock(s, db, lean){
  const key = pcTickerKey(s);
  const set = (m) => priceJobSet(key, 'running', m);
  set('finding the TradingView symbol…');
  const sym = await tvResolveSymbol(s);
  await ensurePriceBars(s);
  const have = priceHistoryByTicker[key];
  const st = priceHistoryStatus(s);
  let delta = st.delta && have && have['1W'] && have['1M'] ? st.delta : null;
  const nowS = Date.now() / 1000;
  let needW = true, needM = true;
  if(lean && delta){ needW = have['1W'][have['1W'].length - 1][0] < weekStartS(nowS) - TOLERANCE; needM = have['1M'][have['1M'].length - 1][0] < monthStartS(nowS) - TOLERANCE; }
  const fetchBoth = (wN, mN, w = true, m = true) => Promise.all([
    w ? tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1W', count: wN, format: 'columns' }) : null,
    m ? tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1mo', count: mN, format: 'columns' }) : null
  ]);
  const rowsOf = (wp, mp) => {
    const w = wp ? tvToRows(wp, 'weekly') : null, m = mp ? tvToRows(mp, 'monthly') : null;
    if(w) tvValidate(w, 'weekly'); if(m) tvValidate(m, 'monthly');
    return [w, m];
  };
  set(delta ? 'fetching recent weekly and monthly bars…' : 'fetching weekly and monthly history…');
  let [wp, mp] = await fetchBoth(delta ? delta.wkN : 261, delta ? delta.moN : 60, needW, needM);
  let [W, M] = rowsOf(wp, mp);
  let note = '';
  if(delta){
    const mw = W ? tvMergeDelta(have['1W'], W, weekBucket) : have['1W'], mm = M ? tvMergeDelta(have['1M'], M, monthBucket) : have['1M'];
    if(mw && mm){ W = mw; M = mm; }
    else {
      note = ' (prices were adjusted since the last fetch, so the full history was refetched)';
      delta = null; needW = needM = true;
      set('refetching the full history…');
      [wp, mp] = await fetchBoth(261, 60);
      [W, M] = rowsOf(wp, mp);
    }
  }
  const lw = W[W.length - 1][4], lm = M[M.length - 1][4];
  if(needW && needM && Math.abs(lw - lm) > 0.003 * Math.abs(lm)) note += ' (last weekly and monthly closes differ by more than 0.3 %)';
  await persistBars(s, db, sym, W, M, { delta: !!delta, needW, needM, note });
}
// Writes a stock's own priceHistory documents (only the kinds that changed when `o.delta`) and returns the save time. A full write (not a delta) replaces both.
async function writeBarDocs(s, db, sym, W, M, o){
  const key = pcTickerKey(s), have = priceHistoryByTicker[key];
  const [exch, tick] = sym.split(':');
  const base = sanitizeDocId(exch + '_' + tick);
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for(const [iv, rows] of [['1W', W], ['1M', M]]){
    if(o.delta && ((iv === '1W' && !o.needW) || (iv === '1M' && !o.needM))) continue;   // not fetched this time, nothing new to save
    const ref = db.doc('priceHistory/' + base + '_' + iv);
    const fields = { bars: rows, count: rows.length, lastBar: tvIstDate(rows[rows.length - 1][0]), fetchedAt: iso };
    const full = { symbol: sym, ticker: key, name: s.name, interval: iv, currency: 'INR', adjustment: 'split-adjusted', source: 'TradingView connector (screener page)', timeNote: 't = bar open, unix seconds UTC; add 19800 for IST', columns: ['t', 'o', 'h', 'l', 'c', 'v'], firstBar: tvIstDate(rows[0][0]), historyNote: 'Fetched from the screener page; the last bar is still forming.', ...fields };
    if(o.delta && have && have[iv]) await ref.update(fields); else await ref.set(full);
    noteFullSaved(key, iv, rows);
  }
  return iso;
}
// Rewrites a stock's own documents with the bars the page holds (its saved bars plus the recent chunks), so the chunks need not reach back so far (compaction).
async function saveFullBars(s, W, M){
  const key = pcTickerKey(s), db = await dbCapabilityPromise;
  if(!db) return false;
  try { await writeBarDocs(s, db, await tvResolveSymbol(s), W, M, { delta: false }); return true; }
  catch(e){ console.error('Could not compact the bars of ' + key, e); return false; }
}
// Saves one stock's bars (only the kinds that changed when `o.delta`), then its technical score. Shared by the one-stock fetch above and the batch update.
async function persistBars(s, db, sym, W, M, o){
  const { delta, needW, needM } = o;
  let note = o.note || '';
  const key = pcTickerKey(s);
  const set = (m) => priceJobSet(key, 'running', m);
  set('saving bars…');
  const iso = await writeBarDocs(s, db, sym, W, M, { delta, needW, needM });
  priceApply(key, { '1W': W, '1M': M }, sym, iso);
  let techMsg = '';
  const pv = s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
  if(pv == null){ techMsg = '; technical score not updated (no valuation reading)'; }
  else {
    const t = computeTechnical(W, M, pv, tvIstDate());
    if(!t){ techMsg = '; not enough history for a technical score'; }
    else {
      set('saving technical score…');
      const id = sanitizeDocId(tickerSymbol(s));
      const ref = db.doc('stockUpdates/' + id);
      const cur = await ref.get();
      if(cur && cur.exists) await ref.update({ technical: t }); else await ref.set({ ticker: tickerSymbol(s), technical: t });
      techMsg = '; technical score ' + (t.score == null ? 'n/a' : t.score.toFixed(2)) + (t.provisional ? ' (completed bars; this week/month in progress reads ' + (t.provisional.score == null ? 'n/a' : t.provisional.score.toFixed(2)) + ')' : '');
    }
  }
  priceJobSet(key, 'ok', 'Bars to ' + tvIstDate(W[W.length - 1][0]) + ' (' + W.length + ' weekly, ' + M.length + ' monthly)' + techMsg + note);
}
// Refreshes one stock's bars and technical score on its own, so several stocks can run at the same time (the Live Data
// Refresh does this for a batch).
async function refreshOneNow(s, lean){
  const key = pcTickerKey(s);
  const db = await dbCapabilityPromise;
  if(!db){ priceJobSet(key, 'error', 'The database is not available in this view.'); return; }
  if(!(await tvMcp())){ priceJobSet(key, 'error', 'The TradingView connector is not available in this view.'); return; }
  priceJobSet(key, 'queued', 'waiting…');
  try { await refreshOneStock(s, db, lean); }
  catch(e){ priceJobSet(key, 'error', tvErrorText(e)); }
}

function setPriceJobHook(key, fn){ if(fn) priceJobHooks.set(key, fn); else priceJobHooks.delete(key); }

export { priceJobs, refreshOneNow, saveFullBars, setPriceJobHook };
