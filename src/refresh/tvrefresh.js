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
import { priceHistoryByTicker, pcTickerKey, priceSymbolByTicker, ensureAllPriceBars } from '../prices/store.js';
import { refreshFromBars, refreshOneNow, priceJobs } from '../prices/refresh.js';
import { BSE_ALPHA_MAP } from '../tv/links.js';
import { tvCall, tvErrorText, tvIsFatal, tvIstDate, tvMcp } from '../tv/connector.js';
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
const SAVE_WORKERS = 12;          // stocks whose bars from the batch call are saved at the same time (database writes only, no TradingView call)
// Test hook: the browser tests switch the history stages off (the made-up database has no history for any stock, so every run would download all of it).
const skipHistory = () => !!debugHandle().skipHistoryStage;
const STEPS = [{ key: 'prepare', label: 'Prepare the stock list', w: 5 }, { key: 'fill', label: 'Full history for stocks that have none', w: 30 },
  { key: 'run', label: 'Snapshot of every stock', w: 30 }, { key: 'update', label: 'New weekly and monthly bars for the rest', w: 30 }, { key: 'verify', label: 'Finish', w: 5 }];

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
  let batchSaved = 0, batchCalls = 0, filled = 0, barsUpdated = 0, histFailed = 0, noneBefore = 0, staleBefore = 0, noHistoryLeft = 0, histRan = false;
  try {
    fiSet('prepare', 'running', 'Reading the saved updates…', 0.3);
    // The chunks saved by the last run, so a batch that came back exactly the same is not written again. A failed read only means every chunk is written.
    const stored = new Map();
    try { const snap = await db.collection('liveSnapshot').get(); snap.docs.forEach(d => { if(d.exists) stored.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved snapshot', e); }
    // The last good row of every stock, with the day it is from, so a stock TradingView does not answer for today keeps its figures instead of losing them.
    const prevRows = new Map();
    stored.forEach(c => { if(c && Array.isArray(c.rows)) c.rows.forEach(r => { if(r && typeof r.k === 'string' && Array.isArray(r.c)) prevRows.set(r.k, { y: r.y, c: r.c, d: r.d || c.asof, t: r.t || c.at }); }); });
    const todo = [];
    for(const s of stocks){
      const sym = snapshotSymbol(s);
      if(!sym){ skipped.push({ sym: tickerSymbol(s), name: s.name, reason: 'BSE-only stock with no TradingView symbol saved yet' }); noSymbol.push(tickerSymbol(s) + ' ' + s.name); } else todo.push({ s, sym });
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
      // Stocks one bar behind: the batch call returns their current and previous weekly and monthly bar, 50 stocks per call, instead of one call per stock.
      // A stock the batch cannot place with certainty (longer gap, adjusted prices, no answer) is left for the one-by-one fetch. Returns [saved, left].
      const batchUpdate = async (list, key) => {
        const nowS = Date.now() / 1000, left = [], jobs = [], prog = { done: 0, total: list.length };
        const wNeed = nowS => weekStartS(nowS) - TOLERANCE, mNeed = nowS => monthStartS(nowS) - TOLERANCE;
        for(const s of list){
          const h = priceHistoryByTicker[pcTickerKey(s)], sym = snapshotSymbol(s);
          if(h && h['1W'] && h['1W'].length && h['1M'] && h['1M'].length && sym) jobs.push({ s, sym, h, needW: h['1W'][h['1W'].length - 1][0] < wNeed(nowS), needM: h['1M'][h['1M'].length - 1][0] < mNeed(nowS) });
          else left.push(s);
        }
        let saved = 0, failedCalls = 0, lastStart = 0;
        batchLeft.noSymbol = left.length;   // stocks with no saved bars or no TradingView symbol are not eligible
        for(let i = 0; i < jobs.length && !stopAsked && !ctx.abort; i += BATCH){
          const part = jobs.slice(i, i + BATCH);
          const wait = 300 - (Date.now() - lastStart); if(wait > 0) await sleep(wait);
          lastStart = Date.now();
          let data;
          try { const p = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: part.map(x => x.sym), columns: BAR_COLUMNS }); batchCalls++; data = (p && p.data) || {}; failedCalls = 0; }
          catch(e){
            part.forEach(x => left.push(x.s)); batchLeft.callFailed = (batchLeft.callFailed || 0) + part.length;
            if(tvIsFatal(e)){ ctx.abort = tvErrorText(e); break; }
            if(++failedCalls >= 3){ ctx.abort = tvErrorText(e) + ' Three batches in a row failed, so the bar update stopped.'; break; }
            await sleep(1500); continue;
          }
          const ready = [];
          for(const j of part){
            const row = data[j.sym];
            const bw = j.needW ? batchBars(row, 'W') : null, bm = j.needM ? batchBars(row, 'M') : null;
            const W = j.needW ? alignBars(j.h['1W'], bw, 'W', nowS) : j.h['1W'];
            const M = j.needM ? alignBars(j.h['1M'], bm, 'M', nowS) : j.h['1M'];
            if(W && M) ready.push({ s: j.s, W, M, w: j.needW, m: j.needM });
            else { left.push(j.s); const k = !row ? 'noAnswer' : ((j.needW && !bw) || (j.needM && !bm)) ? 'missing' : 'unclear'; batchLeft[k] = (batchLeft[k] || 0) + 1; }
          }
          saved += await pool(ready, key, SAVE_WORKERS, prog, async r => { await refreshFromBars(r.s, r.W, r.M, r); return settle(r.s, false); }, r => r.s);
        }
        // what the batch left over still counts towards the same progress line
        prog.total = list.length;
        return { saved, left, prog, skippedStop: stopAsked || !!ctx.abort };
      };
      ctx.batchUpdate = batchUpdate;
      ctx.bars = bars;
      if(noneList.length) filled = await bars(noneList, 'fill', true, FULL_WORKERS);
      if(noneList.length){ try { await db.doc('stockMeta/histFillTried').set(tried); } catch(e){ console.error('Could not save the skipped list', e); } }
      fiSet('fill', 'done', noneBefore ? num(filled) + ' of ' + num(noneBefore) + ' downloaded' : 'none needed');
      if(stopAsked) stopped = true;
      if(ctx.abort){ stopped = true; runError = ctx.abort; }
    }
    // ---- 2. snapshot of every stock, 50 per call (about 44 calls, and it is what the screens show every day, so it goes before the long bar update) ----
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
      try { return { payload: await tvCall('mcp-tv-get-symbol-data-batch', { symbols: batch.map(x => x.sym), columns: COLS }) }; }
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
        try { const again = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: lacking.map(x => x.sym), columns: COLS }); Object.assign(data, (again && again.data) || {}); retried += lacking.length; answeredAgain += lacking.filter(priced).length; } catch(e){ console.error('Retry of the missing stocks failed', e); }
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
        const b = await ctx.batchUpdate(ordered, 'update');
        batchSaved = b.saved; barsUpdated = b.saved;
        if(!b.skippedStop && b.left.length) barsUpdated += await ctx.bars(b.left, 'update', false, BAR_WORKERS, true, { done: ordered.length - b.left.length, total: ordered.length });
      }
      if(stopAsked) stopped = true;
      fiSet('update', 'done', staleBefore ? num(barsUpdated) + ' of ' + num(staleBefore) + ' updated' : 'all up to date');
      if(ctx.abort){ stopped = true; runError = ctx.abort; }
      histFailed = ctx.failedBars.length;
      noHistoryLeft = noneBefore - filled;
      ctx.failedBars.forEach(x => skipped.push(x));
    } else { fiSet('update', 'done', 'skipped'); }
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
    lines.push({ text: (stopped ? 'Stopped. ' : '') + num(updated) + ' stocks refreshed: price saved for each, ' + num(scored) + ' technical scores updated, ' + num(kept) + ' kept their completed-week score (updated in the last 3 days).', cls: 'fi-line fi-line-strong' });
    if(histRan && tech2Failed !== -1 && !stopped) lines.push({ text: 'Technical Score 2: ' + num(tech2Saved) + ' stocks scored from their weekly bars' + (tech2Failed ? ', ' + num(tech2Failed) + ' could not be saved' : '') + '. Stocks with under 60 weeks of bars get no score.', cls: 'fi-line' });
    if(histRan && tech2Failed === -1) lines.push({ text: 'Technical Score 2 could not be calculated this time.', cls: 'fi-line' });
    if(unchanged) lines.push({ text: num(unchanged) + ' stocks already held exactly these figures (same price and scores), so they were not rewritten.', cls: 'fi-line' });
    if(histRan && (batchSaved || Object.keys(batchLeft).some(k => batchLeft[k]))){
      const why = { noSymbol: 'no saved bars or symbol', noAnswer: 'TradingView sent nothing', missing: 'figures missing', unclear: 'bars did not line up (gap, split or flat prices)', callFailed: 'the batch call failed' };
      const rest = Object.keys(why).filter(k => batchLeft[k]).map(k => num(batchLeft[k]) + ' ' + why[k]);
      lines.push({ text: 'Batch bar update: ' + num(batchSaved) + ' stocks from ' + num(batchCalls) + ' calls' + (rest.length ? '; left for the one-by-one fetch: ' + rest.join(', ') : '') + '.', cls: 'fi-line fi-line-muted' });
    }
    if(histRan) lines.push({ text: 'Price bars: ' + num(filled) + ' stocks downloaded in full' + (noHistoryLeft > 0 ? ' (' + num(noHistoryLeft) + ' still have none)' : '') + ', ' + num(barsUpdated) + ' given their new weekly and monthly bars' + (batchSaved ? ' (' + num(batchSaved) + ' of them from the batch call)' : '') + (histFailed ? ', ' + num(histFailed) + ' failed' : '') + '.', cls: 'fi-line' });
    lines.push({ text: 'Took ' + duration(Date.now() - t0) + '.', cls: 'fi-line fi-line-muted' });
    lines.push({ text: 'These scores include the week and month still in progress, so they can change before the week ends. Stocks with saved price bars get the stricter completed-weeks score once their bars are up to date.', cls: 'fi-line fi-line-muted' });
    if(noSymbol.length) lines.push({ text: num(noSymbol.length) + ' stocks have no TradingView symbol yet, so they are not refreshed: ' + noSymbol.slice(0, 10).join(', ') + (noSymbol.length > 10 ? ' … +' + (noSymbol.length - 10) : '') + '. Their symbols are looked up by exact company name; one that cannot be found has to be added by hand.', cls: 'fi-line' });
    if(retried) lines.push({ text: num(retried) + ' stocks TradingView left out of an answer were asked for again; ' + num(answeredAgain) + ' answered the second time' + (carried ? ', ' + num(carried) + ' still had no price and kept their figures from an earlier day.' : '.'), cls: 'fi-line fi-line-muted' });
    if(runError) lines.push({ text: 'Stopped because: ' + runError, cls: 'fi-line fi-line-strong' });
    if(skipped.length){
      const why = new Map(); skipped.forEach(x => { const r = String(x.reason).replace(/\([A-Z]+:[^)]*\)/g, '').replace(/from \d{4}-\d\d-\d\d/, '').trim(); why.set(r, (why.get(r) || 0) + 1); });
      const top = [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => num(n) + ' × ' + r.slice(0, 110));
      lines.push({ text: num(skipped.length) + ' stocks skipped. Most common reasons: ' + top.join('; ') + '. The full list is in the file below.', cls: 'fi-line' });
    }
    fiShowResult(updated + unchanged === 0 ? 'err' : 'ok', lines, true);
    skippedReport(skipped, 'snapshot');
  } catch(e){
    runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    await saveRunLog(db, 'snapshot', startedAt, t0, { planned, batches: batchSecs.length, saved: updated, unchanged, scored, kept, skipped: skipped.length, stopped, error: runError || null, chunks: chunksSaved, retried, answeredAgain, carried, noSymbol: noSymbol.length, filled, barsUpdated, batchSaved, historyFailed: histFailed, noHistoryLeft: histRan ? noHistoryLeft : null, v: 5, tech2: tech2Saved, tvWaitSecs: Math.round(tvWaitMs / 100) / 10, saveSecs: Math.round(saveMs / 100) / 10, batchSecs });
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
