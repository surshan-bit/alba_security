// Fundamental Score import: steps, backups, restore and database writes.
import { fundamentalCsvUploadLog, getDb } from '../core/store.js';
import { formatBytes, formatUploadTimestamp } from '../core/util.js';
import { pruneLogCollection } from '../joblogs/panels.js';
import { recordAttempt, renderLastFile } from './last-file.js';
import { fiAsk, fiEl, fiReset, fiSet, fiShowResult, getFiState, setFiPfx } from './panel.js';
import { albaApplyFundamental } from './fund-engine.js';
import { albaTiRunImport } from './tech-import.js';
import { albaWlRunSync } from './wlsync.js';

// ====================================================================================================
// FUNDAMENTAL IMPORT, IN THE PAGE (added 2026-10-09). "Import data" no longer opens a Claude chat:
// the uploaded CSV (kept in the asset store + fundamentalCsvUploadLog) is scored here with the same
// v3 engine the saved scripts used, the current stock data is backed up first, the changed chunks are
// written to the database with a progress bar, and a one-click Restore puts a backup back.
// Owner only (writing stock data and the asset store need the artifact's write bit).
// ====================================================================================================
const ALBA_FI = { HARD: 240000, SOFT: 200000, KEEP: 2, STALE_MS: 20 * 60 * 1000 };
const ALBA_FI_COLUMNS = ['Name','BSE Code','NSE Code','ISIN Code','Industry Group','Industry','Current Price','Intrinsic Value','Book value','Profit growth','Profit growth 3Years','Profit growth 5Years','Sales growth 3Years','Return on invested capital','Return on capital employed','Return on equity','OPM','Price to Earning','Industry PE','PEG Ratio','Pledged percentage','Interest Coverage','Debt to equity','Change in promoter holding','Piotroski score','Quick ratio','Altman Z Score','Current ratio','Contingent liabilities','Average return on equity 7Years','Average return on equity 10Years','Median return on capital employed 10Years','Free cash flow 3years','Free cash flow 5years','Operating cash flow 3years','Operating cash flow 5years','CROIC','Graham','Change in FII holding 3Years','Change in DII holding 3Years','Historical PE 5Years','Average debtor days 3years','NCAVPS','Number of Shareholders'];
const ALBA_FI_PUBLISHED = 'The new data had already been saved when this failed, so it is live. Check the stock list, or restore a backup below.';
const albaFiSleep = ms => new Promise(r => setTimeout(r, ms));
const albaFiSym = s => s.ticker.split('·')[0].trim();
const albaFiSid = id => String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_') || 'x';
const albaFiSize = o => new TextEncoder().encode(JSON.stringify(o)).length;
const albaFiDay = iso => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch(e){ return new Date().toISOString().slice(0, 10); } };
function albaFiCanon(o){
  if(Array.isArray(o)) return '[' + o.map(albaFiCanon).join(',') + ']';
  if(o && typeof o === 'object') return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + albaFiCanon(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
async function albaFiRetry(fn){
  let err;
  for(let a = 0; a < 5; a++){
    try { return await fn(); }
    catch(e){
      err = e;
      const c = e && e.code;
      if(c === 'invalid_argument' || c === 'not_granted' || c === 'too_large' || c === 'quota_exceeded' || c === 'quota_or_state') throw e;
      await albaFiSleep(700 * Math.pow(2, a) + Math.random() * 400);
    }
  }
  throw err;
}
function albaFiErr(e){ return (e && (e.message || e.code)) ? ((e.code ? e.code + ': ' : '') + (e.message || '')).replace(/: $/, '') : String(e); }

// ---- Reading the current stock data exactly as stored (NOT the page's overlaid copy) ----
async function albaFiLoadRaw(db, onProgress){
  const ms = await albaFiRetry(() => db.doc('stockMeta/main').get());
  const meta = ms && ms.exists ? JSON.parse(JSON.stringify(ms.data())) : null;
  if(!meta || !Array.isArray(meta.chunks)) throw new Error('the stock index (stockMeta/main) was not found');
  const docs = {}, oldCanon = {};
  let next = 0, done = 0;
  const worker = async () => {
    while(next < meta.chunks.length){
      const cid = meta.chunks[next++];
      const snap = await albaFiRetry(() => db.doc('stockData/' + cid).get());
      const d = snap && snap.exists ? JSON.parse(JSON.stringify(snap.data())) : null;
      if(!d || !Array.isArray(d.stocks)) throw new Error('chunk ' + cid + ' is missing');
      docs[cid] = d; oldCanon[cid] = albaFiCanon(d);
      done++; onProgress(done, meta.chunks.length);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  const stocks = [].concat(...meta.chunks.map(c => docs[c].stocks));
  if(stocks.length !== meta.count) throw new Error('expected ' + meta.count + ' stocks but read ' + stocks.length);
  return { meta, docs, oldCanon, stocks };
}

// ---- Integrity checks (the saved check_fundamental + precheck_data scripts) ----
function albaFiPrevInfo(stocks){
  const m = new Map(), n = g => g && ((g.positive || []).length + (g.negative || []).length);
  for(const s of stocks) m.set(albaFiSym(s), { score: s.score, verdict: s.verdict, hasGlobal: !!n(s.globalFactors), hasTech: !!(s.technical && s.technical.score != null) });
  return m;
}
function albaFiCheck(stocks, prev){
  const hard = [], soft = [];
  const band = x => x >= 8 ? 'buy' : x >= 6 ? 'mbuy' : x >= 5 ? 'hold' : 'avoid';
  const list = a => a.slice(0, 5).join(', ') + (a.length > 5 ? ' …' : '');
  const seen = new Set(), dups = [], badShape = [], badNum = [], badSum = [], badVerdict = [], badPillar = [];
  if(stocks.length < 2000) hard.push('only ' + stocks.length + ' stocks in the result');
  for(const s of stocks){
    const t = albaFiSym(s); const u = t.toUpperCase();
    if(seen.has(u)) dups.push(t); seen.add(u);
    const f = s.fundamentals && s.fundamentals.factors;
    if(!Array.isArray(f) || f.length !== 9 || typeof s.score !== 'number'){ badShape.push(t); continue; }
    if(f.some(x => typeof x.score !== 'number' || !isFinite(x.score))) badNum.push(t);
    const sum = f.reduce((a, x) => a + (typeof x.score === 'number' ? x.score : 0), 0), w = f.reduce((a, x) => a + x.weight, 0);
    if(Math.abs(sum - s.score) > 0.05 || Math.abs(w - 10) > 0.02) badSum.push(t);
    if(s.verdict !== band(s.score)) badVerdict.push(t);
    if(!s.pillars || typeof s.pillars.val !== 'number') badPillar.push(t);
  }
  if(dups.length) hard.push(dups.length + ' duplicate tickers: ' + list(dups));
  if(badShape.length) hard.push(badShape.length + ' stocks without a complete 9-factor block: ' + list(badShape));
  if(badNum.length) hard.push(badNum.length + ' stocks with a non-numeric factor score: ' + list(badNum));
  if(badSum.length) hard.push(badSum.length + ' stocks where the factors do not add up to the score: ' + list(badSum));
  if(badVerdict.length) hard.push(badVerdict.length + ' verdicts that disagree with the score bands: ' + list(badVerdict));
  if(badPillar.length) hard.push(badPillar.length + ' stocks with a non-numeric pillars.val: ' + list(badPillar));
  let moved = 0, maxMove = 0; const lostGlobal = [], lostTech = [];
  const now = new Set();
  for(const s of stocks){
    const t = albaFiSym(s); now.add(t);
    const p = prev.get(t); if(!p) continue;
    if(typeof s.score === 'number' && typeof p.score === 'number'){ const d = Math.abs(s.score - p.score); if(d >= 1.0) moved++; if(d > maxMove) maxMove = d; }
    const n = g => g && ((g.positive || []).length + (g.negative || []).length);
    if(p.hasGlobal && !n(s.globalFactors)) lostGlobal.push(t);
    if(p.hasTech && !(s.technical && s.technical.score != null)) lostTech.push(t);
  }
  const lost = []; for(const t of prev.keys()) if(!now.has(t)) lost.push(t);
  if(lost.length) hard.push(lost.length + ' stocks would disappear: ' + list(lost));
  if(lostGlobal.length) hard.push(lostGlobal.length + ' stocks would lose their Global & Macro content: ' + list(lostGlobal));
  if(lostTech.length) hard.push(lostTech.length + ' stocks would lose their technical score: ' + list(lostTech));
  if(moved > 40) soft.push(moved + ' stocks moved by 1.0 point or more (normally under 40). That can be real after a big data change, or a sign of a wrong file.');
  return { hard, soft, moved, maxMove };
}

// ---- Packing the list back into chunk documents (the saved stockdb.py split) ----
function albaFiSplit(stocks, meta, oldCanon){
  const oldIndex = meta.index || {}, ids = meta.chunks.slice();
  const buckets = {}; ids.forEach(c => { buckets[c] = []; });
  const spill = [], seen = new Set();
  for(const s of stocks){
    const k = albaFiSid(albaFiSym(s));
    if(seen.has(k)) throw new Error('duplicate ticker ' + k);
    seen.add(k);
    const cid = oldIndex[k];
    if(cid && buckets[cid]) buckets[cid].push(s); else spill.push(s);
  }
  const mk = (cid, arr) => ({ chunk: parseInt(cid.slice(1), 10), count: arr.length, stocks: arr });
  for(const cid of ids){            // a chunk that grew too large hands its tail to the spill list
    const arr = buckets[cid];
    while(arr.length > 1 && albaFiSize(mk(cid, arr)) >= ALBA_FI.HARD){
      const cut = Math.max(1, Math.ceil(arr.length * 0.1));
      spill.unshift(...arr.splice(arr.length - cut, cut));
    }
  }
  let nextNum = Math.max(...ids.map(c => parseInt(c.slice(1), 10))) + 1;
  let cur = ids[ids.length - 1], curBytes = albaFiSize(mk(cur, buckets[cur]));
  for(const s of spill){
    const b = albaFiSize(s) + 1;
    if(curBytes + b > ALBA_FI.SOFT){
      cur = 'c' + String(nextNum++).padStart(3, '0'); ids.push(cur); buckets[cur] = []; curBytes = albaFiSize(mk(cur, []));
    }
    buckets[cur].push(s); curBytes += b;
  }
  const finalIds = ids.filter(c => buckets[c].length);
  const index = {};
  for(const c of finalIds) for(const s of buckets[c]) index[albaFiSid(albaFiSym(s))] = c;
  const changed = [];
  for(const c of finalIds){
    const doc = mk(c, buckets[c]);
    if(oldCanon[c] === undefined || albaFiCanon(doc) !== oldCanon[c]) changed.push({ cid: c, doc });
  }
  const emptied = meta.chunks.filter(c => !finalIds.includes(c));
  const newMeta = { version: (meta.version || 0) + 1, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), count: stocks.length, chunks: finalIds, index };
  return { changed, newMeta, emptied, finalIds };
}

// ---- Backups (kept in the asset store, listed in backupLog; newest 5 are kept) ----
async function albaFiBackupLog(db){
  const q = await albaFiRetry(() => db.collection('backupLog').get());
  return q.docs.map(d => ({ id: d.id, ...(d.data() || {}) })).filter(b => b.kind === 'stocks-backup' && b.format === 'stocks.json' && b.assetId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function albaFiMakeBackup(db, assets, json, count, version, label){
  const blob = new Blob([json], { type: 'application/json' });
  const up = await albaFiRetry(() => assets.upload(blob));
  const createdAt = new Date().toISOString();
  const doc = { kind: 'stocks-backup', format: 'stocks.json', label, dataVersion: version, createdAt, stockCount: count, bytes: up.sizeBytes != null ? up.sizeBytes : blob.size, assetId: up.id, assetUrl: up.url };
  await albaFiRetry(() => db.doc('backupLog/' + albaFiSid('stocks-' + createdAt)).set(doc));
  try {     // keep only the newest ALBA_FI.KEEP
    const all = await albaFiBackupLog(db);
    for(const b of all.slice(ALBA_FI.KEEP)){
      try { await assets.delete(b.assetId); } catch(e){ /* asset may already be gone */ }
      await db.doc('backupLog/' + b.id).delete();
    }
  } catch(e){ console.error('Backup clean-up failed', e); }
  return doc;
}

let fiRunning = false, fiUser = null, fiDb = null, fiAssets = null, fiOwner = false;
function fiSetButtons(){
  const defs = [
    ['importFundamentalDataBtn', 'Scores the uploaded CSV and updates the stock data, right here on this page'],
    ['importTechnicalDataBtn', 'Scores the uploaded Growth List and updates the technical data, right here on this page'],
    ['refreshWatchlistBtn', 'Rebuilds the four Alba watchlists in TradingView from the current verdicts, right here on this page', 'Sync now', 'Syncing…']
  ];
  for(const [bid, tip, idle, busy] of defs){
    const b = document.getElementById(bid);
    if(!b) continue;
    b.disabled = fiRunning || !fiOwner;
    b.textContent = fiRunning ? (busy || 'Importing…') : (idle || 'Import data');
    b.title = fiOwner ? tip : 'Only the owner of this dashboard can import data';
  }
  document.querySelectorAll('.fi-restore-btn').forEach(x => { x.disabled = fiRunning || !fiOwner; });
}

// ---- The shared "write it safely" tail used by both Import and Restore ----
// raw = current stored data (albaFiLoadRaw), stocks = the full new list, summaryExtra = text lines for the result card.
async function albaFiPersist(db, raw, stocks, jobLabel){
  const plan = albaFiSplit(stocks, raw.meta, raw.oldCanon);
  const sameIndex = JSON.stringify(plan.newMeta.index) === JSON.stringify(raw.meta.index) && JSON.stringify(plan.newMeta.chunks) === JSON.stringify(raw.meta.chunks);
  if(!plan.changed.length && !plan.emptied.length && plan.newMeta.count === raw.meta.count && sameIndex) return { plan, wrote: 0, nothing: true };
  const started = new Set(); let failure = null, idx = 0, done = 0;
  const total = plan.changed.length;
  fiSet('write', 'running', '0 / ' + total + ' parts', 0);
  const worker = async () => {
    while(!failure && idx < total){
      const c = plan.changed[idx++]; started.add(c.cid);
      try { const body = JSON.parse(JSON.stringify(c.doc)); await albaFiRetry(() => db.doc('stockData/' + c.cid).set(body)); }
      catch(e){ failure = failure || e; return; }
      done++; fiSet('write', 'running', done + ' / ' + total + ' parts', done / (total + 1));
    }
  };
  await Promise.allSettled(Array.from({ length: 3 }, worker));
  const rollback = async () => {
    fiSet('write', 'running', 'Something went wrong, putting the old data back…', 0.95);
    for(const cid of started){
      try {
        if(raw.oldCanon[cid] !== undefined) await albaFiRetry(() => db.doc('stockData/' + cid).set(JSON.parse(raw.oldCanon[cid])));
        else await albaFiRetry(() => db.doc('stockData/' + cid).delete());
      } catch(e){ console.error('Rollback failed for ' + cid, e); }
    }
  };
  if(failure){ await rollback(); const e = new Error('Could not save the stock data (' + albaFiErr(failure) + '). Your previous data was put back.'); e.rolledBack = true; throw e; }
  // The index document goes last, so open pages only switch over once everything else is saved.
  try {
    const cur = await albaFiRetry(() => db.doc('stockMeta/main').get());
    const cv = cur && cur.exists ? (cur.data() || {}).version : null;
    if(cv !== raw.meta.version) throw new Error('the stock data was changed by someone else while this import was running (version ' + raw.meta.version + ' → ' + cv + ')');
    await albaFiRetry(() => db.doc('stockMeta/main').set(plan.newMeta));
  } catch(e){ await rollback(); const err = new Error('Could not publish the new data (' + albaFiErr(e) + '). Your previous data was put back.'); err.rolledBack = true; throw err; }
  for(const cid of plan.emptied){ try { await db.doc('stockData/' + cid).delete(); } catch(e){ /* orphan chunk is harmless */ } }
  fiSet('write', 'done', total + ' parts written');
  // verify: index version/count, and a sample of chunks read back
  try {   // from here on the new data is live: a failing check must not be reported as "nothing was published"
  fiSet('verify', 'running', 'Reading it back…', 0.2);
  const back = await albaFiRetry(() => db.doc('stockMeta/main').get());
  const bm = back && back.exists ? back.data() : null;
  if(!bm || bm.version !== plan.newMeta.version || bm.count !== plan.newMeta.count) throw new Error('read-back check failed: the index shows version ' + (bm && bm.version) + ' / count ' + (bm && bm.count));
  const sample = [plan.changed[0], plan.changed[Math.floor(plan.changed.length / 2)], plan.changed[plan.changed.length - 1]].filter(Boolean);
  for(const c of sample){
    const s = await albaFiRetry(() => db.doc('stockData/' + c.cid).get());
    if(!s || !s.exists || albaFiCanon(s.data()) !== albaFiCanon(c.doc)) throw new Error('read-back check failed for ' + c.cid);
  }
  } catch(e){ e.published = true; throw e; }
  return { plan, wrote: total, nothing: false };
}

// ---- Import ----
async function albaFiRunImport(){
  if(fiRunning || !fiOwner) return;
  const db = fiDb, assets = fiAssets;
  if(!db || !assets){ fiReset('Import data'); fiShowResult('err', [{ text: 'File storage or the database is not available in this view, so the import cannot run here.' }]); return; }
  setFiPfx('');
  fiRunning = true; fiSetButtons(); fiReset('Importing fundamental data');
  const job = db.doc('importJobs/fundamental'); let locked = false, current = 'read';
  let rec = null, recId = null;
  try {
    // one import at a time (a lock older than 20 minutes is treated as abandoned)
    const lk = await albaFiRetry(() => job.get()); const ld = lk && lk.exists ? lk.data() : null;
    if(ld && ld.status === 'running' && Date.now() - (Date.parse(ld.startedAt) || 0) < ALBA_FI.STALE_MS) throw new Error('another import is already running (started ' + formatUploadTimestamp(ld.startedAt) + '). Try again in a few minutes.');
    await albaFiRetry(() => job.set({ status: 'running', startedAt: new Date().toISOString() })); locked = true;

    // 1. the uploaded file
    current = 'read'; fiSet('read', 'running', '', 0.3);
    for(const [id, r] of fundamentalCsvUploadLog.entries()){ if(r.status === 'uploaded' && (!rec || String(r.uploadedAt) > String(rec.uploadedAt))){ rec = r; recId = id; } }
    if(!rec) throw new Error('there is no uploaded file waiting. Use "Browse CSV…" to upload the screener.in export first.');
    const resp = await fetch('/_blob/' + rec.assetId);
    if(!resp.ok) throw new Error('could not read the stored file "' + rec.filename + '" (' + resp.status + ')');
    const csvText = await resp.text();
    const header = (csvText.split(/\r?\n/, 1)[0] || '').split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const missing = ALBA_FI_COLUMNS.filter(c => !header.includes(c.toLowerCase()));
    if(missing.length) throw new Error('the file does not match the expected 44-column screener.in layout. Missing: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? ' … +' + (missing.length - 6) : '') + '.');
    fiSet('read', 'done', rec.filename);

    // 2. current data
    current = 'load'; fiSet('load', 'running', '', 0);
    const raw = await albaFiLoadRaw(db, (d, n) => fiSet('load', 'running', d + ' / ' + n + ' parts', d / n));
    fiSet('load', 'done', raw.stocks.length.toLocaleString('en-IN') + ' stocks (data v' + raw.meta.version + ')');

    // 3. backup
    current = 'backup'; fiSet('backup', 'running', 'Saving a copy…', 0.4);
    const bk = await albaFiMakeBackup(db, assets, JSON.stringify(raw.stocks), raw.stocks.length, raw.meta.version, 'Before importing ' + rec.filename + ' (data v' + raw.meta.version + ')');
    fiSet('backup', 'done', formatBytes(bk.bytes));

    // 4. score
    current = 'score'; fiSet('score', 'running', '', 0.3); await albaFiSleep(30);
    const prev = albaFiPrevInfo(raw.stocks), mixBefore = {};
    for(const s of raw.stocks) mixBefore[s.verdict] = (mixBefore[s.verdict] || 0) + 1;
    const res = albaApplyFundamental(csvText, raw.stocks, albaFiDay(rec.uploadedAt));
    fiSet('score', 'done', res.rescored.toLocaleString('en-IN') + ' rescored, ' + res.onboarded.length + ' new');

    // 5. checks
    current = 'check'; fiSet('check', 'running', '', 0.5); await albaFiSleep(30);
    const chk = albaFiCheck(raw.stocks, prev);
    if(chk.hard.length) throw new Error('integrity check failed, nothing was written:\n• ' + chk.hard.slice(0, 6).join('\n• '));
    fiSet('check', 'done', 'passed');
    if(chk.soft.length){
      const go = await fiAsk(chk.soft.join(' ') + ' Nothing has been written yet.', 'Import anyway');
      if(!go) throw Object.assign(new Error('cancelled before anything was written.'), { cancelled: true });
    }

    // 6 + 7. write and verify
    current = 'write';
    const out = await albaFiPersist(db, raw, raw.stocks, 'import');
    current = 'verify';
    const dataVer = out.nothing ? raw.meta.version : out.plan.newMeta.version;
    if(out.nothing){ fiSet('write', 'done', 'nothing changed'); }
    const mixAfter = res.verdictMix;
    const note = 'Imported in the page: ' + res.rescored + ' rescored, ' + res.onboarded.length + ' new, ' + res.dropped.length + ' left unchanged (not in the file). Strong ' + (mixBefore.buy || 0) + '→' + (mixAfter.buy || 0) + ', Good ' + (mixBefore.mbuy || 0) + '→' + (mixAfter.mbuy || 0) + ', Hold ' + (mixBefore.hold || 0) + '→' + (mixAfter.hold || 0) + ', Avoid ' + (mixBefore.avoid || 0) + '→' + (mixAfter.avoid || 0) + '.';
    fiSet('verify', 'running', 'Updating the upload history…', 0.7);
    try {
      const upd = { status: 'processed', processedAt: new Date().toISOString(), processedNote: note };
      Object.assign(rec, upd); fundamentalCsvUploadLog.put(recId, rec);
      const logDb = getDb();
      if(logDb){
        await logDb.collection('fundamentalCsvUploadLog').doc(recId).update(upd);
        await pruneLogCollection(logDb, 'fundamentalCsvUploadLog', fundamentalCsvUploadLog, 'uploadedAt');
      }
    } catch(e){ console.error('Could not update the upload log', e); }
    renderLastFile('fund');
    await albaFiRetry(() => job.set({ status: 'done', finishedAt: new Date().toISOString(), note })); locked = false;
    fiSet('verify', 'done', 'data v' + dataVer);
    const lines = [
      { text: out.nothing ? 'Import complete: the file produced no changes to the stored data.' : 'Import complete.', cls: 'fi-line fi-line-strong' },
      { text: res.rescored.toLocaleString('en-IN') + ' stocks rescored · ' + res.onboarded.length + ' new · ' + res.dropped.length + ' not in the file (left unchanged).' },
      { text: 'Strong ' + (mixBefore.buy || 0) + ' → ' + (mixAfter.buy || 0) + ' · Good ' + (mixBefore.mbuy || 0) + ' → ' + (mixAfter.mbuy || 0) + ' · Hold ' + (mixBefore.hold || 0) + ' → ' + (mixAfter.hold || 0) + ' · Avoid ' + (mixBefore.avoid || 0) + ' → ' + (mixAfter.avoid || 0) + '.' },
      { text: chk.moved + ' stocks moved by 1.0 point or more (largest move ' + chk.maxMove.toFixed(2) + ').' }
    ];
    if(res.onboarded.length) lines.push({ text: 'New: ' + res.onboarded.slice(0, 15).join(', ') + (res.onboarded.length > 15 ? ' … +' + (res.onboarded.length - 15) : '') + '. They use the default Screener.in link and ' + (res.bseOnly.length ? 'have no TradingView chart mapping yet (BSE-only: ' + res.bseOnly.slice(0, 10).join(', ') + (res.bseOnly.length > 10 ? ' …' : '') + ').' : 'need no chart mapping.'), cls: 'fi-line fi-line-muted' });
    fiShowResult('ok', lines);
  } catch(e){
    console.error('Fundamental import failed', e);
    recordAttempt('fund', rec, recId, e);
    const st = getFiState(); if(st){ st.error = e; if(current && st.status[current] !== 'done') fiSet(current, 'error', ''); }
    const msg = (e && e.message) ? e.message : String(e);
    fiShowResult(e && e.cancelled ? 'warn' : 'err', [{ text: e && e.cancelled ? 'Import ' + msg : 'Import stopped: ' + msg, cls: 'fi-line fi-line-strong' }, { text: e && e.rolledBack ? 'The previous data is back in place.' : e && e.published ? ALBA_FI_PUBLISHED : 'No changes were published.', cls: 'fi-line fi-line-muted' }]);
    if(locked){ try { await job.set({ status: 'failed', finishedAt: new Date().toISOString(), error: msg.slice(0, 500) }); } catch(x){} }
  } finally {
    fiRunning = false; fiSetButtons(); albaFiRenderBackups();
  }
}

// ---- Restore ----
async function albaFiRunRestore(b, pfx){
  if(fiRunning || !fiOwner || !fiDb || !fiAssets) return;
  setFiPfx(pfx || '');
  const go = await (async () => { fiReset('Restore a backup'); return fiAsk('Restore the stock data saved on ' + formatUploadTimestamp(b.createdAt) + ' (' + (b.stockCount || '?') + ' stocks)? Today\'s data is backed up first, so this can be undone.', 'Restore'); })();
  if(!go){ const p = fiEl('fundImportPanel'); if(p) p.hidden = true; return; }
  fiRunning = true; fiSetButtons(); fiReset('Restoring a backup');
  const db = fiDb, assets = fiAssets, job = db.doc('importJobs/fundamental'); let locked = false, current = 'read';
  try {
    const lk = await albaFiRetry(() => job.get()); const ld = lk && lk.exists ? lk.data() : null;
    if(ld && ld.status === 'running' && Date.now() - (Date.parse(ld.startedAt) || 0) < ALBA_FI.STALE_MS) throw new Error('an import is already running. Try again in a few minutes.');
    await albaFiRetry(() => job.set({ status: 'running', startedAt: new Date().toISOString() })); locked = true;
    fiSet('read', 'running', 'Downloading the backup…', 0.3);
    const resp = await fetch('/_blob/' + b.assetId); if(!resp.ok) throw new Error('the backup file could not be read (' + resp.status + ')');
    const list = await resp.json();
    if(!Array.isArray(list) || list.length < 2000 || !list.every(s => s && typeof s.ticker === 'string')) throw new Error('the backup file does not look like a stock list');
    fiSet('read', 'done', list.length.toLocaleString('en-IN') + ' stocks');
    current = 'load'; fiSet('load', 'running', '', 0);
    const raw = await albaFiLoadRaw(db, (d, n) => fiSet('load', 'running', d + ' / ' + n + ' parts', d / n));
    fiSet('load', 'done', raw.stocks.length.toLocaleString('en-IN') + ' stocks (data v' + raw.meta.version + ')');
    current = 'backup'; fiSet('backup', 'running', 'Saving today\'s data…', 0.4);
    const bk = await albaFiMakeBackup(db, assets, JSON.stringify(raw.stocks), raw.stocks.length, raw.meta.version, 'Before restoring the backup of ' + formatUploadTimestamp(b.createdAt) + ' (data v' + raw.meta.version + ')');
    fiSet('backup', 'done', formatBytes(bk.bytes));
    fiSet('score', 'done', 'not needed'); fiSet('check', 'done', 'not needed');
    current = 'write';
    const out = await albaFiPersist(db, raw, list, 'restore');
    current = 'verify';
    await albaFiRetry(() => job.set({ status: 'done', finishedAt: new Date().toISOString(), note: 'Restored the backup of ' + b.createdAt })); locked = false;
    fiSet('verify', 'done', 'data v' + (out.nothing ? raw.meta.version : out.plan.newMeta.version));
    fiShowResult('ok', [{ text: 'Restore complete.', cls: 'fi-line fi-line-strong' }, { text: 'The data saved on ' + formatUploadTimestamp(b.createdAt) + ' is live again (' + list.length.toLocaleString('en-IN') + ' stocks).' }]);
  } catch(e){
    console.error('Restore failed', e);
    const st = getFiState(); if(st){ st.error = e; if(current && st.status[current] !== 'done') fiSet(current, 'error', ''); }
    const msg = (e && e.message) ? e.message : String(e);
    fiShowResult('err', [{ text: 'Restore stopped: ' + msg, cls: 'fi-line fi-line-strong' }, { text: e && e.rolledBack ? 'The data that was live before is back in place.' : e && e.published ? ALBA_FI_PUBLISHED : 'No changes were published.', cls: 'fi-line fi-line-muted' }]);
    if(locked){ try { await job.set({ status: 'failed', finishedAt: new Date().toISOString(), error: msg.slice(0, 500) }); } catch(x){} }
  } finally {
    fiRunning = false; fiSetButtons(); albaFiRenderBackups();
  }
}

async function albaFiRenderBackups(){
  let list = null, err = null;
  if(fiDb && fiOwner){ try { list = await albaFiBackupLog(fiDb); } catch(e){ err = e; } }
  for(const pfx of ['', 'ti_']){
    const host = document.getElementById(pfx + 'fiBackups'); if(!host) continue;
    host.hidden = !(fiDb && fiOwner);
    host.textContent = '';
    if(!fiDb || !fiOwner) continue;
    const t = document.createElement('div'); t.className = 'upload-title'; t.style.marginBottom = '10px'; t.textContent = 'Backups (newest ' + ALBA_FI.KEEP + ' kept)'; host.appendChild(t);
    if(err){ const p = document.createElement('p'); p.className = 'upload-hint'; p.textContent = 'Could not list backups: ' + albaFiErr(err); host.appendChild(p); continue; }
    if(!list.length){ const p = document.createElement('p'); p.className = 'upload-hint'; p.textContent = 'No backups yet. One is saved automatically before every import.'; host.appendChild(p); continue; }
    for(const b of list.slice(0, ALBA_FI.KEEP)){
      const row = document.createElement('div'); row.className = 'fi-backup-row';
      const info = document.createElement('div'); info.className = 'fi-backup-info';
      const a = document.createElement('div'); a.className = 'fi-backup-title'; a.textContent = b.label || 'Backup';
      const c = document.createElement('div'); c.className = 'upload-hint'; c.textContent = formatUploadTimestamp(b.createdAt) + ' · ' + (b.stockCount || '?') + ' stocks · ' + formatBytes(b.bytes);
      info.appendChild(a); info.appendChild(c);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'select-mode-btn fi-restore-btn'; btn.textContent = 'Restore'; btn.disabled = fiRunning || !fiOwner;
      btn.addEventListener('click', () => albaFiRunRestore(b, pfx));
      row.appendChild(info); row.appendChild(btn); host.appendChild(row);
    }
  }
}

function init_import_fund_import(){

(async function albaFiInit(){
  try {
    if(!(typeof claude !== 'undefined' && claude && typeof claude.use === 'function')){ fiSetButtons(); return; }
    const [db, assets, user] = await Promise.all([claude.use('db').catch(() => null), claude.use('assets').catch(() => null), claude.use('user').catch(() => null)]);
    fiDb = db; fiAssets = assets; fiUser = user;
    fiOwner = !!(db && assets && user && user.isOwner());
  } catch(e){ fiOwner = false; }
  fiSetButtons();
  const b = fiEl('importFundamentalDataBtn');
  if(b) b.addEventListener('click', albaFiRunImport);
  const wb = document.getElementById('refreshWatchlistBtn');
  if(wb) wb.addEventListener('click', () => (typeof albaWlRunSync === 'function' ? albaWlRunSync() : undefined));
  const tb = document.getElementById('importTechnicalDataBtn');
  if(tb) tb.addEventListener('click', () => (typeof albaTiRunImport === 'function' ? albaTiRunImport() : undefined));
  if(fiOwner) albaFiRenderBackups();
})();
}

function getFiRunning(){ return fiRunning; }
function getFiDb(){ return fiDb; }
function getFiAssets(){ return fiAssets; }
function getFiOwner(){ return fiOwner; }
function setFiRunning(v){ fiRunning = v; }

export { ALBA_FI, ALBA_FI_PUBLISHED, albaFiCheck, albaFiDay, albaFiErr, albaFiLoadRaw, albaFiMakeBackup, albaFiPersist, albaFiPrevInfo, albaFiRenderBackups, albaFiRetry, albaFiSleep, albaFiSym, fiSetButtons, getFiAssets, getFiDb, getFiOwner, getFiRunning, init_import_fund_import, setFiRunning };
