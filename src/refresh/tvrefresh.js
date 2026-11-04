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
import { sanitizeDocId, sleep, tickerSymbol } from '../core/util.js';
import { COLS } from '../overlays/livesnapshot.js';
import { priceHistoryByTicker, pcTickerKey, ensureAllPriceBars } from '../prices/store.js';
import { refreshOneNow, priceJobs, saveFullBars } from '../prices/refresh.js';
import { COMPACT_LAG, lagOf } from '../prices/recent.js';
import { saveCrossStates, saveDailyStates, saveRecentBars, saveTechBlocks, sameValue } from './barchunks.js';
import { dailyChoice, wireDailyPicker } from './dailypick.js';
import { DAILY_BAR_COLUMNS } from './dailybatch.js';
import { dailyReportLine, dailyStocksOf, readDailyStates } from './dailymacd.js';
import { loadDailyBars, saveDailyBars } from './dailystore.js';
import { strategies } from '../strategies/state.js';
import { correctIsinSymbols, isinOf, isinSymbolCached, resolveIsinSymbols, useSavedSymbols } from '../tv/isin.js';
import { tvCall, tvErrorText, tvIsQuota, tvIstDate, tvMcp } from '../tv/connector.js';
import { loadRuns } from '../strategies/tracking.js';
import { priorityOrder } from './freshness.js';
import { planHistory, weekStartS, monthStartS, BAR_COLUMNS, TOLERANCE } from './historyplan.js';
import { collectBatchBars, isPriced, skippedForFailure, snapshotRows } from './snapshotrows.js';
import { setWithRetry, settleBatch, snapshotFetcher } from './snapshotcall.js';
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
const SYMBOL_FIXES_PER_RUN = 20;     // stocks per run whose saved symbol is searched by ISIN again after TradingView gave no price for them
const SYMBOL_LOOKUPS_PER_RUN = 25;   // new stocks searched by ISIN in one bulk run (a search is 1 to 3 TradingView calls)
let stopAsked = false;
let busy = false;
registerBusy(() => busy);
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

