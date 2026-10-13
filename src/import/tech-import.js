// Technical Score import: apply and run.
import { getDb, technicalCsvUploadLog } from '../core/store.js';
import { formatBytes, formatUploadTimestamp } from '../core/util.js';
import { pruneLogCollection } from '../joblogs/panels.js';
import { recordAttempt, renderLastFile } from './last-file.js';
import { ALBA_FI, ALBA_FI_PUBLISHED, albaFiCheck, albaFiDay, albaFiLoadRaw, albaFiMakeBackup, albaFiPersist, albaFiPrevInfo, albaFiRenderBackups, albaFiRetry, albaFiSleep, albaFiSym, getFiAssets, getFiDb, getFiOwner, getFiRunning, setFiRunning, fiSetButtons } from './fund-import.js';
import { fiAsk, setFiPfx, fiReset, fiSet, fiShowResult, getFiState } from './panel.js';
import { AlbaTechEngine } from './tech-engine.js';
import { albaWlResolveBse } from './wlsync.js';

const ALBA_TI_COMP = { 'monthly MACD': 'monthMacd', 'weekly MACD': 'weekMacd', 'monthly RSI': 'monthRsi', 'weekly RSI': 'weekRsi' };
// Scores every stock found in the Growth List (never adds stocks) and refreshes price / margin of safety.
// Mutates `stocks` in place. A stock whose CSV row lacks a component that its stored technical block still
// has (the hand-curated / BSE-derived blocks) keeps that block: the weekly CSV must not wipe curated data.
function albaApplyTechnical(csvText, stocks, bseMap, asof){
  const res = AlbaTechEngine.matchAndScore(csvText, stocks, bseMap || {});
  const valLabel = v => v >= 8 ? 'attractively valued' : v >= 6 ? 'reasonably valued' : v >= 5 ? 'fully valued' : 'expensive / stretched valuation';
  const MACD = { bull_above: 'bullish, above zero', bear_above: 'bearish, above zero', bull_below: 'bullish, below zero', bear_below: 'bearish, below zero' };
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const kept = [], rescored = [];
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
    parts.push('Valuation pillar reading of ' + f1(v) + '/10 (' + valLabel(v) + ').');
    if(m.missing.length) parts.push('(' + m.missing.join(', ') + ' not available in this export — composite computed from available components only, rescaled to a 0–10 scale.)');
    s.technical = { asof, score: m.score, states: Object.assign({}, st, { valuation: valLabel(v) }), raw: Object.assign({}, r, { valuationScore: v }), reason: parts.join(' ') };
    rescored.push(albaFiSym(s));
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
  if(priceCol >= 0) for(const m of res.matched.concat(res.frozen)){
    const s = m.stock;
    const price = [m.matchedSymbol].concat(symsOf(s)).filter(Boolean).map(x => priceBySym.get(String(x).toUpperCase())).find(x => x != null);
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
    priced++;
  }
  return { matched: res.matched.length, rescored: rescored.length, kept, frozen: res.frozen.length,
           unmatchedCsv: res.unmatchedCsvSymbols.length, missingColumns: res.missingColumns, hasPrice: priceCol >= 0, priced, noValuation, pricesInCsv: priceBySym.size };
}

