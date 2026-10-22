// "Refresh all stocks" on the Data Refresh screen (Technical Score section): the one daily route, straight from TradingView.
//  1. Stocks with no saved bars: the full history (about 5 years, up to today) and the completed-weeks score, tracked picks first,
//     then pinned, strategy matches and the rest, a couple of stocks at a time. Stop ends the run; the next run carries on.
//  2. Snapshot of every stock: price, MACD and RSI (weekly, monthly), 50 stocks per call. One record per batch of 50 stocks is saved in
//     liveSnapshot (see overlays/livesnapshot.js), not one per stock: the database takes about 1.5 saves a second, so about 44 saves replace
//     about 2,000. TradingView's figures include the week and month still in progress, so a stock whose saved block was built from
//     completed bars in the last 3 days keeps that block (only its price is updated). It is only about 44 calls, so it goes before the long step.
//  3. Stocks with saved bars: only when a weekly or monthly bar has finished since the newest saved one (see historyplan.js), just the new bars,
//     several stocks at a time (TradingView returns bars for one symbol per call, so they cannot be batched), and only the bar type that is out of
//     date (the monthly bar is fetched once a month, not every week). This is the long step and may run into TradingView's daily call quota; the
//     stocks not reached stay out of date and the next run carries on with them.
import { stocks, stockByTickerSymbol } from '../core/stocks.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { COLS, packValues, snapshotUpdate } from '../overlays/livesnapshot.js';
import { priceHistoryByTicker, pcTickerKey, ensureAllPriceBars } from '../prices/store.js';
import { refreshOneNow, priceJobs, saveFullBars } from '../prices/refresh.js';
import { COMPACT_LAG, lagOf } from '../prices/recent.js';
import { saveRecentBars, saveTechBlocks, sameValue } from './barchunks.js';
import { isinOf, isinSymbolCached, useSavedSymbols } from '../tv/isin.js';
import { tvCall, tvErrorText, tvIsFatal, tvIsQuota, tvIstDate, tvMcp } from '../tv/connector.js';
import { loadRuns } from '../strategies/tracking.js';
import { priorityOrder } from './freshness.js';
import { planHistory, alignBars, batchBars, weekStartS, monthStartS, BAR_COLUMNS, TOLERANCE } from './historyplan.js';
import { buildTech2Chunks } from '../engine/techscore2.js';
import { debugHandle } from '../boot/handoff.js';
import { getFiDb, getFiOwner, getFiRunning, setFiRunning } from '../import/fund-import.js';
import { fiEl, fiReset, fiSet, fiShowResult, setFiPfx } from '../import/panel.js';
import { registerBusy } from '../core/busy.js';
import { duration, paintLastRuns, saveRunLog } from './runlog.js';

const BATCH = 50;                 // symbols per TradingView call (the tool's limit)
const SKIP_RETRY_DAYS = 14;       // a stock whose history download failed is not tried again for this long
const FULL_WORKERS = 2;           // stocks whose full history is downloaded at the same time (a big download each)
const BAR_WORKERS = 4;            // stocks given just their new bars at the same time, one TradingView call each
const COMPACT_MAX = 100;          // stocks per run whose own price documents are rewritten in full (see prices/recent.js)
// Test hook: the browser tests switch the history stages off (the made-up database has no history for any stock, so every run would download all of it).
const skipHistory = () => !!debugHandle().skipHistoryStage;
const STEPS = [{ key: 'prepare', label: 'Prepare the stock list', w: 5 }, { key: 'fill', label: 'Full history for stocks that have none', w: 30 },
  { key: 'run', label: 'Fetch from TradingView: snapshot and new bars', w: 25 }, { key: 'update', label: 'Save the weekly and monthly bars in batches', w: 20 },
  { key: 'tech', label: 'Technical scores in batches', w: 15 }, { key: 'verify', label: 'Finish', w: 5 }];

// The TradingView symbol for a stock: its ISIN is in the database, and the symbol is the one the last run saved for it (see tv/isin.js). No TradingView search is made. null when it has none.
const snapshotSymbol = isinSymbolCached;
let stopAsked = false;
let busy = false;
registerBusy(() => busy);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => x.toLocaleString('en-IN');

