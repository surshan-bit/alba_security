// TradingView watchlist sync.
import { getDb, watchlistSyncLog } from '../core/store.js';
import { stocks } from '../core/stocks.js';
import { sanitizeDocId } from '../core/util.js';
import { renderWatchlistSyncLogPanel } from '../joblogs/panels.js';
import { TV_SERVER, tvCall, tvErrorText, tvMcp } from '../tv/connector.js';
import { strategies } from '../strategies/state.js';
import { ruleReady } from '../strategies/rules.js';
import { fiErr, fiMarkFailed, fiRetry, fiTakeLock, getFiDb, getFiOwner, getFiRunning, setFiRunning, fiSetButtons } from './fund-import.js';
import { setFiPfx, fiReset, fiSet, fiShowResult, getFiState } from './panel.js';
import { wlBuild, wlDiff, wlDropLimit, wlMissing, wlNorm, wlPicksProblem, wlSame, wlSteps, wlStillDropped } from './wlplan.js';
import { wlDoneLine, wlNote, wlResultLines, wlStepDetail, wlStoppedLines } from './wlreport.js';

// ====================================================================================================
// TRADINGVIEW WATCHLIST SYNC, IN THE PAGE. The owner ticks the strategies to sync and presses "Sync selected": each
// ticked strategy is run over the active stocks (the same rules as the Strategies screen) and its matches are written
// to a TradingView watchlist named exactly like the strategy, through the viewer's own TradingView connector (the
// page's `mcp` capability). The four fixed lists of the earlier version (WL_OLD) are deleted once, after the new
// lists are in place.
// Safety (from the incidents in the tradingview-watchlist-symbol-mapping skill):
//   * the new list is created FIRST under a temporary name and checked; the old list is deleted only after the new
//     one holds (almost) every symbol, so a failed run never leaves a list empty;
//   * exactly one delete at a time, and after each delete the page re-reads all lists and stops if any other list
//     went missing;
//   * BSE-only stocks use the TradingView alpha symbol from stockMeta/bseAlpha, never BSE:<digits>.
// Owner only. Uses the shared progress panel (ids prefixed wl_) and its own lock document importJobs/watchlist.
// Which stocks go where is src/import/wlplan.js; the wording of the result is src/import/wlreport.js.
// ====================================================================================================
const WL_OLD = ['Alba Securities', 'Alba - Green', 'Alba - Orange', 'Alba - Red'];
const WL_CHUNK = 300;
const WL_LOOKUP_MAX = 40;    // BSE-only stocks searched by name in one run
const WL_RESOLVE_MAX = 30;   // dropped symbols looked up on the other exchange in one list
const picked = new Set();   // ids of the strategies ticked in the picker

// A BSE-only stock with no saved TradingView symbol: search by company name and accept ONLY a BSE stock whose
// description equals the company name (ignoring Ltd / Limited / punctuation). Near matches are left for a person.
async function wlResolveBse(items){
  const found = {};
  for(const it of items.slice(0, WL_LOOKUP_MAX)){
    try {
      const p = wlPayload(await tvCall('mcp-tv-search-symbols', { query: it.name, type_filter: 'stock' }));
      const hits = ((p && p.symbols) || []).filter(x => x && x.exchange === 'BSE' && x.type === 'stock' && wlNorm(x.description) === wlNorm(it.name));
      if(hits.length === 1) found[it.code] = String(hits[0].symbol).split(':')[1];
    } catch(e){ /* leave it unresolved */ }
  }
  return found;
}

// ---- Talking to TradingView ----
function wlPayload(p){
  if(typeof p === 'string'){ try { p = JSON.parse(p); } catch(e){ return p; } }
  if(p && p.data && typeof p.data === 'object' && !p.watchlists && !p.symbols) return p.data;
  return p;
}
async function wlRead(){
  const p = wlPayload(await tvCall('mcp-watchlist-list-watchlists', {}));
  if(!p || !Array.isArray(p.watchlists)) throw new Error('TradingView returned an unexpected reply when listing watchlists');
  return p.watchlists;
}
// Writes are tried once: a repeated create could make a duplicate. A failure that may or may not have gone through is
// marked `ambiguous`, and the caller re-reads the lists to find out what happened.
async function wlWrite(tool, input){
  const mcp = await tvMcp();
  if(!mcp) throw Object.assign(new Error('The TradingView connector is not available in this view.'), { code: 'no_mcp' });
  try { const r = await mcp.callTool(TV_SERVER, tool, input, { cache: false }); return wlPayload(r.payload); }
  catch(e){ if(e && (e.retryable || e.code === 'server_unavailable' || e.code === 'upstream_error' || e.code === 'tool_error')) e.ambiguous = true; throw e; }
}
// A write whose outcome the caller checks afterwards by reading the lists: an ambiguous failure is not an error here.
async function wlWriteChecked(tool, input){
  try { await wlWrite(tool, input); } catch(e){ if(!e.ambiguous) throw e; }
}
const wlCustom = a => a.filter(l => l && l.type === 'custom');

