// "Refresh from TradingView" on the Data Refresh screen (Technical Score section): no CSV needed.
//  1. Refresh all stocks: one TradingView snapshot of price, MACD and RSI (weekly, monthly) for every stock, 50 per call.
//     It saves the price and a technical block per stock in stockUpdates, the same place the Live Data Refresh writes to.
//     TradingView's figures include the week and month still in progress, so a stock whose saved block was built from completed
//     bars in the last 3 days keeps that block (only its price is updated).
//  2. Fill missing history: downloads weekly and monthly bars for stocks that have none saved (tracked picks first, then pinned,
//     then strategy matches, then the rest), a limited number per run. Re-running carries on with the next ones.
import { stocks, stockByTickerSymbol } from '../core/stocks.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { snapshotTechnical, techKeepsBarsBlock } from '../engine/technical.js';
import { priceHistoryByTicker, pcTickerKey, priceSymbolByTicker, ensureAllPriceBars } from '../prices/store.js';
import { refreshOneNow, priceJobs } from '../prices/refresh.js';
import { BSE_ALPHA_MAP } from '../tv/links.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp } from '../tv/connector.js';
import { loadRuns } from '../strategies/tracking.js';
import { priorityOrder } from './freshness.js';
import { getFiDb, getFiOwner, getFiRunning, setFiRunning } from '../import/fund-import.js';
import { fiEl, fiReset, fiSet, fiShowResult, setFiPfx } from '../import/panel.js';
import { registerBusy } from '../core/busy.js';

const BATCH = 50;                 // symbols per TradingView call (the tool's limit)
const HISTORY_CAP = 100;          // stocks per "Fill missing history" run
const SKIP_RETRY_DAYS = 14;       // a stock that failed history fill is not retried for this long
const COLS = ['close', 'MACD.macd|1W', 'MACD.signal|1W', 'MACD.macd|1M', 'MACD.signal|1M', 'RSI|1W', 'RSI|1M', 'change|1W', 'change|1M', 'average_volume_30d_calc'];
const STEPS = [{ key: 'prepare', label: 'Prepare the stock list', w: 5 }, { key: 'run', label: 'Refresh', w: 90 }, { key: 'verify', label: 'Finish', w: 5 }];

// The TradingView symbol for a stock without asking TradingView: the one used before, the BSE alpha map for numeric BSE codes,
// otherwise NSE:<ticker>. null for a BSE-only stock whose symbol is not known yet.
function snapshotSymbol(s, bseMap){
  const key = pcTickerKey(s);
  if(priceSymbolByTicker[key]) return priceSymbolByTicker[key];
  if(!/^\d+$/.test(key)) return 'NSE:' + key.replace(/-/g, '_');
  const a = (bseMap || BSE_ALPHA_MAP)[key];
  return a ? 'BSE:' + String(a).replace(/^BSE:/, '') : null;
}
// What to save for one stock from its TradingView row: { valuation?, technical? }, or { reason } when nothing can be saved.
function snapshotUpdate(s, row, today, sym){
  const px = row && typeof row.close === 'number' && row.close > 0 ? row.close : null;
  if(px == null) return { reason: 'TradingView returned no price' };
  const out = { valuation: { currentPrice: px, asof: today, source: 'TradingView (' + sym + ')' } };
  if(typeof row['average_volume_30d_calc'] === 'number' && row['average_volume_30d_calc'] >= 0) out.liquidity = { avgVolume: Math.round(row['average_volume_30d_calc']), asof: today };
  const pv = s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
  if(pv == null){ out.note = 'no valuation reading, technical score not updated'; return out; }
  if(techKeepsBarsBlock(s.technical, today)){ out.kept = true; return out; }
  const t = snapshotTechnical({ monthMacdLevel: row['MACD.macd|1M'], monthMacdSignal: row['MACD.signal|1M'], weekMacdLevel: row['MACD.macd|1W'], weekMacdSignal: row['MACD.signal|1W'],
    monthRsi: row['RSI|1M'], weekRsi: row['RSI|1W'], weekPctChange: row['change|1W'], monthPctChange: row['change|1M'] }, pv, today);
  if(!t) out.note = 'TradingView returned no MACD or RSI'; else out.technical = t;
  return out;
}

