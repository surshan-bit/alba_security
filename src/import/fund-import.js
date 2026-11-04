// Fundamental Score import: steps and database writes.
import { fundamentalCsvUploadLog } from '../core/store.js';
import { recordAttempt, saveRecord } from './last-file.js';
import { lockBusy, lockText, startBeat, tabId } from './joblock.js';
import { primeStockCache } from '../boot/stockdata.js';
import { fiAsk, fiEl, fiReset, fiSet, fiShowResult, getFiState, setFiPfx } from './panel.js';
import { applyFundamental } from './fund-engine.js';
import { fiCheck, fiPrevInfo, fiSym } from './fund-check.js';
import { fundColumnsError, importNote, importResultLines, newWithoutValue, thinFileWarning } from './fundreport.js';
import { wlRunSync } from './wlsync.js';
import { registerBusy } from '../core/busy.js';
import { sanitizeDocId as fiSid, sleep } from '../core/util.js';
import { paintLastRuns } from '../refresh/runlog.js';
import { uploadsSettled } from './upload-history.js';
import { recordScoreHistory } from '../history/scorehistory.js';

// ====================================================================================================
// FUNDAMENTAL IMPORT, IN THE PAGE (added 2026-10-09; backups and Restore removed in v1.199). "Import data" no longer opens a Claude chat:
// the uploaded CSV (kept in the asset store + fundamentalCsvUploadLog) is scored here with the same
// v3 engine, and the changed chunks are written to the database with a progress bar
// (a failed write puts the old chunks back; a finished import is corrected by importing a better file).
// Owner only (writing stock data and the asset store need the artifact's write bit).
// ====================================================================================================
const FI = { HARD: 240000, SOFT: 200000 };
const FI_PUBLISHED = 'The new data had already been saved when this failed, so it is live. Check the stock list; if it looks wrong, import a corrected file.';
const fiSize = o => new TextEncoder().encode(JSON.stringify(o)).length;
const fiDay = iso => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch(e){ return new Date().toISOString().slice(0, 10); } };
function fiCanon(o){
  if(Array.isArray(o)) return '[' + o.map(fiCanon).join(',') + ']';
  if(o && typeof o === 'object') return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + fiCanon(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
async function fiRetry(fn){
  let err;
  for(let a = 0; a < 5; a++){
    try { return await fn(); }
    catch(e){
      err = e;
      const c = e && e.code;
      if(c === 'invalid_argument' || c === 'not_granted' || c === 'too_large' || c === 'quota_exceeded' || c === 'quota_or_state') throw e;
      await sleep(700 * Math.pow(2, a) + Math.random() * 400);
    }
  }
  throw err;
}
function fiErr(e){ return (e && (e.message || e.code)) ? ((e.code ? e.code + ': ' : '') + (e.message || '')).replace(/: $/, '') : String(e); }

// ---- Reading the current stock data exactly as stored (NOT the page's overlaid copy) ----
async function fiLoadRaw(db, onProgress){
  const ms = await fiRetry(() => db.doc('stockMeta/main').get());
  const meta = ms && ms.exists ? JSON.parse(JSON.stringify(ms.data())) : null;
  if(!meta || !Array.isArray(meta.chunks)) throw new Error('the stock index (stockMeta/main) was not found');
  const docs = {}, oldCanon = {};
  let next = 0, done = 0;
  const worker = async () => {
    while(next < meta.chunks.length){
      const cid = meta.chunks[next++];
      const snap = await fiRetry(() => db.doc('stockData/' + cid).get());
      const d = snap && snap.exists ? JSON.parse(JSON.stringify(snap.data())) : null;
      if(!d || !Array.isArray(d.stocks)) throw new Error('chunk ' + cid + ' is missing');
      docs[cid] = d; oldCanon[cid] = fiCanon(d);
      done++; onProgress(done, meta.chunks.length);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const stocks = [].concat(...meta.chunks.map(c => docs[c].stocks));
  if(stocks.length !== meta.count) throw new Error('expected ' + meta.count + ' stocks but read ' + stocks.length);
  return { meta, docs, oldCanon, stocks };
}

// ---- Packing the list back into chunk documents (the saved stockdb.py split) ----
function fiSplit(stocks, meta, oldCanon){
  const oldIndex = meta.index || {}, ids = meta.chunks.slice();
  const buckets = {}; ids.forEach(c => { buckets[c] = []; });
  const spill = [], seen = new Set();
  for(const s of stocks){
    const k = fiSid(fiSym(s));
    if(seen.has(k)) throw new Error('duplicate ticker ' + k);
    seen.add(k);
    const cid = oldIndex[k];
    if(cid && buckets[cid]) buckets[cid].push(s); else spill.push(s);
  }
  const mk = (cid, arr) => ({ chunk: parseInt(cid.slice(1), 10), count: arr.length, stocks: arr });
  for(const cid of ids){            // a chunk that grew too large hands its tail to the spill list
    const arr = buckets[cid];
    while(arr.length > 1 && fiSize(mk(cid, arr)) >= FI.HARD){
      const cut = Math.max(1, Math.ceil(arr.length * 0.1));
      spill.unshift(...arr.splice(arr.length - cut, cut));
    }
  }
  let nextNum = Math.max(...ids.map(c => parseInt(c.slice(1), 10))) + 1;
  let cur = ids[ids.length - 1], curBytes = fiSize(mk(cur, buckets[cur]));
  for(const s of spill){
    const b = fiSize(s) + 1;
    if(curBytes + b > FI.SOFT){
      cur = 'c' + String(nextNum++).padStart(3, '0'); ids.push(cur); buckets[cur] = []; curBytes = fiSize(mk(cur, []));
    }
    buckets[cur].push(s); curBytes += b;
  }
  const finalIds = ids.filter(c => buckets[c].length);
  const index = {};
  for(const c of finalIds) for(const s of buckets[c]) index[fiSid(fiSym(s))] = c;
  const changed = [];
  for(const c of finalIds){
    const doc = mk(c, buckets[c]);
    if(oldCanon[c] === undefined || fiCanon(doc) !== oldCanon[c]) changed.push({ cid: c, doc });
  }
  const emptied = meta.chunks.filter(c => !finalIds.includes(c));
  const newMeta = { version: (meta.version || 0) + 1, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), count: stocks.length, chunks: finalIds, index };
  return { changed, newMeta, emptied, finalIds };
}

// Reads an uploaded file back. The website keeps files in a private store and reads them with the signed-in person's own access
// (assets.read); inside claude.ai the file is served at /_blob/<id>. Either way the answer is a fetch-style Response.
function fiReadAsset(assets, id){
  return assets && typeof assets.read === 'function' ? assets.read(id) : fetch('/_blob/' + id);
}

// ---- Steps the Fundamental import and the watchlist sync share ----
// Takes the job lock (importJobs/*), or stops with busyMessage(when it started) if another tab or device holds it.
// Resolves to the function that stops the heartbeat. `fields` are saved with the lock.
async function fiTakeLock(job, busyMessage, fields){
  const lk = await fiRetry(() => job.get()); const ld = lk && lk.exists ? lk.data() : null;
  if(lockBusy(ld)) throw new Error(busyMessage(lockText(ld)));
  await fiRetry(() => job.set(Object.assign({ status: 'running', startedAt: new Date().toISOString(), owner: tabId }, fields)));
  return startBeat(job);
}
// Frees a lock after a failure.
async function fiMarkFailed(job, msg, fields){
  try { await job.set(Object.assign({ status: 'failed', finishedAt: new Date().toISOString(), error: msg.slice(0, 500) }, fields)); } catch(x){ /* the lock runs out by itself */ }
}
// The newest upload still waiting to be imported, as [record, id] ([null, null] when there is none).
function fiNewestUpload(log){
  let rec = null, recId = null;
  for(const [id, r] of log.entries()){ if(r.status === 'uploaded' && (!rec || String(r.uploadedAt) > String(rec.uploadedAt))){ rec = r; recId = id; } }
  return [rec, recId];
}
// The text of the stored file an upload record points at.
async function fiReadUpload(assets, rec){
  const resp = await fiReadAsset(assets, rec.assetId);
  if(!resp.ok) throw new Error('could not read the stored file "' + rec.filename + '" (' + resp.status + ')');
  return resp.text();
}
// Hard integrity failures stop the import before anything is written.
function fiThrowHard(chk){
  if(chk.hard.length) throw new Error('integrity check failed, nothing was written:\n\u2022 ' + chk.hard.slice(0, 6).join('\n\u2022 '));
}
// Soft warnings are put to the person; the import goes on only if they say so.
async function fiConfirmSoft(soft){
  if(!soft.length) return;
  const go = await fiAsk(soft.join(' ') + ' Nothing has been written yet.', 'Import anyway');
  if(!go) throw Object.assign(new Error('cancelled before anything was written.'), { cancelled: true });
}
// What an import that stopped shows: where it stopped and whether the stored data is untouched, put back or already live.
function fiShowFailure(e, current, msg){
  const st = getFiState(); if(st){ st.error = e; if(current && st.status[current] !== 'done') fiSet(current, 'error', ''); }
  fiShowResult(e && e.cancelled ? 'warn' : 'err', [{ text: e && e.cancelled ? 'Import ' + msg : 'Import stopped: ' + msg, cls: 'fi-line fi-line-strong' }, { text: e && e.rolledBack ? 'The previous data is back in place.' : e && e.published ? FI_PUBLISHED : 'No changes were published.', cls: 'fi-line fi-line-muted' }]);
}

let fiRunning = false, fiUser = null, fiDb = null, fiAssets = null, fiOwner = false;
function fiSetButtons(){
  const defs = [
    ['importFundamentalDataBtn', 'Scores the uploaded CSV and updates the stock data, right here on this page'],
    ['refreshWatchlistBtn', 'Writes each ticked strategy to a TradingView watchlist, right here on this page', 'Sync selected', 'Syncing…']
  ];
  for(const [bid, tip, idle, busy] of defs){
    const b = /** @type {HTMLButtonElement} */ (document.getElementById(bid));
    if(!b) continue;
    b.disabled = fiRunning || !fiOwner;
    b.textContent = fiRunning ? (busy || 'Importing…') : (idle || 'Import data');
    b.title = fiOwner ? tip : 'Only the owner of this dashboard can import data';
  }
}

// ---- The shared "write it safely" tail used by the imports ----
const WRITE_WORKERS = 3;   // chunks written at the same time

const rolledBackError = (text) => Object.assign(new Error(text), { rolledBack: true });

// Writes the changed chunks, WRITE_WORKERS at a time, stopping at the first failure. Returns { started: ids of the chunks tried, failure }.
async function fiWriteChunks(db, plan){
  const started = new Set(), total = plan.changed.length;
  let failure = null, idx = 0, done = 0;
  fiSet('write', 'running', '0 / ' + total + ' parts', 0);
  const worker = async () => {
    while(!failure && idx < total){
      const c = plan.changed[idx++]; started.add(c.cid);
      try { const body = JSON.parse(JSON.stringify(c.doc)); await fiRetry(() => db.doc('stockData/' + c.cid).set(body)); }
      catch(e){ failure = failure || e; return; }
      done++; fiSet('write', 'running', done + ' / ' + total + ' parts', done / (total + 1));
    }
  };
  await Promise.allSettled(Array.from({ length: WRITE_WORKERS }, worker));
  return { started, failure };
}

// Puts the chunks that were being written back as they were (or deletes the ones that did not exist before).
async function fiRollback(db, raw, started){
  fiSet('write', 'running', 'Something went wrong, putting the old data back…', 0.95);
  for(const cid of started){
    try {
      if(raw.oldCanon[cid] !== undefined) await fiRetry(() => db.doc('stockData/' + cid).set(JSON.parse(raw.oldCanon[cid])));
      else await fiRetry(() => db.doc('stockData/' + cid).delete());
    } catch(e){ console.error('Rollback failed for ' + cid, e); }
  }
}

// The index document goes last, so open pages only switch over once everything else is saved. It is refused when someone else changed it meanwhile.
async function fiPublishIndex(db, raw, plan){
  const cur = await fiRetry(() => db.doc('stockMeta/main').get());
  const cv = cur && cur.exists ? (cur.data() || {}).version : null;
  if(cv !== raw.meta.version) throw new Error('the stock data was changed by someone else while this import was running (version ' + raw.meta.version + ' → ' + cv + ')');
  await fiRetry(() => db.doc('stockMeta/main').set(plan.newMeta));
}

// Keeps the new list in this browser too, so the reload that follows is quick.
async function fiKeepInBrowser(plan, raw){
  try {
    const byId = new Map(plan.changed.map(c => [c.cid, c.doc]));
    await primeStockCache(plan.newMeta.version, [].concat(...plan.newMeta.chunks.map(c => (byId.get(c) || raw.docs[c]).stocks)));
  } catch(e){ console.error('Could not keep the new data in this browser', e); }
}

// Reads the index and a sample of the chunks (first, middle, last) back and compares them with what was written.
async function fiReadBack(db, plan){
  fiSet('verify', 'running', 'Reading it back…', 0.2);
  const back = await fiRetry(() => db.doc('stockMeta/main').get());
  const bm = back && back.exists ? back.data() : null;
  if(!bm || bm.version !== plan.newMeta.version || bm.count !== plan.newMeta.count) throw new Error('read-back check failed: the index shows version ' + (bm && bm.version) + ' / count ' + (bm && bm.count));
  const sample = [plan.changed[0], plan.changed[Math.floor(plan.changed.length / 2)], plan.changed[plan.changed.length - 1]].filter(Boolean);
  for(const c of sample){
    const s = await fiRetry(() => db.doc('stockData/' + c.cid).get());
    if(!s || !s.exists || fiCanon(s.data()) !== fiCanon(c.doc)) throw new Error('read-back check failed for ' + c.cid);
  }
}

// raw = current stored data (fiLoadRaw), stocks = the full new list. Resolves { plan, wrote, nothing }; a failure before the index is published puts the old data back.
async function fiPersist(db, raw, stocks, jobLabel){
  const plan = fiSplit(stocks, raw.meta, raw.oldCanon);
  const sameIndex = JSON.stringify(plan.newMeta.index) === JSON.stringify(raw.meta.index) && JSON.stringify(plan.newMeta.chunks) === JSON.stringify(raw.meta.chunks);
  if(!plan.changed.length && !plan.emptied.length && plan.newMeta.count === raw.meta.count && sameIndex) return { plan, wrote: 0, nothing: true };
  const total = plan.changed.length, written = await fiWriteChunks(db, plan);
  if(written.failure){ await fiRollback(db, raw, written.started); throw rolledBackError('Could not save the stock data (' + fiErr(written.failure) + '). Your previous data was put back.'); }
  try { await fiPublishIndex(db, raw, plan); }
  catch(e){ await fiRollback(db, raw, written.started); throw rolledBackError('Could not publish the new data (' + fiErr(e) + '). Your previous data was put back.'); }
  for(const cid of plan.emptied){ try { await db.doc('stockData/' + cid).delete(); } catch(e){ /* orphan chunk is harmless */ } }
  fiSet('write', 'done', total + ' parts written');
  await fiKeepInBrowser(plan, raw);
  // From here on the new data is live: a failing check must not be reported as "nothing was published".
  try { await fiReadBack(db, plan); } catch(e){ e.published = true; throw e; }
  return { plan, wrote: total, nothing: false };
}

// ---- Import ----
const fiBusyText = when => 'another import is already running (' + when + '). It was started from another tab or device. If that one was closed, it counts as interrupted after 3 minutes without activity; then try again.';

// The steps of one import share `run` = { db, assets, job, current (the step that is running), locked, stopBeat, rec, recId }.
// 1. The uploaded file (after any file still being saved, so the newest upload is the one used).
async function fiStepRead(run){
  run.current = 'read'; fiSet('read', 'running', '', 0.3);
  await uploadsSettled();
  [run.rec, run.recId] = fiNewestUpload(fundamentalCsvUploadLog);
  if(!run.rec) throw new Error('there is no uploaded file waiting. Use "Browse CSV…" to upload the screener.in export first.');
  const csvText = await fiReadUpload(run.assets, run.rec), bad = fundColumnsError(csvText);
  if(bad) throw new Error(bad);
  fiSet('read', 'done', run.rec.filename);
  return csvText;
}

// 2. The current data, exactly as stored.
async function fiStepLoad(run){
  run.current = 'load'; fiSet('load', 'running', '', 0);
  const raw = await fiLoadRaw(run.db, (d, n) => fiSet('load', 'running', d + ' / ' + n + ' parts', d / n));
  fiSet('load', 'done', raw.stocks.length.toLocaleString('en-IN') + ' stocks (data v' + raw.meta.version + ')');
  return raw;
}

// 3. Scoring the file against the stored list (in place). Returns the engine's result and what the list looked like before.
async function fiStepScore(run, raw, csvText){
  run.current = 'score'; fiSet('score', 'running', '', 0.3); await sleep(30);
  const prev = fiPrevInfo(raw.stocks), before = {};
  for(const s of raw.stocks) before[s.verdict] = (before[s.verdict] || 0) + 1;
  const res = applyFundamental(csvText, raw.stocks, fiDay(run.rec.uploadedAt));
  fiSet('score', 'done', res.rescored.toLocaleString('en-IN') + ' rescored, ' + res.onboarded.length + ' new');
  return { res, prev, before };
}

// 4. The integrity checks: hard failures stop the import, warnings are put to the person.
async function fiStepCheck(run, raw, scored){
  run.current = 'check'; fiSet('check', 'running', '', 0.5); await sleep(30);
  const chk = fiCheck(raw.stocks, scored.prev), thin = thinFileWarning(scored.res.rescored, raw.stocks.length);
  if(thin) chk.soft.unshift(thin);
  fiThrowHard(chk);
  fiSet('check', 'done', 'passed');
  await fiConfirmSoft(chk.soft);
  return chk;
}

// 5. Writing and verifying the data, then the score history (the trend on the stock page; it never fails the import).
async function fiStepWrite(run, raw){
  run.current = 'write';
  const out = await fiPersist(run.db, raw, raw.stocks, 'import');
  run.current = 'verify';
  await recordScoreHistory(run.db, raw.stocks);
  if(out.nothing) fiSet('write', 'done', 'nothing changed');
  return out;
}

// 6. Marking the upload as imported, freeing the lock and showing the result.
async function fiStepFinish(run, parts){
  const { raw, scored, chk, out } = parts, res = scored.res, dataVer = out.nothing ? raw.meta.version : out.plan.newMeta.version;
  const note = importNote(res, scored.before, res.verdictMix);
  fiSet('verify', 'running', 'Updating the upload history…', 0.7);
  const upd = { status: 'processed', processedAt: new Date().toISOString(), processedNote: note };
  const logErr = await saveRecord('fund', run.recId, Object.assign({}, run.rec, upd), run.db);
  await fiRetry(() => run.job.set({ status: 'done', finishedAt: new Date().toISOString(), note })); run.locked = false;
  fiSet('verify', 'done', 'data v' + dataVer);
  const noVal = newWithoutValue(raw.stocks, res.onboarded, fiSym);
  fiShowResult('ok', importResultLines({ res, before: scored.before, chk, nothing: out.nothing, noVal, logErr }));
}

async function fiRunImport(){
  if(fiRunning || !fiOwner) return;
  const db = fiDb, assets = fiAssets;
  if(!db || !assets){ fiReset('Import data'); fiShowResult('err', [{ text: 'File storage or the database is not available in this view, so the import cannot run here.' }]); return; }
  setFiPfx('');
  fiRunning = true; fiSetButtons(); fiReset('Importing fundamental data');
  const run = { db, assets, job: db.doc('importJobs/fundamental'), current: 'read', locked: false, stopBeat: () => {}, rec: null, recId: null };
  try {
    // one import at a time (a job that has gone quiet for a few minutes counts as interrupted)
    run.stopBeat = await fiTakeLock(run.job, fiBusyText); run.locked = true;
    const csvText = await fiStepRead(run), raw = await fiStepLoad(run), scored = await fiStepScore(run, raw, csvText);
    const chk = await fiStepCheck(run, raw, scored), out = await fiStepWrite(run, raw);
    await fiStepFinish(run, { raw, scored, chk, out });
  } catch(e){
    console.error('Fundamental import failed', e);
    recordAttempt('fund', run.rec, run.recId, e, db);
    const msg = (e && e.message) ? e.message : String(e);
    fiShowFailure(e, run.current, msg);
    if(run.locked) await fiMarkFailed(run.job, msg);
  } finally {
    run.stopBeat(); fiRunning = false; fiSetButtons();
  }
}

function init_import_fund_import(){
  registerBusy(() => fiRunning);
  // leaving the page in the middle of an import or sync interrupts it: ask first
  window.addEventListener('beforeunload', e => { if(fiRunning){ e.preventDefault(); e.returnValue = ''; } });

(async function fiInit(){
  try {
    if(!(typeof claude !== 'undefined' && claude && typeof claude.use === 'function')){ fiSetButtons(); return; }
    const [db, assets, user] = await Promise.all([claude.use('db').catch(() => null), claude.use('assets').catch(() => null), claude.use('user').catch(() => null)]);
    fiDb = db; fiAssets = assets; fiUser = user;
    fiOwner = !!(db && assets && user && user.isOwner());
  } catch(e){ fiOwner = false; }
  fiSetButtons();
  paintLastRuns(fiDb);
  const b = fiEl('importFundamentalDataBtn');
  if(b) b.addEventListener('click', fiRunImport);
  const wb = document.getElementById('refreshWatchlistBtn');
  if(wb) wb.addEventListener('click', () => (typeof wlRunSync === 'function' ? wlRunSync() : undefined));
})();
}

function getFiRunning(){ return fiRunning; }
function getFiDb(){ return fiDb; }
function getFiOwner(){ return fiOwner; }
function setFiRunning(v){ fiRunning = v; }

export { fiErr, fiMarkFailed, fiRetry, fiTakeLock, fiSetButtons, getFiDb, getFiOwner, getFiRunning, init_import_fund_import, setFiRunning };