// A symbol TradingView dropped: look for the same ticker on the other Indian exchange (e.g. NSE:RESONANCE is really BSE:RESONANCE).
async function wlAlternative(sym){
  const tk = sym.split(':')[1] || sym;
  for(const q of tk.includes('_') ? [tk, tk.replace(/_/g, '&')] : [tk]){
    try {
      const p = wlPayload(await tvCall('mcp-tv-search-symbols', { query: q, type_filter: 'stock' }));
      const arr = (p && p.symbols) || [];
      const hit = arr.find(x => x && (x.exchange === 'NSE' || x.exchange === 'BSE') && x.type === 'stock' && String(x.symbol).split(':')[1] === q && x.symbol !== sym);
      if(hit) return hit.symbol;
    } catch(e){ /* try the next form */ }
  }
  return null;
}

// Delete ONE list, then re-read everything and make sure nothing else disappeared.
async function wlDeleteChecked(target, before){
  const keep = before.filter(l => String(l.id) !== String(target.id)).map(l => ({ id: String(l.id), name: l.name || '(' + (l.color || 'colored') + ')' }));
  let err = null;
  try { await wlWrite('mcp-watchlist-delete-watchlist', { watchlist_id: String(target.id) }); } catch(e){ err = e; }
  const after = await wlRead();
  const ids = new Set(after.map(l => String(l.id)));
  const lost = keep.filter(k => !ids.has(k.id));
  if(lost.length) throw Object.assign(new Error('Safety stop: after deleting "' + target.name + '" these lists are also gone: ' + lost.map(l => l.name).join(', ') + '. Nothing more was touched.'), { fatal: true });
  if(ids.has(String(target.id))) throw new Error('"' + target.name + '" could not be deleted' + (err ? ' (' + fiErr(err) + ')' : ''));
  return after;
}

