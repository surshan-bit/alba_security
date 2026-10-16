// "Refresh all stocks" on the Data Refresh screen (Technical Score section): the one daily route, straight from TradingView.
//  1. Snapshot of every stock: price, MACD and RSI (weekly, monthly), 50 stocks per call. One record per batch of 50 stocks is saved in
//     liveSnapshot (see overlays/livesnapshot.js), not one per stock: the database takes about 1.5 saves a second, so about 44 saves replace
//     about 2,000. TradingView's figures include the week and month still in progress, so a stock whose saved block was built from
//     completed bars in the last 3 days keeps that block (only its price is updated).
//  2. Stocks with no saved bars: the full history (about 5 years, up to today) and the completed-weeks score, tracked picks first,
//     then pinned, strategy matches and the rest. Stop ends the run; the next run carries on.
//  3. Stocks with saved bars: only when a weekly or monthly bar has finished since the newest saved one (see historyplan.js), just the new bars.
import { stocks, stockByTickerSymbol } from '../core/stocks.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { COLS, packValues, snapshotUpdate } from '../overlays/livesnapshot.js';
import { priceHistoryByTicker, pcTickerKey, priceSymbolByTicker, ensureAllPriceBars } from '../prices/store.js';
import { refreshOneNow, priceJobs } from '../prices/refresh.js';
import { BSE_ALPHA_MAP } from '../tv/links.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp } from '../tv/connector.js';
import { loadRuns } from '../strategies/tracking.js';
import { priorityOrder } from './freshness.js';
import { planHistory } from './historyplan.js';
import { buildTech2Chunks } from '../engine/techscore2.js';
import { debugHandle } from '../boot/handoff.js';
import { getFiDb, getFiOwner, getFiRunning, setFiRunning } from '../import/fund-import.js';
import { fiEl, fiReset, fiSet, fiShowResult, setFiPfx } from '../import/panel.js';
import { registerBusy } from '../core/busy.js';
import { duration, paintLastRuns, saveRunLog } from './runlog.js';