let stopAsked = false;
let busy = false;
registerBusy(() => busy);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => x.toLocaleString('en-IN');
// "2 min 14 s" for a run time in milliseconds.
function duration(ms){ const t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60); return m ? m + ' min ' + (t % 60) + ' s' : t + ' s'; }
// Compares two saved values by content, whatever order their keys are in.
function stable(x){ return x && typeof x === 'object' ? (Array.isArray(x) ? x.map(stable) : Object.keys(x).sort().reduce((o, k) => { o[k] = stable(x[k]); return o; }, {})) : x; }
const sameValue = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
// True when the saved record already holds exactly what this run would write (a second run the same day, or a weekend), so the write can be skipped.
function alreadySaved(stored, body){ return !!stored && Object.keys(body).every(k => sameValue(stored[k], body[k])); }

function setButtons(running){
  for(const id of ['tvSnapshotBtn', 'tvHistoryBtn']){ const b = /** @type {HTMLButtonElement|null} */ (document.getElementById(id)); if(b) b.disabled = running; }
  const st = /** @type {HTMLButtonElement|null} */ (document.getElementById('tvStopBtn')); if(st){ st.hidden = !running; st.disabled = false; st.textContent = 'Stop'; }
}
// Starts a run: checks the page can run it and takes the shared "a job is running" flag. Returns the database or null.
async function begin(title){
  if(busy || getFiRunning()) return null;
  busy = true;   // taken first: the TradingView check below waits for an answer, and a second click meanwhile must not start a second run
  setFiPfx('tv_');
  const db = getFiDb();
  if(!getFiOwner() || !db){ busy = false; fiReset(title, STEPS); fiShowResult('err', [{ text: 'Only the owner can run this, and the database must be available in this view.' }], true); return null; }
  let connected = false;
  try { connected = !!(await tvMcp()); } catch(e){ console.error('TradingView connector check failed', e); }
  if(!connected){ busy = false; fiReset(title, STEPS); fiShowResult('err', [{ text: 'The TradingView connector is not available in this view.' }], true); return null; }
  stopAsked = false; setFiRunning(true); setButtons(true);
  fiReset(title, STEPS);
  return db;
}
function end(){ busy = false; setFiRunning(false); setButtons(false); }
function skippedReport(skipped, kind){
  const host = fiEl('fiResult'); if(!host || !skipped.length) return;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'select-mode-btn'; b.textContent = 'Download the ' + skipped.length + ' skipped stocks (.csv)';
  b.addEventListener('click', () => {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const csv = 'Ticker,Name,Reason\n' + skipped.map(x => [x.sym, x.name, x.reason].map(q).join(',')).join('\n');
    const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'skipped-' + kind + '-' + tvIstDate() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });
  host.appendChild(b);
}