// ---- Rebuilding one list ----
// Creates the temporary list (clearing a leftover of an earlier failed run) and sends the symbols in chunks. Returns its id.
async function wlMakeTemp(tmpName, symbols, lists, onDetail){
  let current = lists;
  for(const l of wlCustom(lists).filter(l => l.name === tmpName)) current = await wlDeleteChecked(l, current);
  onDetail('Creating the new list…');
  await wlWriteChecked('mcp-watchlist-create-watchlist', { name: tmpName, symbols: symbols.slice(0, WL_CHUNK) });
  const tmps = wlCustom(await wlRead()).filter(l => l.name === tmpName);
  if(tmps.length !== 1) throw new Error('could not create the temporary list in TradingView' );
  const tmpId = String(tmps[0].id);
  for(let i = WL_CHUNK; i < symbols.length; i += WL_CHUNK){
    onDetail('Adding symbols ' + Math.min(i + WL_CHUNK, symbols.length) + ' / ' + symbols.length + '…');
    await wlWriteChecked('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: symbols.slice(i, i + WL_CHUNK) });
  }
  return tmpId;
}

async function wlAddInChunks(tmpId, symbols){
  for(let i = 0; i < symbols.length; i += WL_CHUNK) await wlWriteChecked('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: symbols.slice(i, i + WL_CHUNK) });
}

async function wlHeld(tmpId){
  const l = (await wlRead()).find(x => String(x.id) === tmpId);
  if(!l) throw new Error('the temporary list disappeared');
  return l.symbols || [];
}

// Checks what the temporary list holds, retries what did not land once, then asks for the dropped symbols on the other exchange. Returns the symbols still missing.
async function wlSettle(tmpId, symbols, onDetail){
  onDetail('Checking it…');
  let missing = wlMissing(symbols, await wlHeld(tmpId));
  if(missing.length){            // one more try for what did not land
    await wlAddInChunks(tmpId, missing);
    missing = wlMissing(symbols, await wlHeld(tmpId));
  }
  if(!missing.length) return [];
  onDetail('Resolving ' + missing.length + ' symbols TradingView dropped…');
  for(const sym of missing.slice(0, WL_RESOLVE_MAX)){
    const alt = await wlAlternative(sym);
    if(alt) await wlWriteChecked('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: [alt] });
  }
  return wlStillDropped(missing, await wlHeld(tmpId));
}

// Gives the finished temporary list its real name. Returns the list as TradingView now holds it.
async function wlRename(tmpId, name, tmpName){
  await wlWriteChecked('mcp-watchlist-update-watchlist', { watchlist_id: tmpId, name });
  const fin = (await wlRead()).find(x => String(x.id) === tmpId);
  if(!fin || fin.name !== name) throw new Error('the new list is ready but could not be renamed; it is saved as "' + tmpName + '" in TradingView');
  return fin;
}

// Rebuild one list. Returns { action, count, added, removed, dropped[] }.
async function wlSyncOne(name, symbols, onDetail){
  const lists = await wlRead();
  const old = wlCustom(lists).filter(l => l.name === name);
  if(old.length > 1) throw new Error('there are ' + old.length + ' lists called "' + name + '" in TradingView; rename or delete the extras first');
  const oldSyms = old.length ? (old[0].symbols || []) : [];
  if(old.length && wlSame(oldSyms, symbols)) return { action: 'unchanged', count: symbols.length, added: 0, removed: 0, dropped: [] };
  const tmpName = name + ' (syncing)';
  const tmpId = await wlMakeTemp(tmpName, symbols, lists, onDetail);
  const dropped = await wlSettle(tmpId, symbols, onDetail);
  if(dropped.length > wlDropLimit(symbols.length)) throw new Error('TradingView did not accept ' + dropped.length + ' of ' + symbols.length + ' symbols, so the existing "' + name + '" list was left untouched (the new one is saved as "' + tmpName + '")');
  if(old.length){
    onDetail('Replacing the old list…');
    await wlDeleteChecked(old[0], await wlRead());
  }
  const fin = await wlRename(tmpId, name, tmpName);
  return Object.assign({ action: old.length ? 'replaced' : 'created', count: (fin.symbols || []).length, dropped }, wlDiff(oldSyms, symbols));
}

// ---- The strategy picker (checkboxes above the button) ----
function renderWlPicker(){
  const host = document.getElementById('wlStrategyPicker'); if(!host) return;
  host.textContent = '';
  for(const st of strategies){
    const ready = st.rules.some(ruleReady);
    if(!ready) picked.delete(st.id);
    const label = document.createElement('label'); label.className = 'wl-pick';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = picked.has(st.id); box.disabled = !ready;
    box.addEventListener('change', () => { if(box.checked) picked.add(st.id); else picked.delete(st.id); });
    const txt = document.createElement('span'); txt.className = 'wl-pick-text';
    const nm = document.createElement('span'); nm.className = 'wl-pick-name'; nm.textContent = st.name + (ready ? '' : ' (no rules yet)');
    txt.append(nm);
    label.append(box, txt); host.appendChild(label);
  }
  if(!strategies.length){ const p = document.createElement('p'); p.className = 'upload-hint'; p.textContent = 'No strategies yet. Create one in Strategies first.'; host.appendChild(p); }
}
window.addEventListener('alba-strategies-reloaded', renderWlPicker);

// ---- One run ----
// The state of one run, shared by its steps: the database and lock, what was ticked, the step on screen, what finished, and how to write the sync log.
function wlNewRun(db, picks){
  const startedAt = new Date().toISOString(), logId = sanitizeDocId(startedAt), logDb = getDb();
  const saveLog = async rec => {
    try { watchlistSyncLog.put(logId, rec); renderWatchlistSyncLogPanel(); if(logDb){ await logDb.collection('watchlistSyncLog').doc(logId).set(JSON.parse(JSON.stringify(rec))); } } catch(e){ console.error('Could not save the sync log', e); }
  };
  return { db, job: db.doc('importJobs/watchlist'), picks, names: picks.map(p => p.name), startedAt, current: 'build', locked: false, stopBeat: () => {}, done: [], saveLog };
}

// The saved BSE symbols as a plain copy. The database hands the record back locked, and new symbols are added to this map after a lookup.
function bseMapOf(snap){ return snap && snap.exists ? Object.assign({}, snap.data()) : {}; }
async function wlReadBse(db){
  try { return bseMapOf(await fiRetry(() => db.doc('stockMeta/bseAlpha').get())); }
  catch(e){ console.error('Could not read the BSE symbol map', e); return {}; }
}

async function wlSaveBse(db, found){
  try { await fiRetry(() => db.doc('stockMeta/bseAlpha').update(found)); } catch(e){ console.error('Could not save the new BSE symbols', e); }
}

// Step 1: match the stocks, looking up the TradingView symbol of BSE-only stocks that have none saved. Returns the plan.
async function wlPhaseBuild(run){
  const { db, picks, names } = run;
  run.current = 'build'; fiSet('build', 'running', '', 0.5);
  const bse = await wlReadBse(db);
  let plan = wlBuild(stocks, bse, picks);
  if(plan.needsLookup.length){
    fiSet('build', 'running', 'Looking up ' + plan.needsLookup.length + ' BSE symbol(s)…', 0.5);
    const found = await wlResolveBse(plan.needsLookup);
    if(Object.keys(found).length){
      await wlSaveBse(db, found);
      plan = wlBuild(stocks, Object.assign(bse, found), picks);
    }
  }
  fiSet('build', 'done', names.map(n => plan.lists[n].length).join(' / ') + ' symbols');
  return plan;
}

// Step 2, for one ticked strategy: rebuild its list and add the result to `totals`.
async function wlSyncPick(run, plan, i, totals){
  const name = run.names[i], key = 'l' + i, symbols = plan.lists[name];
  run.current = key;
  if(!symbols.length){ totals.empty.push(name); run.done.push(name + ': no stock matches, list left as it is'); fiSet(key, 'done', 'no match'); return; }
  fiSet(key, 'running', symbols.length + ' symbols', 0.1);
  const r = await wlSyncOne(name, symbols, d => fiSet(key, 'running', d, 0.5));
  totals.added += r.added; totals.removed += r.removed; totals.total += r.count; totals.dropped.push(...r.dropped);
  run.done.push(wlDoneLine(name, r));
  fiSet(key, 'done', wlStepDetail(r));
}

async function wlPhaseLists(run, plan){
  const totals = { added: 0, removed: 0, total: 0, dropped: [], empty: [] };
  for(let i = 0; i < run.names.length; i++) await wlSyncPick(run, plan, i, totals);
  return totals;
}

// Last step: delete the four fixed lists of the earlier version, one at a time, unless a ticked strategy uses that name.
async function wlPhaseOld(run){
  run.current = 'old'; fiSet('old', 'running', '', 0.5);
  const gone = [];
  for(const old of WL_OLD){
    if(run.names.includes(old)) continue;
    const before = await wlRead(), hit = wlCustom(before).filter(l => l.name === old);
    if(hit.length === 1){ await wlDeleteChecked(hit[0], before); gone.push(old); }
  }
  if(gone.length) run.done.push('Removed old lists: ' + gone.join(', '));
  fiSet('old', 'done', gone.length ? gone.length + ' removed' : 'none found');
}

async function wlFinish(run, plan, totals){
  const partial = totals.dropped.length > 0 || plan.needsLookup.length > 0 || totals.empty.length > 0;
  const note = wlNote(run.names, plan);
  await run.saveLog({ startedAt: run.startedAt, finishedAt: new Date().toISOString(), status: partial ? 'partial' : 'completed', triggeredBy: 'manual', qualifiedCount: totals.total, added: totals.added, removed: totals.removed, droppedTickers: totals.dropped.concat(plan.needsLookup.map(x => x.code)), note });
  await fiRetry(() => run.job.set({ status: 'done', finishedAt: new Date().toISOString(), note })); run.locked = false;
  fiShowResult(partial ? 'warn' : 'ok', wlResultLines({ picks: run.picks, done: run.done, added: totals.added, removed: totals.removed, dropped: totals.dropped, partial, plan }), true);
}

async function wlExecute(run){
  run.stopBeat = await fiTakeLock(run.job, when => 'another sync is already running (' + when + '). Try again in a few minutes.', { startedAt: run.startedAt }); run.locked = true;
  await run.saveLog({ startedAt: run.startedAt, status: 'running', triggeredBy: 'manual', note: 'Running from the page.' });
  const plan = await wlPhaseBuild(run);
  const totals = await wlPhaseLists(run, plan);
  await wlPhaseOld(run);
  await wlFinish(run, plan, totals);
}

async function wlFail(run, e){
  console.error('Watchlist sync failed', e);
  const state = getFiState();
  if(state){ state.error = e; if(run.current && state.status[run.current] !== 'done') fiSet(run.current, 'error', ''); }
  const msg = e && e.code ? tvErrorText(e) : ((e && e.message) ? e.message : String(e));
  fiShowResult('err', wlStoppedLines(msg, run.done), true);
  await run.saveLog({ startedAt: run.startedAt, finishedAt: new Date().toISOString(), status: 'failed', triggeredBy: 'manual', error: msg.slice(0, 400), note: run.done.join(' | ').slice(0, 400) });
  if(run.locked) await fiMarkFailed(run.job, msg);
}

async function wlRunSync(){
  if(getFiRunning() || !getFiOwner()) return;
  const db = getFiDb();
  setFiPfx('wl_');
  const picks = strategies.filter(x => picked.has(x.id)).map(x => ({ name: x.name.trim(), rules: x.rules }));
  const problem = db ? wlPicksProblem(picks) : 'The database is not available in this view, so the sync cannot run here.';
  if(problem){ fiReset('Watchlist sync', wlSteps(picks)); fiShowResult('err', [{ text: problem }], true); return; }
  setFiRunning(true); fiSetButtons(); fiReset('Syncing TradingView watchlists', wlSteps(picks));
  const run = wlNewRun(db, picks);
  try { await wlExecute(run); }
  catch(e){ await wlFail(run, e); }
  finally { run.stopBeat(); setFiRunning(false); fiSetButtons(); }
}

export { wlRunSync, renderWlPicker };