function setButtons(running){
  const b = /** @type {HTMLButtonElement|null} */ (document.getElementById('tvSnapshotBtn')); if(b) b.disabled = running;
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
  const t0 = Date.now(), startedAt = new Date().toISOString(), batchSecs = [];
  let tvWaitMs = 0, saveMs = 0, planned = 0, chunksSaved = 0, runError = '';
  let retried = 0, answeredAgain = 0, carried = 0, noSymbol = [];
  let tech2Saved = 0, tech2Failed = 0;
  let batchSaved = 0, chunkWrites = 0, compacted = 0, techBlocksSaved = 0, filled = 0, barsUpdated = 0, histFailed = 0, noneBefore = 0, staleBefore = 0, noHistoryLeft = 0, histRan = false;
  try {
    // One cheap call first: if TradingView is refusing the dashboard's calls (quota, connection), the run stops here at once, with TradingView's message, before reading anything.
    // A refusal is tried once more after a few seconds, in case it was short.
    fiSet('prepare', 'running', 'Checking TradingView…', 0.1);
    try { await tvCall('mcp-tv-get-symbol-data', { symbol: 'NSE:TCS', columns: ['close'] }); }
    catch(e){
      if(tvIsQuota(e) && !stopAsked){ fiSet('prepare', 'running', 'TradingView refused the call; trying once more in 8 seconds…', 0.1); await sleep(8000); await tvCall('mcp-tv-get-symbol-data', { symbol: 'NSE:TCS', columns: ['close'] }); }
      else throw e;
    }
    fiSet('prepare', 'running', 'Reading the saved updates…', 0.3);
    // The chunks saved by the last run, so a batch that came back exactly the same is not written again. A failed read only means every chunk is written.
    const stored = new Map();
    try { const snap = await db.collection('liveSnapshot').get(); snap.docs.forEach(d => { if(d.exists) stored.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved snapshot', e); }
    // The last good row of every stock, with the day it is from, so a stock TradingView does not answer for today keeps its figures instead of losing them.
    const prevRows = new Map();
    stored.forEach(c => { if(c && Array.isArray(c.rows)) c.rows.forEach(r => { if(r && typeof r.k === 'string' && Array.isArray(r.c)) prevRows.set(r.k, { y: r.y, c: r.c, d: r.d || c.asof, t: r.t || c.at }); }); });
    fiSet('prepare', 'running', 'Using the saved TradingView symbols…', 0.5);
    await useSavedSymbols(stocks, s => { const p = prevRows.get(sanitizeDocId(tickerSymbol(s))); return p ? p.y : null; });
    const todo = [];
    for(const s of stocks){
      const sym = snapshotSymbol(s);
      if(!sym){ skipped.push({ sym: tickerSymbol(s), name: s.name, reason: isinOf(s) ? 'No saved TradingView symbol (open the stock and press Refresh once)' : 'No ISIN saved (import the Fundamental CSV)' }); noSymbol.push(tickerSymbol(s) + ' ' + s.name); } else todo.push({ s, sym });
    }
    fiSet('prepare', 'done', num(todo.length) + ' stocks' + (skipped.length ? ', ' + skipped.length + ' without a symbol' : ''));
    planned = todo.length;
    // ---- 1. full history for stocks that have none (a few calls, so it always fits in the daily quota) ----
    /** @type {any} */
    let ctx = null;
    /** @type {Record<string, number>} */
    const batchLeft = {};   // why stocks were left for the one-by-one fetch
    if(stopAsked || skipHistory()){ stopped = stopped || stopAsked; fiSet('fill', 'done', 'skipped'); }
    else {
      histRan = true;
      fiSet('fill', 'running', 'Looking at the saved bars…', 0.1);
      await ensureAllPriceBars();
      const plan = planHistory(stocks, s => priceHistoryByTicker[pcTickerKey(s)], Date.now() / 1000);
      noneBefore = plan.none.length; staleBefore = plan.stale.length;
      const tracked = new Set();
      try { (await loadRuns()).forEach(r => (r.picks || []).forEach(p => { const s = stockByTickerSymbol.get(p.sym); if(s) tracked.add(s); })); } catch(e){ console.error('Could not read tracked picks', e); }
      const byImportance = list => list.filter(s => tracked.has(s)).concat(priorityOrder('tech', list.filter(s => !tracked.has(s))));
      let tried = {};
      try { const tr = await db.doc('stockMeta/histFillTried').get(); if(tr && tr.exists) tried = Object.assign({}, tr.data() || {}); } catch(e){ /* the list only spares stocks that failed recently */ }
      const recent = id => tried[id] && Date.now() - (Date.parse(tried[id]) || 0) < SKIP_RETRY_DAYS * 86400000;
      const noneList = byImportance(plan.none).filter(s => !recent(sanitizeDocId(tickerSymbol(s))));
      const failedBars = [];
      ctx = { plan, byImportance, failedBars, abort: '' };   // abort: set when TradingView refuses every call (quota used up, not connected) or fails many in a row: no point trying the rest
      let barsFailRun = 0;
      // Counts the outcome of one stock's bar job; stops the stage when TradingView refuses every call or fails many in a row.
      const settle = (s, track) => {
        const j = priceJobs.get(pcTickerKey(s)), id = sanitizeDocId(tickerSymbol(s));
        if(j && j.state === 'ok'){ barsFailRun = 0; if(track) delete tried[id]; return true; }
        failedBars.push({ sym: tickerSymbol(s), name: s.name, reason: 'price bars: ' + ((j && j.msg) || 'did not finish') });
        const refused = /quota|exhausted|not available in this view|not connected|reconnected|not allowed/i.test((j && j.msg) || '');
        if(track && !refused) tried[id] = new Date().toISOString();   // a refusal (quota, no connection) says nothing about the stock, so it is tried again next run
        if(refused || ++barsFailRun >= 8) ctx.abort = (j && j.msg) || 'price bars failed 8 times in a row';
        return false;
      };
      // Runs `task` over the list with `workers` stocks at a time; prog = { done, total } feeds the progress line.
      const pool = async (list, key, workers, prog, task, stockOf = x => x) => {
        let next = 0, ok = 0;
        const worker = async () => {
          while(next < list.length && !stopAsked && !ctx.abort){
            const s = list[next++];
            if(await task(s)) ok++;
            prog.done++;
            fiSet(key, 'running', num(prog.done) + ' of ' + num(prog.total) + ' · ' + tickerSymbol(stockOf(s)), prog.done / prog.total);
          }
        };
        await Promise.all(Array.from({ length: workers }, worker));
        return ok;
      };
      const bars = (list, key, track, workers, lean, prog) => pool(list, key, workers, prog || { done: 0, total: list.length }, async s => { await refreshOneNow(s, lean); return settle(s, track); });
      // Stocks one bar behind need no call of their own: the snapshot call (stage 2) also asks for their current and previous weekly and monthly bar
      // (50 stocks per call). `jobs` says which stocks that applies to; stage 2 fills `ready` with the bars it could place with certainty, and the
      // rest (longer gap, adjusted prices, no answer) are left for the one-by-one fetch.
      const nowS = Date.now() / 1000;
      ctx.jobs = new Map(); ctx.ready = new Map(); ctx.nowS = nowS;
      for(const s of plan.stale){
        const h = priceHistoryByTicker[pcTickerKey(s)], sym = snapshotSymbol(s);
        if(h && h['1W'] && h['1W'].length && h['1M'] && h['1M'].length && sym) ctx.jobs.set(s, { h, needW: h['1W'][h['1W'].length - 1][0] < weekStartS(nowS) - TOLERANCE, needM: h['1M'][h['1M'].length - 1][0] < monthStartS(nowS) - TOLERANCE });
      }
      batchLeft.noSymbol = plan.stale.length - ctx.jobs.size;   // no saved bars or no TradingView symbol: not eligible
      ctx.pool = pool; ctx.settle = settle;
      ctx.bars = bars;
      if(noneList.length) filled = await bars(noneList, 'fill', true, FULL_WORKERS);
      if(noneList.length){ try { await db.doc('stockMeta/histFillTried').set(tried); } catch(e){ console.error('Could not save the skipped list', e); } }
      fiSet('fill', 'done', noneBefore ? num(filled) + ' of ' + num(noneBefore) + ' downloaded' : 'none needed');
      if(stopAsked) stopped = true;
      if(ctx.abort){ stopped = true; runError = ctx.abort; }
    }
    // ---- 2. snapshot of every stock, 50 per call (about 44 calls, and it is what the screens show every day, so it goes before the long bar update) ----
    const snapCols = ctx ? COLS.concat(BAR_COLUMNS) : COLS;   // with the bars of the stocks that need them, in the same call
    const batches = [];
    for(let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    // The next batch is requested while the current one is being saved. TradingView answers "Too Many Requests" when called back
    // to back, so a request waits until 300 ms after the previous one started (longer after a failed call).
    let lastStart = 0, backoff = 0, failedBatches = 0;
    const fetchBatch = async (batch) => {
      const wait = Math.max(300, backoff) - (Date.now() - lastStart);
      backoff = 0;
      if(wait > 0) await sleep(wait);
      lastStart = Date.now();
      try { return { payload: await tvCall('mcp-tv-get-symbol-data-batch', { symbols: batch.map(x => x.sym), columns: snapCols }) }; }
      catch(e){ return { error: e }; }
    };
    let pending = batches.length && !stopAsked ? fetchBatch(batches[0]) : null;
    for(let bi = 0; bi < batches.length; bi++){
      if(stopAsked){ stopped = true; break; }
      const batch = batches[bi], b0 = Date.now();
      fiSet('run', 'running', 'Batch ' + (bi + 1) + ' of ' + batches.length + ' · ' + num(updated + unchanged) + ' done', bi / batches.length);
      const w0 = Date.now();
      const res = await pending;
      tvWaitMs += Date.now() - w0;
      pending = bi + 1 < batches.length && !stopAsked ? fetchBatch(batches[bi + 1]) : null;
      if(res.error && tvIsFatal(res.error)) throw res.error;
      if(res.error && ++failedBatches >= 3){ const e = new Error(tvErrorText(res.error) + ' Three batches in a row failed, so the run stopped.'); throw e; }
      if(!res.error) failedBatches = 0;
      if(res.error){ batch.forEach(x => skipped.push({ sym: tickerSymbol(x.s), name: x.s.name, reason: tvErrorText(res.error) })); backoff = 1500; batchSecs.push(Math.round((Date.now() - b0) / 100) / 10); continue; }
      const payload = res.payload;
      const data = Object.assign({}, (payload && payload.data) || {});
      // A stock TradingView leaves out of an answer is usually a one-off miss: ask again for just those symbols before giving up.
      const priced = x => data[x.sym] && typeof data[x.sym].close === 'number' && data[x.sym].close > 0;
      const lacking = batch.filter(x => !priced(x));
      if(lacking.length && !stopAsked){
        await sleep(1000);
        try { const again = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: lacking.map(x => x.sym), columns: snapCols }); Object.assign(data, (again && again.data) || {}); retried += lacking.length; answeredAgain += lacking.filter(priced).length; } catch(e){ console.error('Retry of the missing stocks failed', e); }
        lastStart = Date.now();
      }
      const rows = [];
      let rowScored = 0, rowKept = 0;
      for(const { s, sym } of batch){
        const k = sanitizeDocId(tickerSymbol(s));
        const u = snapshotUpdate(s, data[sym], today, sym, s.technical);
        if(u.reason){
          const prev = prevRows.get(k);
          if(prev){ rows.push({ k, y: prev.y, c: prev.c, d: prev.d, t: prev.t }); carried++; skipped.push({ sym: tickerSymbol(s), name: s.name, reason: u.reason + ' (' + sym + '): kept its figures from ' + prev.d }); }
          else skipped.push({ sym: tickerSymbol(s), name: s.name, reason: u.reason + ' (' + sym + ')' });
          continue;
        }
        rows.push({ k, y: sym, c: packValues(data[sym]) });
        if(u.technical) rowScored++; if(u.kept) rowKept++;
      }
      if(ctx) for(const { s, sym } of batch){
        const j = ctx.jobs.get(s); if(!j) continue;
        const row = data[sym];
        const bw = j.needW ? batchBars(row, 'W') : null, bm = j.needM ? batchBars(row, 'M') : null;
        const W = j.needW ? alignBars(j.h['1W'], bw, 'W', ctx.nowS) : j.h['1W'];
        const M = j.needM ? alignBars(j.h['1M'], bm, 'M', ctx.nowS) : j.h['1M'];
        if(W && M) ctx.ready.set(s, { s, W, M, w: j.needW, m: j.needM });
        else { const k = !row ? 'noAnswer' : ((j.needW && !bw) || (j.needM && !bm)) ? 'missing' : 'unclear'; batchLeft[k] = (batchLeft[k] || 0) + 1; }
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
    // ---- 3. new weekly / monthly bars for stocks whose bars are out of date: the long part (one call per bar type per stock), so it is last. It can run out of
    // the daily quota; the stocks not reached stay out of date and the next run carries on with them. ----
    if(ctx){
      if(stopAsked) stopped = true;
      if(!stopped && ctx.plan.stale.length){
        const ordered = ctx.byImportance(ctx.plan.stale);
        const readyList = ordered.filter(s => ctx.ready.has(s)).map(s => ctx.ready.get(s));
        let left = ordered.filter(s => !ctx.ready.has(s));
        const unseen = left.filter(s => ctx.jobs.has(s)).length - Object.keys(batchLeft).filter(k => k !== 'noSymbol' && k !== 'callFailed').reduce((n, k) => n + batchLeft[k], 0);
        if(unseen > 0) batchLeft.callFailed = (batchLeft.callFailed || 0) + unseen;   // the snapshot call for them did not happen or failed
        // Step 2: the new bars of every stock, 50 stocks to a record
        fiSet('update', 'running', 'Saving the bars in batches…', 0.05);
        const rb = await saveRecentBars(db, readyList, (d, n) => fiSet('update', 'running', num(d) + ' of ' + num(n) + ' batches', d / n));
        const savedList = readyList.filter(r => rb.saved.has(pcTickerKey(r.s)));
        batchSaved = savedList.length; barsUpdated = batchSaved; chunkWrites += rb.chunksWritten;
        left = left.concat(readyList.filter(r => rb.failed.has(pcTickerKey(r.s))).map(r => r.s));
        // A few stocks per run get their own price documents rewritten in full, so the records never have to reach back further than they keep (see prices/recent.js).
        const lagging = stocks.map(s => ({ s, lag: lagOf(pcTickerKey(s), (priceHistoryByTicker[pcTickerKey(s)] || {})['1W']) })).filter(x => x.lag >= COMPACT_LAG).sort((a, b) => b.lag - a.lag).slice(0, COMPACT_MAX);
        if(lagging.length && !stopAsked){
          fiSet('update', 'running', 'Rewriting ' + num(lagging.length) + ' stocks in full…', 0.9);
          for(const { s } of lagging){ if(stopAsked || ctx.abort) break; const h = priceHistoryByTicker[pcTickerKey(s)]; if(await saveFullBars(s, h['1W'], h['1M'])) compacted++; }
        }
        // Step 3: the technical scores of those stocks, 50 stocks to a record
        fiSet('update', 'done', num(batchSaved) + ' stocks in ' + num(rb.records) + ' batches' + (rb.chunksWritten < rb.records ? ' (' + num(rb.records - rb.chunksWritten) + ' unchanged)' : ''));
        fiSet('tech', 'running', 'Calculating…', 0.05);
        const tb = await saveTechBlocks(db, savedList, tvIstDate(), (d, n) => fiSet('tech', 'running', num(d) + ' of ' + num(n) + ' batches', d / n));
        techBlocksSaved = tb.computed; chunkWrites += tb.chunksWritten;
        fiSet('tech', 'done', num(tb.computed) + ' scores in ' + num(tb.records) + ' batches' + (tb.failed ? ', ' + tb.failed + ' could not be saved' : ''));
        // The stocks the snapshot could not place with certainty are fetched one by one, as before.
        if(!stopAsked && !ctx.abort && left.length){
          fiSet('update', 'running', 'The rest one by one…', 0.95);
          barsUpdated += await ctx.bars(left, 'update', false, BAR_WORKERS, true, { done: 0, total: left.length });
          fiSet('update', 'done', num(batchSaved) + ' in batches, ' + num(left.length) + ' one by one');
        }
      } else { fiSet('tech', 'done', stopped ? 'skipped' : 'none needed'); }
      if(stopAsked) stopped = true;
      if(!ctx.plan.stale.length || stopped) fiSet('update', 'done', staleBefore ? num(barsUpdated) + ' of ' + num(staleBefore) + ' updated' : 'all up to date');
      if(ctx.abort){ stopped = true; runError = ctx.abort; }
      histFailed = ctx.failedBars.length;
      noHistoryLeft = noneBefore - filled;
      ctx.failedBars.forEach(x => skipped.push(x));
    } else { fiSet('update', 'done', 'skipped'); fiSet('tech', 'done', 'skipped'); }
    // ---- Technical Score 2: from the saved weekly bars, a few records ----
    if(histRan && !stopped){
      fiSet('verify', 'running', 'Calculating Technical Score 2…', 0.5);
      try {
        const chunks = buildTech2Chunks(stocks, s => (priceHistoryByTicker[pcTickerKey(s)] || {})['1W'], today);
        const oldT2 = new Map();
        try { const snap = await db.collection('techScore2').get(); snap.docs.forEach(d => { if(d.exists) oldT2.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved Tech 2 scores', e); }
        for(const { id, doc } of chunks){
          const old = oldT2.get(id);
          if(old && old.asof === today && sameValue(old.rows, doc.rows)){ tech2Saved += doc.rows.length; continue; }
          let saved = false;
          for(let attempt = 0; attempt < 2 && !saved; attempt++){
            try { await db.doc('techScore2/' + id).set(doc); saved = true; } catch(e){ if(attempt === 0) await sleep(1500); else console.error('Could not save Tech 2 ' + id, e); }
          }
          if(saved) tech2Saved += doc.rows.length; else tech2Failed += doc.rows.length;
        }
      } catch(e){ console.error('Technical Score 2 failed', e); tech2Failed = -1; }
    }
    fiSet('verify', 'done', '');
    // The result: a heading and short bullets with the % done where it means something; problems only when there are some.
    const pct = (a, n) => n > 0 ? ' (' + Math.min(100, Math.round(100 * a / n)) + '%)' : '';
    const B = (text, strong) => lines.push({ text: '• ' + text, cls: strong ? 'fi-line fi-bullet fi-line-strong' : 'fi-line fi-bullet' });
    lines.push({ text: (stopped ? 'Stopped after ' : updated + unchanged === 0 ? 'Nothing saved, ' : 'Done in ') + duration(Date.now() - t0), cls: 'fi-line fi-line-strong' });
    if(runError) B('Stopped because: ' + runError, true);
    B('Prices and snapshot: ' + num(updated + unchanged) + ' of ' + num(planned) + ' stocks' + pct(updated + unchanged, planned) + (unchanged ? ', ' + num(unchanged) + ' unchanged' : ''));
    if(histRan){
      if(noneBefore) B('Full history: ' + num(filled) + ' of ' + num(noneBefore) + ' stocks' + pct(filled, noneBefore));
      B('Weekly and monthly bars: ' + num(barsUpdated) + ' of ' + num(staleBefore) + ' stocks' + pct(barsUpdated, staleBefore) + (barsUpdated > batchSaved ? ' (' + num(barsUpdated - batchSaved) + ' one by one)' : ''));
      B('Technical scores (completed weeks): ' + num(techBlocksSaved + Math.max(0, barsUpdated - batchSaved)) + ' calculated');
      if(tech2Failed !== -1 && !stopped) B('Technical Score 2: ' + num(tech2Saved) + ' of ' + num(stocks.length) + ' stocks' + pct(tech2Saved, stocks.length) + (tech2Failed ? ', ' + num(tech2Failed) + ' not saved' : ''));
      if(tech2Failed === -1) B('Technical Score 2 could not be calculated', true);
    }
    if(noSymbol.length) B(num(noSymbol.length) + ' stocks without a TradingView symbol: ' + noSymbol.slice(0, 3).join(', ') + (noSymbol.length > 3 ? ' …' : ''));
    if(carried) B(num(carried) + ' stocks had no price today and kept an earlier one');
    if(skipped.length){
      const why = new Map(); skipped.forEach(x => { const r = String(x.reason).replace(/\([A-Z]+:[^)]*\)/g, '').replace(/from \d{4}-\d\d-\d\d/, '').trim(); why.set(r, (why.get(r) || 0) + 1); });
      const top = [...why.entries()].sort((a, b) => b[1] - a[1])[0];
      B(num(skipped.length) + ' stocks skipped, mostly: ' + top[0].slice(0, 90) + ' (list below)');
    }
    fiShowResult(updated + unchanged === 0 ? 'err' : 'ok', lines, true);
    skippedReport(skipped, 'snapshot');
  } catch(e){
    runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    await saveRunLog(db, 'snapshot', startedAt, t0, { planned, batches: batchSecs.length, saved: updated, unchanged, scored, kept, skipped: skipped.length, stopped, error: runError || null, chunks: chunksSaved, retried, answeredAgain, carried, noSymbol: noSymbol.length, filled, barsUpdated, batchSaved, chunkWrites, compacted, techBlocksSaved, historyFailed: histFailed, noHistoryLeft: histRan ? noHistoryLeft : null, v: 5, tech2: tech2Saved, tvWaitSecs: Math.round(tvWaitMs / 100) / 10, saveSecs: Math.round(saveMs / 100) / 10, batchSecs });
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
  on('tvStopBtn', () => { stopAsked = true; const b = /** @type {HTMLButtonElement|null} */ (document.getElementById('tvStopBtn')); if(b){ b.disabled = true; b.textContent = 'Stopping…'; } });
}

export { init_refresh_tvrefresh };
