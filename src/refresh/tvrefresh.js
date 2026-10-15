// "Refresh from TradingView" on the Data Refresh screen (Technical Score section): no CSV needed.
//  1. Refresh all stocks: one TradingView snapshot of price, MACD and RSI (weekly, monthly) for every stock, 50 per call.
//     It saves one record per batch of 50 stocks in liveSnapshot (see overlays/livesnapshot.js), not one per stock: the database
//     takes about 1.5 saves a second, so about 44 saves replace about 2,000.
//     TradingView's figures include the week and month still in progress, so a stock whose saved block was built from completed
//     bars in the last 3 days keeps that block (only its price is updated).
//  2. Fill missing history: downloads weekly and monthly bars for stocks that have none saved (tracked picks first, then pinned,
//     then strategy matches, then the rest), all of them in one run (Stop ends it early; a later run carries on).
import { stocks, stockByTickerSymbol } from '../core/stocks.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { COLS, packValues, snapshotUpdate } from '../overlays/livesnapshot.js';
import { priceHistoryByTicker, pcTickerKey, priceSymbolByTicker, ensureAllPriceBars } from '../prices/store.js';
import { refreshOneNow, priceJobs } from '../prices/refresh.js';
import { BSE_ALPHA_MAP } from '../tv/links.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp } from '../tv/connector.js';
import { loadRuns } from '../strategies/tracking.js';
import { priorityOrder } from './freshness.js';
import { getFiDb, getFiOwner, getFiRunning, setFiRunning } from '../import/fund-import.js';
import { fiEl, fiReset, fiSet, fiShowResult, setFiPfx } from '../import/panel.js';
import { registerBusy } from '../core/busy.js';
import { duration, paintLastRuns, saveRunLog } from './runlog.js';

const BATCH = 50;                 // symbols per TradingView call (the tool's limit)
const SKIP_RETRY_DAYS = 14;       // a stock that failed history fill is not retried for this long
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
let stopAsked = false;
let busy = false;
registerBusy(() => busy);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => x.toLocaleString('en-IN');
// Compares two saved values by content, whatever order their keys are in.
function stable(x){ return x && typeof x === 'object' ? (Array.isArray(x) ? x.map(stable) : Object.keys(x).sort().reduce((o, k) => { o[k] = stable(x[k]); return o; }, {})) : x; }
const sameValue = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