// ---- 1. Refresh all stocks ----
async function runSnapshot(){
  const db = await begin('Refreshing all stocks from TradingView');
  if(!db) return;
  const today = tvIstDate();
  const lines = [], skipped = [];
  let updated = 0, kept = 0, scored = 0, unchanged = 0, stopped = false;
  try {
    fiSet('prepare', 'running', 'Reading the saved updates…', 0.3);
    // Which stocks already have a saved update. Without this list a save could not tell "change" from "create", and creating
    // REPLACES the whole record (the Global factors and research notes in it would be lost), so a run never goes on without it.
    const existing = new Set(), existingData = new Map();
    let listed = false;
    const t0 = Date.now();
    for(let attempt = 0; attempt < 2 && !listed; attempt++){
      try { const snap = await db.collection('stockUpdates').get(); snap.docs.forEach(d => { if(!d.exists) return; existing.add(d.id); try { existingData.set(d.id, d.data()); } catch(e){ /* compared only when readable */ } }); listed = true; }
      catch(e){ console.error('Could not list saved updates', e); if(attempt === 0) await sleep(1500); }
    }
    if(!listed) throw new Error('the saved updates could not be read, so nothing was changed (saving without them could overwrite research notes). Try again in a moment.');
    const todo = [];
    for(const s of stocks){
      const sym = snapshotSymbol(s);
      if(!sym) skipped.push({ sym: tickerSymbol(s), name: s.name, reason: 'BSE-only stock with no TradingView symbol saved yet' }); else todo.push({ s, sym });
    }
    fiSet('prepare', 'done', num(todo.length) + ' stocks' + (skipped.length ? ', ' + skipped.length + ' without a symbol' : ''));
    const batches = [];
    for(let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    // The next batch is requested while the current one is being saved. TradingView answers "Too Many Requests" when called back
    // to back, so a request waits until 300 ms after the previous one started (longer after a failed call).
    let lastStart = 0, backoff = 0;
    const fetchBatch = async (batch) => {
      const wait = Math.max(300, backoff) - (Date.now() - lastStart);
      backoff = 0;
      if(wait > 0) await sleep(wait);
      lastStart = Date.now();
      try { return { payload: await tvCall('mcp-tv-get-symbol-data-batch', { symbols: batch.map(x => x.sym), columns: COLS }) }; }
      catch(e){ return { error: e }; }
    };
    let pending = batches.length ? fetchBatch(batches[0]) : null;
    for(let bi = 0; bi < batches.length; bi++){
      if(stopAsked){ stopped = true; break; }
      const batch = batches[bi];
      fiSet('run', 'running', 'Batch ' + (bi + 1) + ' of ' + batches.length + ' · ' + num(updated + unchanged) + ' done', bi / batches.length);
      const res = await pending;
      pending = bi + 1 < batches.length && !stopAsked ? fetchBatch(batches[bi + 1]) : null;
      if(res.error){ batch.forEach(x => skipped.push({ sym: tickerSymbol(x.s), name: x.s.name, reason: tvErrorText(res.error) })); backoff = 1500; continue; }
      const payload = res.payload;
      const data = (payload && payload.data) || {};
      const writes = [];
      for(const { s, sym } of batch){
        const u = snapshotUpdate(s, data[sym], today, sym);
        if(u.reason){ skipped.push({ sym: tickerSymbol(s), name: s.name, reason: u.reason + ' (' + sym + ')' }); continue; }
        const body = { valuation: u.valuation }; if(u.technical) body.technical = u.technical; if(u.liquidity) body.liquidity = u.liquidity;
        writes.push({ id: sanitizeDocId(tickerSymbol(s)), body, s, kept: !!u.kept, scored: !!u.technical });
      }
      let w = 0;
      const worker = async () => {
        while(w < writes.length){
          const { id, body, s, kept: wasKept, scored: wasScored } = writes[w++];
          if(alreadySaved(existingData.get(id), body)){ unchanged++; continue; }
          try {
            const ref = db.doc('stockUpdates/' + id);
            // A stock missing from the list is checked once more just before it is created, in case a record appeared since.
            if(!existing.has(id)){ const cur = await ref.get(); if(cur && cur.exists) existing.add(id); }
            if(existing.has(id)) await ref.update(body); else { await ref.set(Object.assign({ ticker: tickerSymbol(s) }, body)); existing.add(id); }
            existingData.set(id, Object.assign({}, existingData.get(id), body));
            updated++; if(wasKept) kept++; if(wasScored) scored++;   // counted once saved, so a failed save never inflates the summary
          } catch(e){ skipped.push({ sym: tickerSymbol(s), name: s.name, reason: 'could not be saved: ' + String((e && e.message) || e).slice(0, 80) }); }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }
    fiSet('run', 'done', num(updated) + ' saved' + (unchanged ? ', ' + num(unchanged) + ' unchanged' : ''));
    fiSet('verify', 'done', '');
    lines.push({ text: (stopped ? 'Stopped. ' : '') + num(updated) + ' stocks refreshed: price saved for each, ' + num(scored) + ' technical scores updated, ' + num(kept) + ' kept their completed-week score (updated in the last 3 days).', cls: 'fi-line fi-line-strong' });
    if(unchanged) lines.push({ text: num(unchanged) + ' stocks already held exactly these figures (same price and scores), so they were not rewritten.', cls: 'fi-line' });
    lines.push({ text: 'Took ' + duration(Date.now() - t0) + '.', cls: 'fi-line fi-line-muted' });
    lines.push({ text: 'These scores include the week and month still in progress, so they can change before the week ends. Stocks with saved price bars get the stricter completed-weeks score when refreshed with the bar download.', cls: 'fi-line fi-line-muted' });
    if(skipped.length) lines.push({ text: num(skipped.length) + ' stocks skipped (listed in the file below).', cls: 'fi-line' });
    fiShowResult(updated + unchanged === 0 ? 'err' : 'ok', lines, true);
    skippedReport(skipped, 'snapshot');
  } catch(e){
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally { end(); }
}

// ---- 2. Fill missing history ----
// Stocks with no saved weekly bars, in the order they matter: tracked picks, then pinned / strategy matches / oldest.
async function missingHistoryOrder(){
  await ensureAllPriceBars();
  const missing = stocks.filter(s => { const h = priceHistoryByTicker[pcTickerKey(s)]; return !(h && h['1W'] && h['1W'].length); });
  const tracked = new Set();
  try { (await loadRuns()).forEach(r => (r.picks || []).forEach(p => { const s = stockByTickerSymbol.get(p.sym); if(s) tracked.add(s); })); } catch(e){ console.error('Could not read tracked picks', e); }
  const first = missing.filter(s => tracked.has(s)), rest = missing.filter(s => !tracked.has(s));
  return { missing, order: first.concat(priorityOrder('tech', rest)), trackedCount: first.length };
}
async function runHistory(){
  const db = await begin('Filling missing price history');
  if(!db) return;
  const failed = [];
  let done = 0, ok = 0, stopped = false;
  try {
    fiSet('prepare', 'running', 'Finding stocks without history…', 0.3);
    let tried = {};
    try { const t = await db.doc('stockMeta/histFillTried').get(); if(t && t.exists) tried = Object.assign({}, t.data() || {}); } catch(e){}
    const recent = id => tried[id] && Date.now() - (Date.parse(tried[id]) || 0) < SKIP_RETRY_DAYS * 86400000;
    const { missing, order, trackedCount } = await missingHistoryOrder();
    const eligible = order.filter(s => !recent(sanitizeDocId(tickerSymbol(s))));
    const list = eligible.slice(0, HISTORY_CAP);
    fiSet('prepare', 'done', num(missing.length) + ' without history' + (trackedCount ? ', ' + trackedCount + ' are tracked picks' : ''));
    if(!list.length){
      fiSet('run', 'done', ''); fiSet('verify', 'done', '');
      fiShowResult('ok', [{ text: missing.length ? 'Nothing to try now: the ' + missing.length + ' stocks still without history failed recently and are retried after ' + SKIP_RETRY_DAYS + ' days.' : 'Every stock already has saved price history.', cls: 'fi-line fi-line-strong' }], true);
      return;
    }
    let next = 0;
    const worker = async () => {
      while(next < list.length && !stopAsked){
        const s = list[next++], key = pcTickerKey(s), id = sanitizeDocId(tickerSymbol(s));
        await refreshOneNow(s);
        const j = priceJobs.get(key);
        if(j && j.state === 'ok'){ ok++; delete tried[id]; }
        else { failed.push({ sym: tickerSymbol(s), name: s.name, reason: (j && j.msg) || 'did not finish' }); tried[id] = new Date().toISOString(); }
        done++;
        fiSet('run', 'running', done + ' of ' + list.length + ' · ' + tickerSymbol(s), done / list.length);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    stopped = stopAsked && done < list.length;
    try { await db.doc('stockMeta/histFillTried').set(tried); } catch(e){ console.error('Could not save the skipped list', e); }
    fiSet('run', 'done', done + ' tried');
    fiSet('verify', 'done', '');
    const left = missing.length - ok;
    fiShowResult(failed.length === done && done > 0 ? 'err' : 'ok', [
      { text: (stopped ? 'Stopped. ' : '') + ok + ' of ' + done + ' stocks now have price history and a completed-weeks technical score.', cls: 'fi-line fi-line-strong' },
      { text: left > 0 ? num(left) + ' stocks still have none. Run this again to carry on with the next ' + HISTORY_CAP + '.' : 'Every stock now has saved price history.', cls: 'fi-line fi-line-muted' },
      ...(failed.length ? [{ text: failed.length + ' skipped (listed in the file below); they are retried after ' + SKIP_RETRY_DAYS + ' days.', cls: 'fi-line' }] : [])
    ], true);
    skippedReport(failed, 'history');
  } catch(e){
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: ok + ' stocks were completed before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally { end(); }
}

async function paintHint(){
  const el = document.getElementById('tvRefreshHint'); if(!el) return;
  try {
    await ensureAllPriceBars();
    const n = stocks.filter(s => { const h = priceHistoryByTicker[pcTickerKey(s)]; return !(h && h['1W'] && h['1W'].length); }).length;
    el.textContent = num(stocks.length - n) + ' of ' + num(stocks.length) + ' stocks have saved price history. ' + num(n) + ' have none.';
  } catch(e){ el.textContent = ''; }
}
function init_refresh_tvrefresh(){
  const on = (id, fn) => { const b = document.getElementById(id); if(b) b.addEventListener('click', fn); };
  on('tvSnapshotBtn', () => runSnapshot().then(paintHint));
  on('tvHistoryBtn', () => runHistory().then(paintHint));
  on('tvStopBtn', () => { stopAsked = true; const b = /** @type {HTMLButtonElement|null} */ (document.getElementById('tvStopBtn')); if(b){ b.disabled = true; b.textContent = 'Stopping…'; } });
}

export { init_refresh_tvrefresh };
