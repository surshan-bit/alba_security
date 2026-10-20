// Steps 2 and 3 of Refresh all stocks (v1.208): the new weekly and monthly bars, then the technical scores, are saved in records of 50 stocks instead of
// two or three saves per stock. The database takes only a few saves a second, so about 90 saves replace about 6,000.
//   barsRecent/<c001...>  the newest bars of every stock (see prices/recent.js)
//   techBlocks/<c001...>  { v: 1, asof, at, rows: [ { k, t } ] }: each stock's completed-weeks technical block (laid on the stock by overlays/updates.js)
import { stocks } from '../core/stocks.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { priceApply, pcTickerKey, priceHistoryByTicker, priceSymbolByTicker } from '../prices/store.js';
import { noteRecentSaved, recentRow } from '../prices/recent.js';
import { computeTechnical } from '../engine/technical.js';

const CHUNK = 50;          // stocks per record
const WORKERS = 6;         // records saved at the same time
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Compares two saved values by content, whatever order their keys are in.
function stable(x){ return x && typeof x === 'object' ? (Array.isArray(x) ? x.map(stable) : Object.keys(x).sort().reduce((o, k) => { o[k] = stable(x[k]); return o; }, {})) : x; }
const sameValue = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

async function readChunks(db, collection){
  const out = new Map();
  try { const snap = await db.collection(collection).get(); snap.docs.forEach(d => { if(d.exists) out.set(d.id, d.data()); }); }
  catch(e){ console.error('Could not read ' + collection, e); }
  return out;
}
async function saveDoc(db, path, doc){
  for(let attempt = 0; attempt < 2; attempt++){
    try { await db.doc(path).set(doc); return true; } catch(e){ if(attempt === 0) await sleep(1500); else console.error('Could not save ' + path, e); }
  }
  return false;
}
// Runs `task(i)` for i < n, `WORKERS` at a time; progress(done, n) after each.
async function runChunks(n, progress, task){
  let next = 0, done = 0;
  const worker = async () => { while(next < n){ const i = next++; await task(i); done++; progress(done, n); } };
  await Promise.all(Array.from({ length: Math.min(WORKERS, n) }, worker));
}
const idOf = i => 'c' + String(i + 1).padStart(3, '0');

// Step 2. `ready` = [{ s, W, M }]: stocks whose bars were brought up to date in memory. Writes the recent bars of EVERY stock that has bars (so each record is complete),
// and once a record is saved the stocks in it are updated on the page. Returns { saved: Set of ticker keys, failed: Set, records, chunksWritten }.
async function saveRecentBars(db, ready, progress){
  const readyBy = new Map(ready.map(r => [pcTickerKey(r.s), r]));
  const rows = new Map();
  for(const s of stocks){
    const key = pcTickerKey(s), r = readyBy.get(key), h = priceHistoryByTicker[key];
    const W = r ? r.W : h && h['1W'], M = r ? r.M : h && h['1M'];
    if(W && W.length && M && M.length) rows.set(key, recentRow(key, priceSymbolByTicker[key], W, M));
  }
  const keys = [...rows.keys()].sort();
  const n = Math.ceil(keys.length / CHUNK);
  const old = await readChunks(db, 'barsRecent');
  const out = { saved: new Set(), failed: new Set(), records: n, chunksWritten: 0 };
  await runChunks(n, progress, async i => {
    const part = keys.slice(i * CHUNK, (i + 1) * CHUNK), recs = part.map(k => rows.get(k));
    const o = old.get(idOf(i));
    const at = new Date();
    let ok = true;
    if(!(o && sameValue(o.rows, recs))){ ok = await saveDoc(db, 'barsRecent/' + idOf(i), { v: 1, at: at.toISOString(), rows: recs }); if(ok) out.chunksWritten++; }
    for(const k of part){
      const r = readyBy.get(k); if(!r) continue;
      if(!ok){ out.failed.add(k); continue; }
      out.saved.add(k);
      priceApply(k, { '1W': r.W, '1M': r.M }, priceSymbolByTicker[k], at.toISOString());
      noteRecentSaved(k, at.getTime(), r.W, r.M);
    }
  });
  return out;
}

// Step 3. Calculates the completed-weeks technical block of each stock in `done` ([{ s, W, M }]) from its bars and saves the blocks, 50 stocks to a record, next to
// the blocks of the other stocks (read from the records already saved). Returns { computed, records, chunksWritten, failed }.
async function saveTechBlocks(db, done, today, progress){
  const old = await readChunks(db, 'techBlocks');
  const rows = new Map();
  old.forEach(c => { if(c && Array.isArray(c.rows)) c.rows.forEach(r => { if(r && typeof r.k === 'string' && r.t) rows.set(r.k, r.t); }); });
  let computed = 0;
  for(const { s, W, M } of done){
    const pv = s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
    if(pv == null) continue;
    let t = null;
    try { t = computeTechnical(W, M, pv, today); } catch(e){ console.error('Technical score failed for ' + tickerSymbol(s), e); }
    if(t){ rows.set(sanitizeDocId(tickerSymbol(s)), t); computed++; }
  }
  const keys = [...rows.keys()].sort();
  const n = Math.ceil(keys.length / CHUNK);
  const out = { computed, records: n, chunksWritten: 0, failed: 0 };
  await runChunks(n, progress, async i => {
    const recs = keys.slice(i * CHUNK, (i + 1) * CHUNK).map(k => ({ k, t: rows.get(k) }));
    const o = old.get(idOf(i));
    if(o && sameValue(o.rows, recs)) return;
    if(await saveDoc(db, 'techBlocks/' + idOf(i), { v: 1, asof: today, at: new Date().toISOString(), rows: recs })) out.chunksWritten++; else out.failed++;
  });
  return out;
}

export { saveRecentBars, saveTechBlocks, sameValue };