function setButtons(running, kind){
  for(const id of ['tvSnapshotBtn', 'tvHistoryBtn']){ const b = /** @type {HTMLButtonElement|null} */ (document.getElementById(id)); if(b) b.disabled = running; }
  for(const [id, k] of [['tvStopBtn', 'snapshot'], ['thStopBtn', 'history']]){
    const st = /** @type {HTMLButtonElement|null} */ (document.getElementById(id)); if(st){ st.hidden = !(running && kind === k); st.disabled = false; st.textContent = 'Stop'; }
  }
}
// Starts a run: checks the page can run it and takes the shared "a job is running" flag. Returns the database or null.
async function begin(title, pfx, kind){
  if(busy || getFiRunning()) return null;
  busy = true;   // taken first: the TradingView check below waits for an answer, and a second click meanwhile must not start a second run
  setFiPfx(pfx);
  const db = getFiDb();
  if(!getFiOwner() || !db){ busy = false; fiReset(title, STEPS); fiShowResult('err', [{ text: 'Only the owner can run this, and the database must be available in this view.' }], true); return null; }
  let connected = false;
  try { connected = !!(await tvMcp()); } catch(e){ console.error('TradingView connector check failed', e); }
  if(!connected){ busy = false; fiReset(title, STEPS); fiShowResult('err', [{ text: 'The TradingView connector is not available in this view.' }], true); return null; }
  stopAsked = false; setFiRunning(true); setButtons(true, kind);
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
  const db = await begin('Refreshing all stocks from TradingView', 'tv_', 'snapshot');
  if(!db) return;
  const today = tvIstDate();
  const lines = [], skipped = [];
  let updated = 0, kept = 0, scored = 0, unchanged = 0, stopped = false;
  const t0 = Date.now(), startedAt = new Date().toISOString(), batchSecs = [];
  let tvWaitMs = 0, saveMs = 0, planned = 0, chunksSaved = 0, runError = '';
  try {
    fiSet('prepare', 'running', 'Reading the saved updates…', 0.3);
    // The chunks saved by the last run, so a batch that came back exactly the same is not written again. A failed read only means every chunk is written.
    const stored = new Map();
    try { const snap = await db.collection('liveSnapshot').get(); snap.docs.forEach(d => { if(d.exists) stored.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved snapshot', e); }
    const todo = [];
    for(const s of stocks){
      const sym = snapshotSymbol(s);
      if(!sym) skipped.push({ sym: tickerSymbol(s), name: s.name, reason: 'BSE-only stock with no TradingView symbol saved yet' }); else todo.push({ s, sym });
    }
    fiSet('prepare', 'done', num(todo.length) + ' stocks' + (skipped.length ? ', ' + skipped.length + ' without a symbol' : ''));
    planned = todo.length;
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
      const batch = batches[bi], b0 = Date.now();
      fiSet('run', 'running', 'Batch ' + (bi + 1) + ' of ' + batches.length + ' · ' + num(updated + unchanged) + ' done', bi / batches.length);
      const w0 = Date.now();
      const res = await pending;
      tvWaitMs += Date.now() - w0;
      pending = bi + 1 < batches.length && !stopAsked ? fetchBatch(batches[bi + 1]) : null;
      if(res.error){ batch.forEach(x => skipped.push({ sym: tickerSymbol(x.s), name: x.s.name, reason: tvErrorText(res.error) })); backoff = 1500; batchSecs.push(Math.round((Date.now() - b0) / 100) / 10); continue; }
      const payload = res.payload;
      const data = (payload && payload.data) || {};
      const rows = [];
      let rowScored = 0, rowKept = 0;
      for(const { s, sym } of batch){
        const u = snapshotUpdate(s, data[sym], today, sym, s.technical);
        if(u.reason){ skipped.push({ sym: tickerSymbol(s), name: s.name, reason: u.reason + ' (' + sym + ')' }); continue; }
        rows.push({ k: sanitizeDocId(tickerSymbol(s)), y: sym, c: packValues(data[sym]) });
        if(u.technical) rowScored++; if(u.kept) rowKept++;
      }
      const s0 = Date.now();
      if(rows.length){
        const id = 'c' + String(bi + 1).padStart(3, '0');
        const old = stored.get(id);
        if(old && old.asof === today && sameValue(old.rows, rows)){ unchanged += rows.length; }
        else {
          const doc = { v: 1, asof: today, at: new Date().toISOString(), rows };
          let saved = false, err = null;
          for(let attempt = 0; attempt < 2 && !saved; attempt++){
            try { await db.doc('liveSnapshot/' + id).set(doc); saved = true; } catch(e){ err = e; if(attempt === 0) await sleep(1500); }
          }
          if(saved){ stored.set(id, doc); updated += rows.length; scored += rowScored; kept += rowKept; chunksSaved++; }
          else { const why = 'could not be saved: ' + String((err && err.message) || err).slice(0, 80); batch.forEach(x => { if(rows.some(r => r.k === sanitizeDocId(tickerSymbol(x.s)))) skipped.push({ sym: tickerSymbol(x.s), name: x.s.name, reason: why }); }); }
        }
      }
      saveMs += Date.now() - s0;
      batchSecs.push(Math.round((Date.now() - b0) / 100) / 10);
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
    runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    await saveRunLog(db, 'snapshot', startedAt, t0, { planned, batches: batchSecs.length, saved: updated, unchanged, scored, kept, skipped: skipped.length, stopped, error: runError || null, chunks: chunksSaved, v: 2, tvWaitSecs: Math.round(tvWaitMs / 100) / 10, saveSecs: Math.round(saveMs / 100) / 10, batchSecs });
    end();
    paintLastRuns(db);
  }
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
  const db = await begin('Filling missing price history', 'th_', 'history');
  if(!db) return;
  const failed = [];
  let done = 0, ok = 0, stopped = false, planned = 0, missingBefore = 0, runError = '';
  const t0 = Date.now(), startedAt = new Date().toISOString();
  try {
    fiSet('prepare', 'running', 'Finding stocks without history…', 0.3);
    let tried = {};
    try { const t = await db.doc('stockMeta/histFillTried').get(); if(t && t.exists) tried = Object.assign({}, t.data() || {}); } catch(e){}
    const recent = id => tried[id] && Date.now() - (Date.parse(tried[id]) || 0) < SKIP_RETRY_DAYS * 86400000;
    const { missing, order, trackedCount } = await missingHistoryOrder();
    const eligible = order.filter(s => !recent(sanitizeDocId(tickerSymbol(s))));
    const list = eligible;
    planned = list.length; missingBefore = missing.length;
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
      { text: left > 0 ? num(left) + ' stocks still have none (they failed and are retried later).' : 'Every stock now has saved price history.', cls: 'fi-line fi-line-muted' },
      ...(failed.length ? [{ text: failed.length + ' skipped (listed in the file below); they are retried after ' + SKIP_RETRY_DAYS + ' days.', cls: 'fi-line' }] : [])
    ], true);
    skippedReport(failed, 'history');
  } catch(e){
    runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: ok + ' stocks were completed before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    if(planned > 0 || runError) await saveRunLog(db, 'history', startedAt, t0, { planned, missingBefore, tried: done, saved: ok, failed: failed.length, stopped, error: runError || null });
    end();
    paintLastRuns(db);
  }
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
  for(const id of ['tvStopBtn', 'thStopBtn']) on(id, () => { stopAsked = true; const b = /** @type {HTMLButtonElement|null} */ (document.getElementById(id)); if(b){ b.disabled = true; b.textContent = 'Stopping…'; } });
}

export { init_refresh_tvrefresh };
