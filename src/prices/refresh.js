// Fetches price bars from TradingView, saves them and recomputes the technical score.
import { dbCapabilityPromise } from '../core/store.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { priceHistoryStatus } from '../detail/pending.js';
import { ensurePriceBars, pcTickerKey, priceApply, priceHistoryByTicker } from './store.js';
import { computeTechnical, techCompletedBars } from '../engine/technical.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp, tvMergeDelta, tvResolveSymbol, tvToRows, tvValidate } from '../tv/connector.js';

const priceJobs = new Map();   // dashboard ticker key -> { state: 'queued'|'running'|'ok'|'error', msg, at }
const priceJobHooks = new Map();   // ticker key -> function followed by the Live Data Refresh for that stock's progress
function priceJobSet(key, state, msg){
  priceJobs.set(key, { state, msg, at: Date.now() });
  const hook = priceJobHooks.get(key);
  if(typeof hook === 'function'){ try { hook(key, state, msg); } catch(e){} }
}
async function refreshOneStock(s, db){
  const key = pcTickerKey(s);
  const set = (m) => priceJobSet(key, 'running', m);
  set('finding the TradingView symbol…');
  const sym = await tvResolveSymbol(s);
  await ensurePriceBars(s);
  const have = priceHistoryByTicker[key];
  const st = priceHistoryStatus(s);
  let delta = st.delta && have && have['1W'] && have['1M'] ? st.delta : null;
  const fetchBoth = (wN, mN) => Promise.all([
    tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1W', count: wN, format: 'columns' }),
    tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1mo', count: mN, format: 'columns' })
  ]);
  set(delta ? 'fetching recent weekly and monthly bars…' : 'fetching weekly and monthly history…');
  let [wp, mp] = await fetchBoth(delta ? delta.wkN : 261, delta ? delta.moN : 60);
  let W = tvToRows(wp, 'weekly'), M = tvToRows(mp, 'monthly');
  tvValidate(W, 'weekly'); tvValidate(M, 'monthly');
  let note = '';
  if(delta){
    const mw = tvMergeDelta(have['1W'], W), mm = tvMergeDelta(have['1M'], M);
    if(mw && mm){ W = mw; M = mm; }
    else {
      note = ' (prices were adjusted since the last fetch, so the full history was refetched)';
      delta = null;
      set('refetching the full history…');
      [wp, mp] = await fetchBoth(261, 60);
      W = tvToRows(wp, 'weekly'); M = tvToRows(mp, 'monthly'); tvValidate(W, 'weekly'); tvValidate(M, 'monthly');
    }
  }
  const lw = W[W.length - 1][4], lm = M[M.length - 1][4];
  if(Math.abs(lw - lm) > 0.003 * Math.abs(lm)) note += ' (last weekly and monthly closes differ by more than 0.3 %)';
  set('saving bars…');
  const [exch, tick] = sym.split(':');
  const base = sanitizeDocId(exch + '_' + tick);
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for(const [iv, rows] of [['1W', W], ['1M', M]]){
    const ref = db.doc('priceHistory/' + base + '_' + iv);
    const fields = { bars: rows, count: rows.length, lastBar: tvIstDate(rows[rows.length - 1][0]), fetchedAt: iso };
    const full = { symbol: sym, ticker: key, name: s.name, interval: iv, currency: 'INR', adjustment: 'split-adjusted', source: 'TradingView connector (screener page)', timeNote: 't = bar open, unix seconds UTC; add 19800 for IST', columns: ['t', 'o', 'h', 'l', 'c', 'v'], firstBar: tvIstDate(rows[0][0]), historyNote: 'Fetched from the screener page; the last bar is still forming.', ...fields };
    if(delta && have && have[iv]) await ref.update(fields); else await ref.set(full);
  }
  priceApply(key, { '1W': W, '1M': M }, sym, iso);
  let techMsg = '';
  const pv = s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
  if(pv == null){ techMsg = '; technical score not updated (no valuation reading)'; }
  else {
    // The saved score uses completed bars only (as back-tested); the reading with the week / month in progress is kept beside it as provisional.
    const now = Date.now() / 1000, Wc = techCompletedBars(W, '1W', now), Mc = techCompletedBars(M, '1M', now);
    const t = computeTechnical(Wc, Mc, pv, tvIstDate());
    if(t){
      t.basis = { source: 'bars', week: Wc.length ? tvIstDate(Wc[Wc.length - 1][0]) : null, month: Mc.length ? tvIstDate(Mc[Mc.length - 1][0]) : null };
      if(Wc.length < W.length || Mc.length < M.length){
        const p = computeTechnical(W, M, pv, tvIstDate());
        if(p && p.score != null) t.provisional = { score: p.score, states: p.states };
      }
    }
    if(!t){ techMsg = '; not enough history for a technical score'; }
    else {
      set('saving technical score…');
      const id = sanitizeDocId(tickerSymbol(s));
      const ref = db.doc('stockUpdates/' + id);
      const cur = await ref.get();
      if(cur && cur.exists) await ref.update({ technical: t }); else await ref.set({ ticker: tickerSymbol(s), technical: t });
      techMsg = '; technical score ' + (t.score == null ? 'n/a' : t.score.toFixed(2));
    }
  }
  priceJobSet(key, 'ok', 'Bars to ' + tvIstDate(W[W.length - 1][0]) + ' (' + W.length + ' weekly, ' + M.length + ' monthly)' + techMsg + note);
}
// Refreshes one stock's bars and technical score on its own, so several stocks can run at the same time (the Live Data
// Refresh does this for a batch).
async function refreshOneNow(s){
  const key = pcTickerKey(s);
  const db = await dbCapabilityPromise;
  if(!db){ priceJobSet(key, 'error', 'The database is not available in this view.'); return; }
  if(!(await tvMcp())){ priceJobSet(key, 'error', 'The TradingView connector is not available in this view.'); return; }
  priceJobSet(key, 'queued', 'waiting…');
  try { await refreshOneStock(s, db); }
  catch(e){ priceJobSet(key, 'error', tvErrorText(e)); }
}

function setPriceJobHook(key, fn){ if(fn) priceJobHooks.set(key, fn); else priceJobHooks.delete(key); }

export { priceJobs, refreshOneNow, setPriceJobHook };
