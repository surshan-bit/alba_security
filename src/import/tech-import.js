// Technical Score import: apply and run.
import { technicalCsvUploadLog } from '../core/store.js';
import { uploadsSettled } from './upload-history.js';
import { sanitizeDocId, sleep, tickerSymbol } from '../core/util.js';
import { recordAttempt, saveRecord } from './last-file.js';
import { albaFiConfirmSoft, albaFiDay, albaFiLoadRaw, albaFiMarkFailed, albaFiNewestUpload, albaFiPersist, albaFiReadUpload, albaFiRetry, albaFiShowFailure, albaFiTakeLock, albaFiThrowHard, getFiAssets, getFiDb, getFiOwner, getFiRunning, setFiRunning, fiSetButtons } from './fund-import.js';
import { albaFiCheck, albaFiPrevInfo, albaFiSym } from './fund-check.js';
import { setFiPfx, fiReset, fiSet, fiShowResult } from './panel.js';
import { AlbaTechEngine } from './tech-engine.js';
import { techValLabel } from '../engine/technical.js';
import { albaWlResolveBse } from './wlsync.js';
import { recordScoreHistory } from '../history/scorehistory.js';
import { paintLastRuns, saveRunLog } from '../refresh/runlog.js';

// The Technical CSV import is hidden for now (v1.199): the TradingView refresh is the only route. Set to true to show it again.
const SHOW_TECH_CSV = false;
const ALBA_TI_COMP = { 'monthly MACD': 'monthMacd', 'weekly MACD': 'weekMacd', 'monthly RSI': 'monthRsi', 'weekly RSI': 'weekRsi' };
// Scores every stock found in the Growth List (never adds stocks) and refreshes price / margin of safety.
// Mutates `stocks` in place. A stock whose CSV row lacks a component that its stored technical block still
// has (the hand-curated / BSE-derived blocks) keeps that block: the weekly CSV must not wipe curated data.
function albaApplyTechnical(csvText, stocks, bseMap, asof){
  const res = AlbaTechEngine.matchAndScore(csvText, stocks, bseMap || {});
  const MACD = { bull_above: 'bullish, above zero', bear_above: 'bearish, above zero', bull_below: 'bullish, below zero', bear_below: 'bearish, below zero' };
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const kept = [], rescored = [], techDocs = new Set(), priceDocs = new Set();
  for(const m of res.matched){
    const s = m.stock, st = m.states, r = m.raw, v = s.pillars.val, old = s.technical;
    if(m.missing.length && old && old.states && m.missing.some(c => old.states[ALBA_TI_COMP[c]] != null)){ kept.push(albaFiSym(s)); continue; }
    const parts = [];
    if(st.monthMacd && st.weekMacd) parts.push('monthly MACD ' + MACD[st.monthMacd] + ', weekly MACD ' + MACD[st.weekMacd] + '.');
    else {
      if(st.monthMacd) parts.push('monthly MACD ' + MACD[st.monthMacd] + '.');
      if(st.weekMacd) parts.push('weekly MACD ' + MACD[st.weekMacd] + '.');
    }
    const rs = [];
    if(st.monthRsi) rs.push('monthly RSI ' + f1(r.monthRsi) + ' (' + st.monthRsi + ')');
    if(st.weekRsi) rs.push('weekly RSI ' + f1(r.weekRsi) + ' (' + st.weekRsi + ')');
    if(rs.length) parts.push(rs.join(', ') + '.');
    parts.push('Valuation pillar reading of ' + f1(v) + '/10 (' + techValLabel(v) + ').');
    if(m.missing.length) parts.push('(' + m.missing.join(', ') + ' not available in this export — composite computed from available components only, rescaled to a 0–10 scale.)');
    s.technical = { asof, score: m.score, states: Object.assign({}, st, { valuation: techValLabel(v) }), raw: Object.assign({}, r, { valuationScore: v }), reason: parts.join(' ') };
    rescored.push(albaFiSym(s)); techDocs.add(sanitizeDocId(tickerSymbol(s)));
  }
  // ---- Price & MoS refresh: the Price column (INR rows only) is the CURRENT PRICE of every matched stock that has
  // valuation.intrinsicValue. Only the price, asof and its display text change, never intrinsicValue / Graham / NCAVPS / factor scores.
  const rows = AlbaTechEngine.parseCSV(csvText);
  const hdr = rows[0].map(h => h.trim().toLowerCase());
  const symCol = hdr.findIndex(h => h === 'symbol') >= 0 ? hdr.findIndex(h => h === 'symbol') : hdr.findIndex(h => h.includes('symbol'));
  let priceCol = hdr.findIndex(h => h === 'price');
  if(priceCol < 0) priceCol = hdr.findIndex(h => /^price\b/.test(h) && !/change|currency|to |earn|book|sales|target/.test(h));
  const curCol = hdr.findIndex(h => h.includes('currency') && h.startsWith('price'));
  const priceBySym = new Map();
  if(priceCol >= 0) for(let i = 1; i < rows.length; i++){
    const r = rows[i], sym = String(r[symCol] || '').trim().toUpperCase(); if(!sym) continue;
    if(curCol >= 0 && String(r[curCol] || '').trim().toUpperCase() !== 'INR') continue;
    const p = parseFloat(String(r[priceCol] || '').replace(/,/g, '')); if(Number.isFinite(p) && p > 0) priceBySym.set(sym, Math.round(p * 100) / 100);
  }
  const symsOf = s => { const a = String(s.ticker).split('·')[0].trim().toUpperCase(); const l = [a]; if(a.includes('-')) l.push(a.replace(/-/g, '_')); if(a.includes('_')) l.push(a.replace(/_/g, '-')); return l; };
  let priced = 0, noValuation = 0;
  if(priceCol >= 0) for(const m of [...res.matched, ...res.frozen]){
    const s = m.stock;
    const price = [/** @type {any} */ (m).matchedSymbol].concat(symsOf(s)).filter(Boolean).map(x => priceBySym.get(String(x).toUpperCase())).find(x => x != null);
    if(price == null) continue;
    const v = s.valuation;
    if(!v || !(v.intrinsicValue > 0)){ noValuation++; continue; }
    v.currentPrice = price; v.asof = asof;
    const mos = (v.intrinsicValue - price) / v.intrinsicValue * 100, mosTxt = f1(mos) + '%';
    const dcf = ((s.fundamentals && s.fundamentals.factors) || []).find(f => f.key === 'dcf');
    if(dcf){
      for(const mt of dcf.metrics || []){ if(mt[0] === 'Current price') mt[1] = String(price); else if(mt[0] === 'Margin of safety') mt[1] = mosTxt; }
      if(typeof dcf.note === 'string') dcf.note = dcf.note.replace(/current price ₹[\d.,]+ \(-?[\d.]+% margin of safety/, 'current price ₹' + price + ' (' + mosTxt + ' margin of safety');
    }
    priced++; priceDocs.add(sanitizeDocId(tickerSymbol(s)));
  }
  return { techDocs, priceDocs, matched: res.matched.length, rescored: rescored.length, kept, frozen: res.frozen.length,
           unmatchedCsv: res.unmatchedCsvSymbols.length, missingColumns: res.missingColumns, hasPrice: priceCol >= 0, priced, noValuation, pricesInCsv: priceBySym.size };
}

// A saved update (a Live Data refresh or a research run) is shown on top of the stock data when its date is the same as or newer than
// the stock data's. So after this import, an update written EARLIER the same day would still hide the file's newer price and
// readings. The file just imported is the latest word for the stocks it priced or scored: for those, an update dated on or before the
// file's day loses its price and / or technical block (Global factors stay). Updates dated after the file's day are left alone.
async function albaTiClearOlderUpdates(db, res, asof){
  let cleared = 0;
  try {
    const snap = await albaFiRetry(() => db.collection('stockUpdates').get());
    const todo = [];
    for(const d of snap.docs){
      const data = d.data(), id = d.id;
      const dropPrice = res.priceDocs.has(id) && data && data.valuation && typeof data.valuation.asof === 'string' && data.valuation.asof <= asof;
      const dropTech = res.techDocs.has(id) && data && data.technical && typeof data.technical.asof === 'string' && data.technical.asof <= asof;
      if(!dropPrice && !dropTech) continue;
      const next = Object.assign({}, data);
      if(dropPrice) delete next.valuation;
      if(dropTech) delete next.technical;
      todo.push({ id, next });
    }
    let i = 0;
    const worker = async () => {
      while(i < todo.length){
        const { id, next } = todo[i++];
        await albaFiRetry(() => db.doc('stockUpdates/' + id).set(next));
        cleared++;
        if(cleared % 10 === 0 || cleared === todo.length) fiSet('verify', 'running', 'Replacing older saved updates ' + cleared + ' / ' + todo.length + '…', 0.3 + 0.4 * cleared / todo.length);
      }
    };
    if(todo.length) fiSet('verify', 'running', 'Replacing older saved updates 0 / ' + todo.length + '…', 0.3);
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  } catch(e){ console.error('Could not clear older saved updates', e); }
  return cleared;
}

async function albaTiRunImport(){
  if(getFiRunning() || !getFiOwner()) return;
  const db = getFiDb(), assets = getFiAssets();
  setFiPfx('ti_');
  if(!db || !assets){ fiReset('Import data'); fiShowResult('err', [{ text: 'File storage or the database is not available in this view, so the import cannot run here.' }]); return; }
  setFiRunning(true); fiSetButtons(); fiReset('Importing technical data');
  const job = db.doc('importJobs/fundamental'); let locked = false, current = 'read', stopBeat = () => {};
  let rec = null, recId = null, tiRes = null, runError = '';
  const t0 = Date.now(), startedAt = new Date().toISOString();
  try {
    stopBeat = await albaFiTakeLock(job, when => 'another import is already running (' + when + '). It was started from another tab or device. If that one was closed, it counts as interrupted after 3 minutes without activity; then try again.', { kind: 'technical' }); locked = true;

    // 1. the uploaded file (always the one recorded in the upload log, never a cached copy)
    current = 'read'; fiSet('read', 'running', 'Waiting for the file to finish saving…', 0.3);
    await uploadsSettled();
    [rec, recId] = albaFiNewestUpload(technicalCsvUploadLog);
    if(!rec) throw new Error('there is no uploaded file waiting. Use "Browse CSV…" to upload the TradingView Growth List export first.');
    const csvText = await albaFiReadUpload(assets, rec);
    const rows0 = AlbaTechEngine.parseCSV(csvText);
    if(rows0.length < 2) throw new Error('the file has no data rows.');
    const cm = AlbaTechEngine.buildColumnMap(rows0[0]);
    if(cm.symbol === -1) throw new Error('the file has no "Symbol" column, so it does not look like a TradingView export.');
    const missCols = ['monthMacdSignal', 'monthMacdLevel', 'weekMacdSignal', 'weekMacdLevel', 'monthRsi', 'weekRsi'].filter(k => cm[k] === -1);
    if(missCols.length >= 4) throw new Error('the file is missing most of the MACD / RSI columns (' + missCols.join(', ') + '). Re-export the Growth List with the technical columns shown.');
    fiSet('read', 'done', rec.filename);

    // 2. current data + the BSE-code → TradingView symbol map
    current = 'load'; fiSet('load', 'running', '', 0);
    const raw = await albaFiLoadRaw(db, (d, n) => fiSet('load', 'running', d + ' / ' + n + ' parts', d / n));
    let bse = {};
    try { const bs = await albaFiRetry(() => db.doc('stockMeta/bseAlpha').get()); if(bs && bs.exists) bse = bs.data() || {}; } catch(e){ console.error('Could not read the BSE symbol map', e); }
    // BSE-only stocks with no saved TradingView symbol: look them up by company name (exact name match only), save them for next time.
    let bseFound = 0;
    try {
      if(typeof albaWlResolveBse === 'function'){
        let tried = {}; try { const td = await albaFiRetry(() => db.doc('stockMeta/bseLookupTried').get()); if(td && td.exists) tried = td.data() || {}; } catch(e){ /* no lookup record yet: search again */ }
        const todo = raw.stocks.map(s => ({ code: albaFiSym(s), name: s.name })).filter(x => /^\d+$/.test(x.code) && !bse[x.code] && !(tried[x.code] && Date.now() - (Date.parse(tried[x.code]) || 0) < 30 * 86400000)).slice(0, 12);
        if(todo.length){
          fiSet('load', 'running', 'Looking up ' + todo.length + ' BSE symbol(s)…', 1);
          const found = await albaWlResolveBse(todo);
          bseFound = Object.keys(found).length;
          if(bseFound){ await albaFiRetry(() => db.doc('stockMeta/bseAlpha').update(found)); Object.assign(bse, found); }
          const now = new Date().toISOString(); const nt = Object.assign({}, tried);
          for(const x of todo) if(!found[x.code]) nt[x.code] = now;      // do not search for the same misses on every import
          await albaFiRetry(() => db.doc('stockMeta/bseLookupTried').set(nt));
        }
      }
    } catch(e){ console.error('BSE symbol lookup failed', e); }
    fiSet('load', 'done', raw.stocks.length.toLocaleString('en-IN') + ' stocks (data v' + raw.meta.version + ')');

    // 3. score
    current = 'score'; fiSet('score', 'running', '', 0.3); await sleep(30);
    const prev = albaFiPrevInfo(raw.stocks);
    const avg = () => { let n = 0, t = 0; for(const s of raw.stocks) if(s.technical && typeof s.technical.score === 'number'){ n++; t += s.technical.score; } return n ? t / n : 0; };
    const avgBefore = avg();
    const res = albaApplyTechnical(csvText, raw.stocks, bse, albaFiDay(rec.uploadedAt));
    tiRes = res;
    const avgAfter = avg();
    fiSet('score', 'done', res.rescored.toLocaleString('en-IN') + ' rescored' + (res.kept.length ? ', ' + res.kept.length + ' kept' : ''));

    // 5. checks
    current = 'check'; fiSet('check', 'running', '', 0.5); await sleep(30);
    const chk = albaFiCheck(raw.stocks, prev);
    if(res.matched === 0) chk.hard.push('no stock in the file matched a stock on the dashboard');
    const soft = [];
    if(res.matched > 0 && res.matched < 1500) soft.push('Only ' + res.matched + ' dashboard stocks matched a row in the file (normally about 2,100). That can mean a partial export or the wrong file.');
    if(res.kept.length > 25) soft.push(res.kept.length + ' stocks have a component missing from this file that they had before, so their previous reading was kept.');
    albaFiThrowHard(chk);
    fiSet('check', 'done', 'passed');
    await albaFiConfirmSoft(soft);

    // 6 + 7. write and verify
    current = 'write';
    const out = await albaFiPersist(db, raw, raw.stocks, 'import');
    current = 'verify';
    await recordScoreHistory(db, raw.stocks);   // the trend on the stock page; never fails the import
    const clearedUpdates = await albaTiClearOlderUpdates(db, res, albaFiDay(rec.uploadedAt));
    const dataVer = out.nothing ? raw.meta.version : out.plan.newMeta.version;
    if(out.nothing) fiSet('write', 'done', 'nothing changed');
    const note = 'Imported in the page: ' + res.rescored + ' rescored, ' + res.kept.length + ' kept (curated), ' + res.priced + ' prices refreshed, ' + res.frozen + ' not scored. Average technical score ' + avgBefore.toFixed(2) + '→' + avgAfter.toFixed(2) + '.';
    fiSet('verify', 'running', 'Updating the upload history…', 0.7);
    const upd = { status: 'processed', processedAt: new Date().toISOString(), processedNote: note };
    const logErr = await saveRecord('tech', recId, Object.assign({}, rec, upd), db);
    await albaFiRetry(() => job.set({ status: 'done', finishedAt: new Date().toISOString(), note, kind: 'technical' })); locked = false;
    fiSet('verify', 'done', 'data v' + dataVer);
    const lines = [
      { text: out.nothing ? 'Import complete: the file produced no changes to the stored data.' : 'Import complete.', cls: 'fi-line fi-line-strong' },
      { text: res.rescored.toLocaleString('en-IN') + ' stocks rescored · ' + res.kept.length + ' kept as they were (curated) · ' + res.frozen + ' not scored · ' + res.unmatchedCsv.toLocaleString('en-IN') + ' file rows not on the dashboard (ignored).' },
      { text: 'Average technical score ' + avgBefore.toFixed(2) + ' → ' + avgAfter.toFixed(2) + '.' },
      { text: bseFound ? bseFound + ' new BSE symbol(s) found and saved.' : 'No new BSE symbols needed.', cls: 'fi-line fi-line-muted' },
      { text: res.hasPrice ? res.priced.toLocaleString('en-IN') + ' current prices and margins of safety refreshed.' : 'The file has no Price column, so current prices were NOT updated.' }
    ];
    if(clearedUpdates) lines.push({ text: clearedUpdates + ' earlier saved price / chart update(s) for these stocks were replaced by this file (they were older than it).', cls: 'fi-line fi-line-muted' });
    if(res.kept.length) lines.push({ text: 'Kept (a component is missing from the file but was present before): ' + res.kept.slice(0, 12).join(', ') + (res.kept.length > 12 ? ' … +' + (res.kept.length - 12) : '') + '.', cls: 'fi-line fi-line-muted' });
    if(res.missingColumns.length) lines.push({ text: 'Columns not found in this export: ' + res.missingColumns.join(', ') + '.', cls: 'fi-line fi-line-muted' });
    if(logErr) lines.push({ text: 'The data is saved, but the upload record could not be marked as imported (' + logErr + '), so the Last file loaded card may still say "not imported".' });
    fiShowResult('ok', lines);
  } catch(e){
    console.error('Technical import failed', e);
    recordAttempt('tech', rec, recId, e, db);
    const msg = (e && e.message) ? e.message : String(e);
    runError = (e && e.cancelled ? 'cancelled: ' : '') + msg.slice(0, 200);
    albaFiShowFailure(e, current, msg);
    if(locked) await albaFiMarkFailed(job, msg, { kind: 'technical' });
  } finally {
    stopBeat();
    if(rec && getFiDb()) await saveRunLog(getFiDb(), 'csv', startedAt, t0, { planned: tiRes ? tiRes.matched : 0, saved: tiRes && !runError ? tiRes.rescored : 0, unchanged: 0, scored: tiRes && !runError ? tiRes.rescored : 0, kept: tiRes ? tiRes.kept.length : 0, skipped: tiRes ? tiRes.frozen : 0, stopped: !!runError, error: runError || null, file: rec.filename });
    setFiRunning(false); fiSetButtons(); paintLastRuns(getFiDb());
  }
}

export { SHOW_TECH_CSV, albaTiRunImport };