// ---- Refresh all stocks: one step after another, sharing one `run` (the counters, the skipped stocks and the result lines) ----
// Checks that TradingView answers, reads the last saved snapshot and the saved symbols, and lists the stocks to ask about.
async function rsPrepare(run){
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
  try { const snap = await run.db.collection('liveSnapshot').get(); snap.docs.forEach(d => { if(d.exists) stored.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved snapshot', e); }
  // The last good row of every stock, with the day it is from, so a stock TradingView does not answer for today keeps its figures instead of losing them.
  const prevRows = new Map();
  stored.forEach(c => { if(c && Array.isArray(c.rows)) c.rows.forEach(r => { if(r && typeof r.k === 'string' && Array.isArray(r.c)) prevRows.set(r.k, { y: r.y, c: r.c, d: r.d || c.asof, t: r.t || c.at }); }); });
  fiSet('prepare', 'running', 'Using the saved TradingView symbols…', 0.5);
  await useSavedSymbols(stocks, s => { const p = prevRows.get(sanitizeDocId(tickerSymbol(s))); return p ? p.y : null; });
  // v1.304: a stock with an ISIN but no saved symbol (typically one added by the latest Fundamental import, so no earlier run has seen it) is looked up
  // by its ISIN now, a few per run, and the symbol is saved for next time. Before, it stayed out of every bulk run until someone opened it and pressed Refresh.
  const lacking = stocks.filter(s => !snapshotSymbol(s) && isinOf(s)), looked = new Set(lacking.slice(0, SYMBOL_LOOKUPS_PER_RUN));
  if(looked.size){
    fiSet('prepare', 'running', 'Looking up TradingView symbols for ' + looked.size + ' new stock' + (looked.size === 1 ? '' : 's') + '…', 0.7);
    // A refused or failed search only leaves those stocks without a symbol this time; it does not stop the run.
    try { await resolveIsinSymbols([...looked]); } catch(e){ console.error('Could not look up the TradingView symbols', e); }
  }
  const todo = [];
  for(const s of stocks){
    const sym = snapshotSymbol(s);
    if(!sym){
      const reason = !isinOf(s) ? 'No ISIN saved (import the Fundamental CSV)' : looked.has(s) ? 'TradingView has no NSE or BSE listing with ISIN ' + isinOf(s) : 'Not looked up yet: only ' + SYMBOL_LOOKUPS_PER_RUN + ' new stocks are searched per run (the next run continues)';
      run.skipped.push({ sym: tickerSymbol(s), name: s.name, reason }); run.noSymbol.push(tickerSymbol(s) + ' ' + s.name);
    } else todo.push({ s, sym });
  }
  fiSet('prepare', 'done', num(todo.length) + ' stocks' + (run.skipped.length ? ', ' + run.skipped.length + ' without a symbol' : ''));
  run.planned = todo.length;
  Object.assign(run, { stored, prevRows, todo });
}

// 1. Full history for stocks that have none (a few calls, so it always fits in the daily quota).
async function rsFillHistory(run){
  // ---- 1. full history for stocks that have none (a few calls, so it always fits in the daily quota) ----
  /** @type {any} */
  let ctx = null;
  /** @type {Record<string, number>} */
  const batchLeft = {};   // why stocks were left for the one-by-one fetch
  if(stopAsked || skipHistory()){ run.stopped = run.stopped || stopAsked; fiSet('fill', 'done', 'skipped'); }
  else {
    run.histRan = true;
    fiSet('fill', 'running', 'Looking at the saved bars…', 0.1);
    await ensureAllPriceBars();
    const plan = planHistory(stocks, s => priceHistoryByTicker[pcTickerKey(s)], Date.now() / 1000);
    run.noneBefore = plan.none.length; run.staleBefore = plan.stale.length;
    const tracked = new Set();
    try { (await loadRuns()).forEach(r => (r.picks || []).forEach(p => { const s = stockByTickerSymbol.get(p.sym); if(s) tracked.add(s); })); } catch(e){ console.error('Could not read tracked picks', e); }
    const byImportance = list => list.filter(s => tracked.has(s)).concat(priorityOrder('tech', list.filter(s => !tracked.has(s))));
    let tried = {};
    try { const tr = await run.db.doc('stockMeta/histFillTried').get(); if(tr && tr.exists) tried = Object.assign({}, tr.data() || {}); } catch(e){ /* the list only spares stocks that failed recently */ }
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
    if(noneList.length) run.filled = await bars(noneList, 'fill', true, FULL_WORKERS);
    if(noneList.length){ try { await run.db.doc('stockMeta/histFillTried').set(tried); } catch(e){ console.error('Could not save the skipped list', e); } }
    fiSet('fill', 'done', run.noneBefore ? num(run.filled) + ' of ' + num(run.noneBefore) + ' downloaded' : 'none needed');
    if(stopAsked) run.stopped = true;
    if(ctx.abort){ run.stopped = true; run.runError = ctx.abort; }
  }
  Object.assign(run, { ctx, batchLeft });
}

// 2. Snapshot of every stock, 50 per call (about 44 calls); it is what the screens show every day, so it goes before the long bar update.
// The next batch is requested while the current one is being saved (see snapshotcall.js for the pacing).
// A stock TradingView leaves out of an answer is usually a one-off miss: ask again for just those symbols before giving up.
async function askAgain(run, fetcher, batch, data){
  const lacking = batch.filter(x => !isPriced(data, x));
  if(!lacking.length || stopAsked) return;
  try {
    const again = await fetcher.again(lacking.map(x => x.sym));
    Object.assign(data, (again && again.data) || {});
    run.retried += lacking.length; run.answeredAgain += lacking.filter(x => isPriced(data, x)).length;
  } catch(e){ console.error('Retry of the missing stocks failed', e); }
}

// Saves one batch's rows as record liveSnapshot/<id> unless it already holds exactly these rows today.
async function saveSnapshotChunk(run, id, batch, built){
  const { rows } = built, old = run.stored.get(id);
  if(!rows.length) return;
  if(old && old.asof === run.today && sameValue(old.rows, rows)){ run.unchanged += rows.length; return; }
  const doc = { v: 1, asof: run.today, at: new Date().toISOString(), rows };
  const err = await setWithRetry(run.db, 'liveSnapshot/' + id, doc);
  if(!err){ run.stored.set(id, doc); run.updated += rows.length; run.scored += built.scored; run.kept += built.kept; run.chunksSaved++; return; }
  const why = 'could not be saved: ' + String((err && err.message) || err).slice(0, 80);
  run.skipped.push(...skippedForFailure(batch.filter(x => rows.some(r => r.k === sanitizeDocId(tickerSymbol(x.s)))), why));
}

// Today's price of each stock this batch priced (a row kept from an earlier day is not today's price), by stock key, for the weekly MACD 30/60/5 step.
function noteLivePrices(run, rows){
  rows.forEach(r => { if(r.d === undefined && Array.isArray(r.c) && typeof r.c[0] === 'number') run.livePx.set(r.k, r.c[0]); });
}

// One batch's answer (job = { batch, payload, bi }): ask again for what is missing, save the rows, and take the bars it carried.
async function applyBatch(run, fetcher, job){
  const { batch, payload, bi } = job, data = Object.assign({}, payload.data || {});
  await askAgain(run, fetcher, batch, data);
  const built = snapshotRows(batch, data, run.prevRows, run.today);
  run.carried += built.carried; run.skipped.push(...built.skipped);
  noteLivePrices(run, built.rows);
  if(run.ctx) collectBatchBars(batch, data, run.ctx, run.batchLeft);
  const s0 = Date.now();
  await saveSnapshotChunk(run, 'c' + String(bi + 1).padStart(3, '0'), batch, built);
  run.saveMs += Date.now() - s0;
}

async function rsSnapshot(run){
  const { todo, ctx } = run, fetcher = snapshotFetcher(ctx ? COLS.concat(BAR_COLUMNS) : COLS), state = { failed: 0 };   // with the bars of the stocks that need them, in the same call
  const batches = [];
  for(let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  const next = (bi) => bi < batches.length && !stopAsked ? fetcher.fetch(batches[bi]) : null;
  let pending = next(0);
  for(let bi = 0; bi < batches.length; bi++){
    if(stopAsked){ run.stopped = true; break; }
    const batch = batches[bi], b0 = Date.now();
    fiSet('run', 'running', 'Batch ' + (bi + 1) + ' of ' + batches.length + ' · ' + num(run.updated + run.unchanged) + ' done', bi / batches.length);
    const w0 = Date.now(), res = await pending;
    run.tvWaitMs += Date.now() - w0;
    pending = next(bi + 1);
    const payload = settleBatch(run, state, batch, res);
    if(payload) await applyBatch(run, fetcher, { batch, payload, bi }); else fetcher.slowDown();
    run.batchSecs.push(Math.round((Date.now() - b0) / 100) / 10);
  }
  fiSet('run', 'done', num(run.updated) + ' saved' + (run.unchanged ? ', ' + num(run.unchanged) + ' unchanged' : ''));
}

// A stock TradingView still gave no price for today (after the retry) may have been renamed or moved to the other exchange, which leaves its saved symbol dead.
// Those stocks are searched by their ISIN again and a corrected symbol is saved for the next run. A failure here never stops the run.
async function rsFixSymbols(run){
  const silent = run.todo.map(x => x.s).filter(s => !run.livePx.has(sanitizeDocId(tickerSymbol(s)))).slice(0, SYMBOL_FIXES_PER_RUN);
  if(!silent.length || stopAsked || run.stopped) return;
  try { run.symbolFixes = (await correctIsinSymbols(silent)).map(x => tickerSymbol(x.stock) + ' ' + x.from + ' → ' + x.to); }
  catch(e){ console.error('Could not search the TradingView symbols again', e); }
}

// 3. New weekly and monthly bars for stocks whose bars are out of date, then their technical scores: the long part (one call per bar type per stock), so it is last.
// It can run out of the daily quota; the stocks not reached stay out of date and the next run carries on with them.

// Stocks the snapshot call should have answered for but that it neither placed nor gave a reason for (the call did not happen, or failed).
function countUnseen(batchLeft, ctx, left){
  const explained = Object.keys(batchLeft).filter(k => k !== 'noSymbol' && k !== 'callFailed').reduce((n, k) => n + batchLeft[k], 0);
  const unseen = left.filter(s => ctx.jobs.has(s)).length - explained;
  if(unseen > 0) batchLeft.callFailed = (batchLeft.callFailed || 0) + unseen;
}

// A few stocks per run get their own price documents rewritten in full, so the records never have to reach back further than they keep (see prices/recent.js).
async function compactLagging(run){
  const { ctx } = run;
  const lagging = stocks.map(s => ({ s, lag: lagOf(pcTickerKey(s), (priceHistoryByTicker[pcTickerKey(s)] || {})['1W']) })).filter(x => x.lag >= COMPACT_LAG).sort((a, b) => b.lag - a.lag).slice(0, COMPACT_MAX);
  if(!lagging.length || stopAsked) return;
  fiSet('update', 'running', 'Rewriting ' + num(lagging.length) + ' stocks in full…', 0.9);
  for(const { s } of lagging){
    if(stopAsked || ctx.abort) break;
    const h = priceHistoryByTicker[pcTickerKey(s)];
    if(await saveFullBars(s, h['1W'], h['1M'])) run.compacted++;
  }
}

// The technical scores of the stocks whose bars were just saved, 50 stocks to a record.
async function scoreSavedBars(run, savedList){
  fiSet('tech', 'running', 'Calculating…', 0.05);
  const tb = await saveTechBlocks(run.db, savedList, tvIstDate(), (d, n) => fiSet('tech', 'running', num(d) + ' of ' + num(n) + ' batches', d / n));
  run.techBlocksSaved = tb.computed; run.chunkWrites += tb.chunksWritten;
  fiSet('tech', 'done', num(tb.computed) + ' scores in ' + num(tb.records) + ' batches' + (tb.failed ? ', ' + tb.failed + ' could not be saved' : ''));
}

// The new bars of every stock the snapshot could place (50 stocks to a record), their scores, and then the rest one by one, as before.
async function saveFreshBars(run){
  const { ctx, batchLeft } = run, ordered = ctx.byImportance(ctx.plan.stale);
  const readyList = ordered.filter(s => ctx.ready.has(s)).map(s => ctx.ready.get(s));
  let left = ordered.filter(s => !ctx.ready.has(s));
  countUnseen(batchLeft, ctx, left);
  fiSet('update', 'running', 'Saving the bars in batches…', 0.05);
  const rb = await saveRecentBars(run.db, readyList, (d, n) => fiSet('update', 'running', num(d) + ' of ' + num(n) + ' batches', d / n));
  const savedList = readyList.filter(r => rb.saved.has(pcTickerKey(r.s)));
  run.batchSaved = savedList.length; run.barsUpdated = run.batchSaved; run.chunkWrites += rb.chunksWritten;
  left = left.concat(readyList.filter(r => rb.failed.has(pcTickerKey(r.s))).map(r => r.s));
  await compactLagging(run);
  fiSet('update', 'done', num(run.batchSaved) + ' stocks in ' + num(rb.records) + ' batches' + (rb.chunksWritten < rb.records ? ' (' + num(rb.records - rb.chunksWritten) + ' unchanged)' : ''));
  await scoreSavedBars(run, savedList);
  if(stopAsked || ctx.abort || !left.length) return;
  fiSet('update', 'running', 'The rest one by one…', 0.95);
  run.barsUpdated += await ctx.bars(left, 'update', false, BAR_WORKERS, true, { done: 0, total: left.length });
  fiSet('update', 'done', num(run.batchSaved) + ' in batches, ' + num(left.length) + ' one by one');
}

async function rsBars(run){
  const { ctx } = run;
  if(!ctx){ fiSet('update', 'done', 'skipped'); fiSet('tech', 'done', 'skipped'); return; }
  if(stopAsked) run.stopped = true;
  if(!run.stopped && ctx.plan.stale.length) await saveFreshBars(run);
  else fiSet('tech', 'done', run.stopped ? 'skipped' : 'none needed');
  if(stopAsked) run.stopped = true;
  if(!ctx.plan.stale.length || run.stopped) fiSet('update', 'done', run.staleBefore ? num(run.barsUpdated) + ' of ' + num(run.staleBefore) + ' updated' : 'all up to date');
  if(ctx.abort){ run.stopped = true; run.runError = ctx.abort; }
  run.histFailed = ctx.failedBars.length;
  run.noHistoryLeft = run.noneBefore - run.filled;
  ctx.failedBars.forEach(x => run.skipped.push(x));
}

// The weekly MACD 30/60/5 of every stock, from its saved weekly bars and today's price (the week in progress). It is read again every run for every stock,
// not only the ones whose bars changed, so the Strategies filter of that name is current on any weekday. A failure here never stops the run.
async function rsCross(run){
  if(!run.histRan || run.stopped) return;
  fiSet('verify', 'running', 'Reading the weekly MACD 30/60/5…', 0.2);
  try {
    const items = [];
    for(const s of stocks){
      const key = sanitizeDocId(tickerSymbol(s));
      if(run.livePx.has(key)) items.push({ key, W: (priceHistoryByTicker[pcTickerKey(s)] || {})['1W'], px: run.livePx.get(key) });
    }
    const r = await saveCrossStates(run.db, items, run.today, (d, n) => fiSet('verify', 'running', 'Weekly MACD 30/60/5: ' + num(d) + ' of ' + num(n) + ' batches', 0.2 + 0.3 * d / n));
    Object.assign(run, { crossRead: r.read, crossChanged: r.changed, crossFailed: r.failed }); run.chunkWrites += r.chunksWritten;
  } catch(e){ console.error('The weekly MACD 30/60/5 could not be read', e); run.crossFailed = -1; }
}

// The daily (1D) MACD 30/60/5 of the stocks of the strategy chosen in the panel, if one was: read from TradingView for those stocks only and saved with their technical blocks.
async function rsDaily(run){
  if(!run.dailyPick || run.stopped) return;
  const strategy = strategies.find(st => st.id === run.dailyPick.strategyId);
  if(!strategy){ run.dailyResult = { problem: 'the chosen strategy no longer exists' }; return; }
  const { list, total, needsOtherRule } = dailyStocksOf(stocks, strategy);
  if(needsOtherRule){ run.dailyResult = { name: strategy.name, problem: 'the strategy needs a rule besides the daily MACD, to choose the stocks to read' }; return; }
  fiSet('verify', 'running', 'Daily MACD 30/60/5: reading ' + num(list.length) + ' stocks…', 0.2);
  const progress = (d, n) => fiSet('verify', 'running', 'Daily MACD 30/60/5: ' + num(d) + ' of ' + num(n) + ' stocks', 0.2 + 0.2 * d / n);
  try {
    const io = { symbolOf: snapshotSymbol, keyOf: s => sanitizeDocId(tickerSymbol(s)), stop: () => stopAsked, today: tvIstDate, loadBars: (s, sym) => loadDailyBars(run.db, sym),
      saveBars: (s, sym, bars, isNew) => saveDailyBars(run.db, { sym, key: pcTickerKey(s), name: s.name }, bars, isNew),
      nowS: () => Math.floor(Date.now() / 1000), batch: async syms => ((await tvCall('mcp-tv-get-symbol-data-batch', { symbols: syms, columns: DAILY_BAR_COLUMNS })) || {}).data || {},
      pause: ms => { fiSet('verify', 'running', 'Daily MACD 30/60/5: TradingView asked for a pause, continuing in about a minute…', 0.3); return sleep(ms); } };
    const r = await readDailyStates(list, io, progress);
    const saved = await saveDailyStates(run.db, r.results, run.today, () => {});
    run.dailyResult = { name: strategy.name, stocks: list.length, total, read: r.results.length, changed: saved.changed, failed: r.failures.length, stored: r.stored, storeFailed: r.storeFailed, pauses: r.pauses, batched: r.batched, notSaved: saved.failed, abort: r.abort };
  } catch(e){ console.error('The daily MACD could not be read', e); run.dailyResult = { name: strategy.name, problem: 'it could not be read' }; }
}

// Technical Score 2, from the saved weekly bars (a few records).
async function rsTech2(run){
  // ---- Technical Score 2: from the saved weekly bars, a few records ----
  if(run.histRan && !run.stopped){
    fiSet('verify', 'running', 'Calculating Technical Score 2…', 0.5);
    try {
      const chunks = buildTech2Chunks(stocks, s => (priceHistoryByTicker[pcTickerKey(s)] || {})['1W'], run.today);
      const oldT2 = new Map();
      try { const snap = await run.db.collection('techScore2').get(); snap.docs.forEach(d => { if(d.exists) oldT2.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved Tech 2 scores', e); }
      for(const { id, doc } of chunks){
        const old = oldT2.get(id);
        if(old && old.asof === run.today && sameValue(old.rows, doc.rows)){ run.tech2Saved += doc.rows.length; continue; }
        let saved = false;
        for(let attempt = 0; attempt < 2 && !saved; attempt++){
          try { await run.db.doc('techScore2/' + id).set(doc); saved = true; } catch(e){ if(attempt === 0) await sleep(1500); else console.error('Could not save Tech 2 ' + id, e); }
        }
        if(saved) run.tech2Saved += doc.rows.length; else run.tech2Failed += doc.rows.length;
      }
    } catch(e){ console.error('Technical Score 2 failed', e); run.tech2Failed = -1; }
  }
  fiSet('verify', 'done', '');
}

// The result shown when the run ends: a heading and short bullets, and the list of skipped stocks.
function rsReport(run){
  // The result: a heading and short bullets with the % done where it means something; problems only when there are some.
  const pct = (a, n) => n > 0 ? ' (' + Math.min(100, Math.round(100 * a / n)) + '%)' : '';
  const B = (text, strong) => run.lines.push({ text: '• ' + text, cls: strong ? 'fi-line fi-bullet fi-line-strong' : 'fi-line fi-bullet' });
  run.lines.push({ text: (run.stopped ? 'Stopped after ' : run.updated + run.unchanged === 0 ? 'Nothing saved, ' : 'Done in ') + duration(Date.now() - run.t0), cls: 'fi-line fi-line-strong' });
  if(run.runError) B('Stopped because: ' + run.runError, true);
  B('Prices and snapshot: ' + num(run.updated + run.unchanged) + ' of ' + num(run.planned) + ' stocks' + pct(run.updated + run.unchanged, run.planned) + (run.unchanged ? ', ' + num(run.unchanged) + ' unchanged' : ''));
  if(run.histRan){
    if(run.noneBefore) B('Full history: ' + num(run.filled) + ' of ' + num(run.noneBefore) + ' stocks' + pct(run.filled, run.noneBefore));
    B('Weekly and monthly bars: ' + num(run.barsUpdated) + ' of ' + num(run.staleBefore) + ' stocks' + pct(run.barsUpdated, run.staleBefore) + (run.barsUpdated > run.batchSaved ? ' (' + num(run.barsUpdated - run.batchSaved) + ' one by one)' : ''));
    B('Technical scores (completed weeks): ' + num(run.techBlocksSaved + Math.max(0, run.barsUpdated - run.batchSaved)) + ' calculated');
    if(run.crossFailed === -1) B('The weekly MACD 30/60/5 could not be read', true);
    else B('Weekly MACD 30/60/5: ' + num(run.crossRead) + ' stocks read, ' + num(run.crossChanged) + ' changed' + (run.crossFailed ? ', ' + num(run.crossFailed) + ' batches not saved' : ''));
    if(run.tech2Failed !== -1 && !run.stopped) B('Technical Score 2: ' + num(run.tech2Saved) + ' of ' + num(stocks.length) + ' stocks' + pct(run.tech2Saved, stocks.length) + (run.tech2Failed ? ', ' + num(run.tech2Failed) + ' not saved' : ''));
    if(run.tech2Failed === -1) B('Technical Score 2 could not be calculated', true);
  }
  if(run.noSymbol.length) B(num(run.noSymbol.length) + ' stocks without a TradingView symbol: ' + run.noSymbol.slice(0, 3).join(', ') + (run.noSymbol.length > 3 ? ' …' : ''));
  if(run.carried) B(num(run.carried) + ' stocks had no price today and kept an earlier one');
  if(run.dailyResult){ const d = dailyReportLine(run.dailyResult); B(d.text, d.problem); }
  if(run.symbolFixes.length) B(num(run.symbolFixes.length) + ' saved TradingView symbol' + (run.symbolFixes.length === 1 ? ' was' : 's were') + ' out of date and corrected (priced from the next run): ' + run.symbolFixes.slice(0, 4).join('; ') + (run.symbolFixes.length > 4 ? ' …' : ''));
  if(run.skipped.length){
    const why = new Map(); run.skipped.forEach(x => { const r = String(x.reason).replace(/\([A-Z]+:[^)]*\)/g, '').replace(/from \d{4}-\d\d-\d\d/, '').trim(); why.set(r, (why.get(r) || 0) + 1); });
    const top = [...why.entries()].sort((a, b) => b[1] - a[1])[0];
    B(num(run.skipped.length) + ' stocks skipped, mostly: ' + top[0].slice(0, 90) + ' (list below)');
  }
  fiShowResult(run.updated + run.unchanged === 0 ? 'err' : 'ok', run.lines, true);
  skippedReport(run.skipped, 'snapshot');
}

async function runSnapshot(){
  const db = await begin('Refreshing all stocks from TradingView');
  if(!db) return;
  // Everything the steps count and report. The steps below fill it in; `run.lines` is the result shown at the end.
  const run = { db, today: tvIstDate(), lines: [], skipped: [], updated: 0, kept: 0, scored: 0, unchanged: 0, stopped: false,
    t0: Date.now(), startedAt: new Date().toISOString(), batchSecs: [], tvWaitMs: 0, saveMs: 0, planned: 0, chunksSaved: 0, runError: '',
    retried: 0, answeredAgain: 0, carried: 0, noSymbol: [], tech2Saved: 0, tech2Failed: 0, livePx: new Map(), crossRead: 0, crossChanged: 0, crossFailed: 0, symbolFixes: [], dailyPick: dailyChoice(), dailyResult: null,
    batchSaved: 0, chunkWrites: 0, compacted: 0, techBlocksSaved: 0, filled: 0, barsUpdated: 0, histFailed: 0, noneBefore: 0, staleBefore: 0, noHistoryLeft: 0, histRan: false };
  try {
    await rsPrepare(run);
    await rsFillHistory(run);
    await rsSnapshot(run);
    await rsFixSymbols(run);
    await rsBars(run);
    await rsCross(run);
    await rsDaily(run);
    await rsTech2(run);
    rsReport(run);
  } catch(e){
    run.runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(run.updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    await saveRunLog(db, 'snapshot', run.startedAt, run.t0, { planned: run.planned, batches: run.batchSecs.length, saved: run.updated, unchanged: run.unchanged, scored: run.scored, kept: run.kept, skipped: run.skipped.length, stopped: run.stopped, error: run.runError || null, chunks: run.chunksSaved, retried: run.retried, answeredAgain: run.answeredAgain, carried: run.carried, noSymbol: run.noSymbol.length, filled: run.filled, barsUpdated: run.barsUpdated, batchSaved: run.batchSaved, chunkWrites: run.chunkWrites, compacted: run.compacted, techBlocksSaved: run.techBlocksSaved, historyFailed: run.histFailed, noHistoryLeft: run.histRan ? run.noHistoryLeft : null, v: 5, tech2: run.tech2Saved, tvWaitSecs: Math.round(run.tvWaitMs / 100) / 10, saveSecs: Math.round(run.saveMs / 100) / 10, batchSecs: run.batchSecs });
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
  wireDailyPicker();
  const on = (id, fn) => { const b = document.getElementById(id); if(b) b.addEventListener('click', fn); };
  on('tvSnapshotBtn', () => runSnapshot().then(paintHint));
  on('tvStopBtn', () => { stopAsked = true; const b = /** @type {HTMLButtonElement|null} */ (document.getElementById('tvStopBtn')); if(b){ b.disabled = true; b.textContent = 'Stopping…'; } });
}

export { init_refresh_tvrefresh };