async function albaTiRunImport(){
  if(getFiRunning() || !getFiOwner()) return;
  const db = getFiDb(), assets = getFiAssets();
  setFiPfx('ti_');
  if(!db || !assets){ fiReset('Import data'); fiShowResult('err', [{ text: 'File storage or the database is not available in this view, so the import cannot run here.' }]); return; }
  setFiRunning(true); fiSetButtons(); fiReset('Importing technical data');
  const job = db.doc('importJobs/fundamental'); let locked = false, current = 'read';
  let rec = null, recId = null;
  try {
    const lk = await albaFiRetry(() => job.get()); const ld = lk && lk.exists ? lk.data() : null;
    if(ld && ld.status === 'running' && Date.now() - (Date.parse(ld.startedAt) || 0) < ALBA_FI.STALE_MS) throw new Error('another import is already running (started ' + formatUploadTimestamp(ld.startedAt) + '). Try again in a few minutes.');
    await albaFiRetry(() => job.set({ status: 'running', startedAt: new Date().toISOString(), kind: 'technical' })); locked = true;

    // 1. the uploaded file (always the one recorded in the upload log, never a cached copy)
    current = 'read'; fiSet('read', 'running', '', 0.3);
    for(const [id, r] of technicalCsvUploadLog.entries()){ if(r.status === 'uploaded' && (!rec || String(r.uploadedAt) > String(rec.uploadedAt))){ rec = r; recId = id; } }
    if(!rec) throw new Error('there is no uploaded file waiting. Use "Browse CSV…" to upload the TradingView Growth List export first.');
    const resp = await fetch('/_blob/' + rec.assetId);
    if(!resp.ok) throw new Error('could not read the stored file "' + rec.filename + '" (' + resp.status + ')');
    const csvText = await resp.text();
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
        let tried = {}; try { const td = await albaFiRetry(() => db.doc('stockMeta/bseLookupTried').get()); if(td && td.exists) tried = td.data() || {}; } catch(e){}
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

    // 3. backup
    current = 'backup'; fiSet('backup', 'running', 'Saving a copy…', 0.4);
    const bk = await albaFiMakeBackup(db, assets, JSON.stringify(raw.stocks), raw.stocks.length, raw.meta.version, 'Before importing ' + rec.filename + ' (data v' + raw.meta.version + ')');
    fiSet('backup', 'done', formatBytes(bk.bytes));

    // 4. score
    current = 'score'; fiSet('score', 'running', '', 0.3); await albaFiSleep(30);
    const prev = albaFiPrevInfo(raw.stocks);
    const avg = () => { let n = 0, t = 0; for(const s of raw.stocks) if(s.technical && typeof s.technical.score === 'number'){ n++; t += s.technical.score; } return n ? t / n : 0; };
    const avgBefore = avg();
    const res = albaApplyTechnical(csvText, raw.stocks, bse, albaFiDay(rec.uploadedAt));
    const avgAfter = avg();
    fiSet('score', 'done', res.rescored.toLocaleString('en-IN') + ' rescored' + (res.kept.length ? ', ' + res.kept.length + ' kept' : ''));

    // 5. checks
    current = 'check'; fiSet('check', 'running', '', 0.5); await albaFiSleep(30);
    const chk = albaFiCheck(raw.stocks, prev);
    if(res.matched === 0) chk.hard.push('no stock in the file matched a stock on the dashboard');
    const soft = [];
    if(res.matched > 0 && res.matched < 1500) soft.push('Only ' + res.matched + ' dashboard stocks matched a row in the file (normally about 2,100). That can mean a partial export or the wrong file.');
    if(res.kept.length > 25) soft.push(res.kept.length + ' stocks have a component missing from this file that they had before, so their previous reading was kept.');
    if(chk.hard.length) throw new Error('integrity check failed, nothing was written:\n• ' + chk.hard.slice(0, 6).join('\n• '));
    fiSet('check', 'done', 'passed');
    if(soft.length){
      const go = await fiAsk(soft.join(' ') + ' Nothing has been written yet.', 'Import anyway');
      if(!go) throw Object.assign(new Error('cancelled before anything was written.'), { cancelled: true });
    }

    // 6 + 7. write and verify
    current = 'write';
    const out = await albaFiPersist(db, raw, raw.stocks, 'import');
    current = 'verify';
    const dataVer = out.nothing ? raw.meta.version : out.plan.newMeta.version;
    if(out.nothing) fiSet('write', 'done', 'nothing changed');
    const note = 'Imported in the page: ' + res.rescored + ' rescored, ' + res.kept.length + ' kept (curated), ' + res.priced + ' prices refreshed, ' + res.frozen + ' without a valuation anchor. Average technical score ' + avgBefore.toFixed(2) + '→' + avgAfter.toFixed(2) + '.';
    fiSet('verify', 'running', 'Updating the upload history…', 0.7);
    try {
      const upd = { status: 'processed', processedAt: new Date().toISOString(), processedNote: note };
      Object.assign(rec, upd); technicalCsvUploadLog.put(recId, rec);
      const logDb = getDb();
      if(logDb){
        await logDb.collection('technicalCsvUploadLog').doc(recId).update(upd);
        await pruneLogCollection(logDb, 'technicalCsvUploadLog', technicalCsvUploadLog, 'uploadedAt');
      }
    } catch(e){ console.error('Could not update the upload log', e); }
    renderLastFile('tech');
    await albaFiRetry(() => job.set({ status: 'done', finishedAt: new Date().toISOString(), note, kind: 'technical' })); locked = false;
    fiSet('verify', 'done', 'data v' + dataVer);
    const lines = [
      { text: out.nothing ? 'Import complete: the file produced no changes to the stored data.' : 'Import complete.', cls: 'fi-line fi-line-strong' },
      { text: res.rescored.toLocaleString('en-IN') + ' stocks rescored · ' + res.kept.length + ' kept as they were (curated) · ' + res.frozen + ' without a valuation anchor · ' + res.unmatchedCsv.toLocaleString('en-IN') + ' file rows not on the dashboard (ignored).' },
      { text: 'Average technical score ' + avgBefore.toFixed(2) + ' → ' + avgAfter.toFixed(2) + '.' },
      { text: bseFound ? bseFound + ' new BSE symbol(s) found and saved.' : 'No new BSE symbols needed.', cls: 'fi-line fi-line-muted' },
      { text: res.hasPrice ? res.priced.toLocaleString('en-IN') + ' current prices and margins of safety refreshed.' : 'The file has no Price column, so current prices were NOT updated.' }
    ];
    if(res.kept.length) lines.push({ text: 'Kept (a component is missing from the file but was present before): ' + res.kept.slice(0, 12).join(', ') + (res.kept.length > 12 ? ' … +' + (res.kept.length - 12) : '') + '.', cls: 'fi-line fi-line-muted' });
    if(res.missingColumns.length) lines.push({ text: 'Columns not found in this export: ' + res.missingColumns.join(', ') + '.', cls: 'fi-line fi-line-muted' });
    fiShowResult('ok', lines);
  } catch(e){
    console.error('Technical import failed', e);
    recordAttempt('tech', rec, recId, e);
    if(getFiState()){ getFiState().error = e; if(current && getFiState().status[current] !== 'done') fiSet(current, 'error', ''); }
    const msg = (e && e.message) ? e.message : String(e);
    fiShowResult(e && e.cancelled ? 'warn' : 'err', [{ text: e && e.cancelled ? 'Import ' + msg : 'Import stopped: ' + msg, cls: 'fi-line fi-line-strong' }, { text: e && e.rolledBack ? 'The previous data is back in place.' : e && e.published ? ALBA_FI_PUBLISHED : 'No changes were published.', cls: 'fi-line fi-line-muted' }]);
    if(locked){ try { await job.set({ status: 'failed', finishedAt: new Date().toISOString(), error: msg.slice(0, 500), kind: 'technical' }); } catch(x){} }
  } finally {
    setFiRunning(false); fiSetButtons(); albaFiRenderBackups();
  }
}

export { albaTiRunImport };