const BATCH = 50;                 // symbols per TradingView call (the tool's limit)
const SKIP_RETRY_DAYS = 14;       // a stock whose history download failed is not tried again for this long
const BAR_WORKERS = 3;            // stocks whose bars are downloaded at the same time
// Test hook: the browser tests switch the history stages off (the made-up database has no history for any stock, so every run would download all of it).
const skipHistory = () => !!debugHandle().skipHistoryStage;
const STEPS = [{ key: 'prepare', label: 'Prepare the stock list', w: 5 }, { key: 'run', label: 'Snapshot of every stock', w: 30 }, { key: 'fill', label: 'Full history for stocks that have none', w: 30 },
  { key: 'update', label: 'New weekly and monthly bars for the rest', w: 30 }, { key: 'verify', label: 'Finish', w: 5 }];

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
  let tech2Saved = 0, tech2Rated = 0, tech2Failed = 0;
  let filled = 0, barsUpdated = 0, histFailed = 0, noneBefore = 0, staleBefore = 0, noHistoryLeft = 0, histRan = false;
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
    // ---- 2 + 3. price bars: full history for stocks that have none, only the new bars for the rest ----
    if(stopped || stopAsked || skipHistory()){ stopped = stopped || stopAsked; fiSet('fill', 'done', 'skipped'); fiSet('update', 'done', 'skipped'); }
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
      const bars = async (list, key, track) => {
        let next = 0, done = 0, ok = 0;
        const worker = async () => {
          while(next < list.length && !stopAsked){
            const s = list[next++], pk = pcTickerKey(s), id = sanitizeDocId(tickerSymbol(s));
            await refreshOneNow(s);
            const j = priceJobs.get(pk);
            if(j && j.state === 'ok'){ ok++; if(track) delete tried[id]; }
            else { failedBars.push({ sym: tickerSymbol(s), name: s.name, reason: 'price bars: ' + ((j && j.msg) || 'did not finish') }); if(track) tried[id] = new Date().toISOString(); }
            done++;
            fiSet(key, 'running', num(done) + ' of ' + num(list.length) + ' · ' + tickerSymbol(s), done / list.length);
          }
        };
        await Promise.all(Array.from({ length: BAR_WORKERS }, worker));
        return ok;
      };
      if(noneList.length) filled = await bars(noneList, 'fill', true);
      if(noneList.length){ try { await db.doc('stockMeta/histFillTried').set(tried); } catch(e){ console.error('Could not save the skipped list', e); } }
      fiSet('fill', 'done', noneBefore ? num(filled) + ' of ' + num(noneBefore) + ' downloaded' : 'none needed');
      if(stopAsked) stopped = true;
      if(!stopped && plan.stale.length) barsUpdated = await bars(byImportance(plan.stale), 'update', false);
      if(stopAsked) stopped = true;
      fiSet('update', 'done', staleBefore ? num(barsUpdated) + ' of ' + num(staleBefore) + ' updated' : 'all up to date');
      histFailed = failedBars.length;
      noHistoryLeft = noneBefore - filled;
      failedBars.forEach(x => skipped.push(x));
    }
    // ---- Technical Score 2: from the saved weekly bars, a few records ----
    if(histRan && !stopped){
      fiSet('verify', 'running', 'Calculating Technical Score 2…', 0.5);
      try {
        const chunks = buildTech2Chunks(stocks, s => (priceHistoryByTicker[pcTickerKey(s)] || {})['1W'], today);
        const oldT2 = new Map();
        try { const snap = await db.collection('techScore2').get(); snap.docs.forEach(d => { if(d.exists) oldT2.set(d.id, d.data()); }); } catch(e){ console.error('Could not read the saved Tech 2 scores', e); }
        for(const { id, doc } of chunks){
          tech2Rated += doc.rows.filter(r => typeof r.s === 'number').length;
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
    if(histRan && tech2Failed !== -1 && !stopped) lines.push({ text: 'Technical Score 2: ' + num(tech2Saved) + ' stocks scored from their weekly bars, ' + num(tech2Rated) + ' rated' + (tech2Failed ? ', ' + num(tech2Failed) + ' could not be saved' : '') + '. The rest do not meet its conditions (bullish weekly MACD, week up at least 1 %, volume) or have under 60 weeks of bars.', cls: 'fi-line' });
    if(histRan && tech2Failed === -1) lines.push({ text: 'Technical Score 2 could not be calculated this time.', cls: 'fi-line' });
    if(unchanged) lines.push({ text: num(unchanged) + ' stocks already held exactly these figures (same price and scores), so they were not rewritten.', cls: 'fi-line' });
    if(histRan) lines.push({ text: 'Price bars: ' + num(filled) + ' stocks downloaded in full' + (noHistoryLeft > 0 ? ' (' + num(noHistoryLeft) + ' still have none)' : '') + ', ' + num(barsUpdated) + ' given their new weekly and monthly bars' + (histFailed ? ', ' + num(histFailed) + ' failed' : '') + '.', cls: 'fi-line' });
    lines.push({ text: 'Took ' + duration(Date.now() - t0) + '.', cls: 'fi-line fi-line-muted' });
    lines.push({ text: 'These scores include the week and month still in progress, so they can change before the week ends. Stocks with saved price bars get the stricter completed-weeks score once their bars are up to date.', cls: 'fi-line fi-line-muted' });
    if(noSymbol.length) lines.push({ text: num(noSymbol.length) + ' stocks have no TradingView symbol yet, so they are not refreshed: ' + noSymbol.slice(0, 10).join(', ') + (noSymbol.length > 10 ? ' … +' + (noSymbol.length - 10) : '') + '. Their symbols are looked up by exact company name; one that cannot be found has to be added by hand.', cls: 'fi-line' });
    if(retried) lines.push({ text: num(retried) + ' stocks TradingView left out of an answer were asked for again; ' + num(answeredAgain) + ' answered the second time' + (carried ? ', ' + num(carried) + ' still had no price and kept their figures from an earlier day.' : '.'), cls: 'fi-line fi-line-muted' });
    if(skipped.length) lines.push({ text: num(skipped.length) + ' stocks skipped (listed in the file below).', cls: 'fi-line' });
    fiShowResult(updated + unchanged === 0 ? 'err' : 'ok', lines, true);
    skippedReport(skipped, 'snapshot');
  } catch(e){
    runError = tvErrorText(e);
    fiShowResult('err', [{ text: 'Stopped: ' + tvErrorText(e), cls: 'fi-line fi-line-strong' }, { text: num(updated) + ' stocks were saved before this.', cls: 'fi-line fi-line-muted' }], true);
  } finally {
    await saveRunLog(db, 'snapshot', startedAt, t0, { planned, batches: batchSecs.length, saved: updated, unchanged, scored, kept, skipped: skipped.length, stopped, error: runError || null, chunks: chunksSaved, retried, answeredAgain, carried, noSymbol: noSymbol.length, filled, barsUpdated, historyFailed: histFailed, noHistoryLeft: histRan ? noHistoryLeft : null, v: 5, tech2: tech2Saved, tech2Rated, tvWaitSecs: Math.round(tvWaitMs / 100) / 10, saveSecs: Math.round(saveMs / 100) / 10, batchSecs });
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
