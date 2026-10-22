// TradingView watchlist sync.
import { lockBusy, lockText, startBeat, tabId } from './joblock.js';
import { getDb, watchlistSyncLog } from '../core/store.js';
import { stocks } from '../core/stocks.js';
import { sanitizeDocId } from '../core/util.js';
import { renderWatchlistSyncLogPanel } from '../joblogs/panels.js';
import { TV_SERVER, tvCall, tvErrorText, tvMcp } from '../tv/connector.js';
import { strategies } from '../strategies/state.js';
import { qualifyingStocks, ruleReady } from '../strategies/rules.js';
import { albaFiErr, albaFiRetry, getFiDb, getFiOwner, getFiRunning, setFiRunning, fiSetButtons } from './fund-import.js';
import { setFiPfx, fiReset, fiSet, fiShowResult, getFiState } from './panel.js';

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
// ====================================================================================================
const WL_OLD = ['Alba Securities', 'Alba - Green', 'Alba - Orange', 'Alba - Red'];
const WL_CHUNK = 300;
const WL_CONFIRMED = { 'KLBRENG-B': 'NSE:KLBRENG_B', 'NAM-INDIA': 'NSE:NAM_INDIA', 'J&KBANK': 'NSE:J&KBANK', 'GVT&D': 'NSE:GVT&D' };
const picked = new Set();   // ids of the strategies ticked in the picker

// ---- Which stocks go where ----
// picks = [{ name, rules }] -> { lists: { name: [symbols] }, needsLookup, unverified, notes }
function albaWlBuild(universe, bseMap, picks){
  const alpha = Object.assign({}, bseMap || {});
  for(const k of ['version', 'updatedAt', '__version', '_version']) delete alpha[k];
  const lists = {}, needsLookup = [], unverified = [], notes = [], lookedUp = new Set();
  for(const pick of picks){
    const seen = new Set(); lists[pick.name] = [];
    for(const s of qualifyingStocks(universe, pick.rules)){
      const code = String(s.ticker).split('·')[0].trim();
      let sym;
      if(/^\d+$/.test(code)){
        const a = alpha[code];
        if(!a){ if(!lookedUp.has(code)){ lookedUp.add(code); needsLookup.push({ code, name: s.name }); } continue; }
        sym = 'BSE:' + String(a).replace(/^BSE:/, '');
      } else if(WL_CONFIRMED[code]) sym = WL_CONFIRMED[code];
      else if(/[-&]/.test(code)){ sym = 'NSE:' + code.replace(/[-&]/g, '_'); if(!unverified.includes(code)) unverified.push(code); }
      else sym = 'NSE:' + code;
      if(seen.has(sym)){ notes.push('duplicate symbol skipped: ' + sym); continue; }
      seen.add(sym); lists[pick.name].push(sym);
    }
  }
  for(const k in lists) for(const x of lists[k]) if(/^BSE:\d+$/.test(x)) throw new Error('refusing to send a raw BSE code (' + x + ')');
  return { lists, needsLookup, unverified, notes };
}

// A BSE-only stock with no saved TradingView symbol: search by company name and accept ONLY a BSE stock whose
// description equals the company name (ignoring Ltd / Limited / punctuation). Near matches are left for a person.
const wlNorm = t => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(limited|ltd|the|co|company|pvt|private)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
async function albaWlResolveBse(items){
  const found = {};
  for(const it of items.slice(0, 40)){
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
const wlSet = a => new Set(a);
const wlSame = (a, b) => { const x = wlSet(a), y = wlSet(b); if(x.size !== y.size) return false; for(const v of x) if(!y.has(v)) return false; return true; };
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
  if(ids.has(String(target.id))) throw new Error('"' + target.name + '" could not be deleted' + (err ? ' (' + albaFiErr(err) + ')' : ''));
  return after;
}

// Rebuild one list. Returns { action, count, added, removed, dropped[] }.
async function albaWlSyncOne(name, symbols, onDetail){
  let lists = await wlRead();
  const customs = wlCustom(lists);
  const old = customs.filter(l => l.name === name);
  if(old.length > 1) throw new Error('there are ' + old.length + ' lists called "' + name + '" in TradingView; rename or delete the extras first');
  const oldSyms = old.length ? (old[0].symbols || []) : [];
  if(old.length && wlSame(oldSyms, symbols)) return { action: 'unchanged', count: symbols.length, added: 0, removed: 0, dropped: [] };
  const tmpName = name + ' (syncing)';
  for(const l of customs.filter(l => l.name === tmpName)) lists = await wlDeleteChecked(l, lists);   // leftover of an earlier failed run
  onDetail('Creating the new list…');
  try { await wlWrite('mcp-watchlist-create-watchlist', { name: tmpName, symbols: symbols.slice(0, WL_CHUNK) }); } catch(e){ if(!e.ambiguous) throw e; }
  lists = await wlRead();
  const tmps = wlCustom(lists).filter(l => l.name === tmpName);
  if(tmps.length !== 1) throw new Error('could not create the temporary list in TradingView' );
  const tmpId = String(tmps[0].id);
  for(let i = WL_CHUNK; i < symbols.length; i += WL_CHUNK){
    onDetail('Adding symbols ' + Math.min(i + WL_CHUNK, symbols.length) + ' / ' + symbols.length + '…');
    try { await wlWrite('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: symbols.slice(i, i + WL_CHUNK) }); } catch(e){ if(!e.ambiguous) throw e; }
  }
  const have = async () => { const l = (await wlRead()).find(x => String(x.id) === tmpId); if(!l) throw new Error('the temporary list disappeared'); return l.symbols || []; };
  onDetail('Checking it…');
  let got = await have(), missing = symbols.filter(x => !wlSet(got).has(x));
  if(missing.length){            // one more try for what did not land
    for(let i = 0; i < missing.length; i += WL_CHUNK){ try { await wlWrite('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: missing.slice(i, i + WL_CHUNK) }); } catch(e){ if(!e.ambiguous) throw e; } }
    got = await have(); missing = symbols.filter(x => !wlSet(got).has(x));
  }
  const dropped = [];
  if(missing.length){
    onDetail('Resolving ' + missing.length + ' symbols TradingView dropped…');
    for(const sym of missing.slice(0, 30)){
      const alt = await wlAlternative(sym);
      if(alt){ try { await wlWrite('mcp-watchlist-add-to-watchlist', { watchlist_id: tmpId, symbols: [alt] }); } catch(e){ if(!e.ambiguous) throw e; } }
    }
    got = await have();
    const gs = wlSet(got);
    for(const sym of missing){
      const tk = sym.split(':')[1];
      if(!gs.has(sym) && !got.some(x => x.split(':')[1] === tk || x.split(':')[1] === tk.replace(/_/g, '&'))) dropped.push(sym);
    }
  }
  if(dropped.length > Math.max(10, symbols.length * 0.03)) throw new Error('TradingView did not accept ' + dropped.length + ' of ' + symbols.length + ' symbols, so the existing "' + name + '" list was left untouched (the new one is saved as "' + tmpName + '")');
  if(old.length){
    onDetail('Replacing the old list…');
    lists = await wlDeleteChecked(old[0], await wlRead());
  }
  try { await wlWrite('mcp-watchlist-update-watchlist', { watchlist_id: tmpId, name }); } catch(e){ if(!e.ambiguous) throw e; }
  const fin = (await wlRead()).find(x => String(x.id) === tmpId);
  if(!fin || fin.name !== name) throw new Error('the new list is ready but could not be renamed; it is saved as "' + tmpName + '" in TradingView');
  const nowSyms = wlSet(oldSyms), newSyms = wlSet(symbols);
  return { action: old.length ? 'replaced' : 'created', count: (fin.symbols || []).length, added: symbols.filter(x => !nowSyms.has(x)).length, removed: oldSyms.filter(x => !newSyms.has(x)).length, dropped };
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
    const nm = document.createElement('span'); nm.className = 'wl-pick-name'; nm.textContent = st.name;
    const sub = document.createElement('span'); sub.className = 'wl-pick-sub';
    const nRules = st.rules.filter(ruleReady).length;
    sub.textContent = ready ? 'Writes the stocks that pass ' + (nRules === 1 ? 'its rule' : 'all ' + nRules + ' rules') + ' to a TradingView watchlist.' : 'No rules yet, so there is nothing to sync.';
    txt.append(nm, sub);
    label.append(box, txt); host.appendChild(label);
  }
  if(!strategies.length){ const p = document.createElement('p'); p.className = 'upload-hint'; p.textContent = 'No strategies yet. Create one in Strategies first.'; host.appendChild(p); }
}
window.addEventListener('alba-strategies-reloaded', renderWlPicker);

async function albaWlRunSync(){
  if(getFiRunning() || !getFiOwner()) return;
  const db = getFiDb();
  setFiPfx('wl_');
  const picks = strategies.filter(x => picked.has(x.id)).map(x => ({ name: x.name.trim(), rules: x.rules }));
  const steps = [{ key: 'build', label: 'Match the stocks', w: 10 }]
    .concat(picks.map((p, i) => ({ key: 'l' + i, label: p.name, w: Math.max(1, 80 / picks.length) })), [{ key: 'old', label: 'Remove the old fixed lists', w: 10 }]);
  if(!db){ fiReset('Watchlist sync', steps); fiShowResult('err', [{ text: 'The database is not available in this view, so the sync cannot run here.' }], true); return; }
  if(!picks.length){ fiReset('Watchlist sync', steps); fiShowResult('err', [{ text: 'Tick at least one strategy to sync.' }], true); return; }
  const names = picks.map(p => p.name);
  if(names.some(n => !n) || new Set(names).size !== names.length){ fiReset('Watchlist sync', steps); fiShowResult('err', [{ text: 'Each ticked strategy needs its own name, because the TradingView list takes the strategy name.' }], true); return; }
  setFiRunning(true); fiSetButtons(); fiReset('Syncing TradingView watchlists', steps);
  const job = db.doc('importJobs/watchlist'); let locked = false, current = 'build', stopBeat = () => {};
  const startedAt = new Date().toISOString(), logId = sanitizeDocId(startedAt);
  const logDb = getDb();
  const saveLog = async rec => {
    try { watchlistSyncLog.put(logId, rec); renderWatchlistSyncLogPanel(); if(logDb){ await logDb.collection('watchlistSyncLog').doc(logId).set(JSON.parse(JSON.stringify(rec))); } } catch(e){ console.error('Could not save the sync log', e); }
  };
  const done = [];
  try {
    const lk = await albaFiRetry(() => job.get()); const ld = lk && lk.exists ? lk.data() : null;
    if(lockBusy(ld)) throw new Error('another sync is already running (' + lockText(ld) + '). Try again in a few minutes.');
    await albaFiRetry(() => job.set({ status: 'running', startedAt, owner: tabId })); locked = true; stopBeat = startBeat(job);
    await saveLog({ startedAt, status: 'running', triggeredBy: 'manual', note: 'Running from the page.' });

    current = 'build'; fiSet('build', 'running', '', 0.5);
    let bse = {};
    try { const bs = await albaFiRetry(() => db.doc('stockMeta/bseAlpha').get()); if(bs && bs.exists) bse = bs.data() || {}; } catch(e){ console.error('Could not read the BSE symbol map', e); }
    let plan = albaWlBuild(stocks, bse, picks);
    if(plan.needsLookup.length){
      fiSet('build', 'running', 'Looking up ' + plan.needsLookup.length + ' BSE symbol(s)…', 0.5);
      const found = await albaWlResolveBse(plan.needsLookup);
      if(Object.keys(found).length){
        try { await albaFiRetry(() => db.doc('stockMeta/bseAlpha').update(found)); } catch(e){ console.error('Could not save the new BSE symbols', e); }
        Object.assign(bse, found); plan = albaWlBuild(stocks, bse, picks);
      }
    }
    fiSet('build', 'done', names.map(n => plan.lists[n].length).join(' / ') + ' symbols');

    let added = 0, removed = 0, total = 0; const dropped = [], empty = [];
    for(let i = 0; i < picks.length; i++){
      const name = names[i], key = 'l' + i; current = key;
      if(!plan.lists[name].length){ empty.push(name); done.push(name + ': no stock matches, list left as it is'); fiSet(key, 'done', 'no match'); continue; }
      fiSet(key, 'running', plan.lists[name].length + ' symbols', 0.1);
      const r = await albaWlSyncOne(name, plan.lists[name], d => fiSet(key, 'running', d, 0.5));
      added += r.added; removed += r.removed; total += r.count; r.dropped.forEach(x => dropped.push(x));
      done.push(name + ': ' + (r.action === 'unchanged' ? r.count + ' symbols, unchanged' : r.count + ' symbols (+' + r.added + ' / −' + r.removed + ')'));
      fiSet(key, 'done', r.action === 'unchanged' ? 'unchanged' : '+' + r.added + ' / −' + r.removed);
    }

    current = 'old'; fiSet('old', 'running', '', 0.5);
    const gone = [];
    for(const old of WL_OLD){
      if(names.includes(old)) continue;
      const before = await wlRead(), hit = wlCustom(before).filter(l => l.name === old);
      if(hit.length === 1){ await wlDeleteChecked(hit[0], before); gone.push(old); }
    }
    if(gone.length) done.push('Removed old lists: ' + gone.join(', '));
    fiSet('old', 'done', gone.length ? gone.length + ' removed' : 'none found');

    const partial = dropped.length > 0 || plan.needsLookup.length > 0 || empty.length > 0;
    const note = names.map(n => n + ' ' + plan.lists[n].length).join(', ') + '.' + (plan.needsLookup.length ? ' No TradingView symbol yet for ' + plan.needsLookup.length + ' BSE-only stocks.' : '');
    await saveLog({ startedAt, finishedAt: new Date().toISOString(), status: partial ? 'partial' : 'completed', triggeredBy: 'manual', qualifiedCount: total, added, removed, droppedTickers: dropped.concat(plan.needsLookup.map(x => x.code)), note });
    await albaFiRetry(() => job.set({ status: 'done', finishedAt: new Date().toISOString(), note })); locked = false;
    const lines = [{ text: partial ? 'Sync finished with gaps.' : 'Sync complete.', cls: 'fi-line fi-line-strong' }, ...done.map(t => ({ text: t })),
      { text: picks.length + ' strateg' + (picks.length === 1 ? 'y' : 'ies') + ' · ' + added + ' added · ' + removed + ' removed in total.' }];
    if(dropped.length) lines.push({ text: 'TradingView could not resolve: ' + dropped.slice(0, 15).join(', ') + (dropped.length > 15 ? ' … +' + (dropped.length - 15) : '') + '.', cls: 'fi-line fi-line-muted' });
    if(plan.needsLookup.length) lines.push({ text: 'No TradingView symbol yet (left out): ' + plan.needsLookup.slice(0, 8).map(x => x.code + ' ' + x.name).join('; ') + (plan.needsLookup.length > 8 ? ' … +' + (plan.needsLookup.length - 8) : '') + '.', cls: 'fi-line fi-line-muted' });
    if(plan.unverified.length) lines.push({ text: 'Symbols with - or & that were not checked beforehand: ' + plan.unverified.join(', ') + '.', cls: 'fi-line fi-line-muted' });
    fiShowResult(partial ? 'warn' : 'ok', lines, true);
  } catch(e){
    console.error('Watchlist sync failed', e);
    if(getFiState()){ getFiState().error = e; if(current && getFiState().status[current] !== 'done') fiSet(current, 'error', ''); }
    const msg = e && e.code ? tvErrorText(e) : ((e && e.message) ? e.message : String(e));
    fiShowResult('err', [{ text: 'Sync stopped: ' + msg, cls: 'fi-line fi-line-strong' }].concat(done.map(t => ({ text: 'Done before the stop — ' + t, cls: 'fi-line fi-line-muted' }))), true);
    await saveLog({ startedAt, finishedAt: new Date().toISOString(), status: 'failed', triggeredBy: 'manual', error: msg.slice(0, 400), note: done.join(' | ').slice(0, 400) });
    if(locked){ try { await job.set({ status: 'failed', finishedAt: new Date().toISOString(), error: msg.slice(0, 500) }); } catch(x){} }
  } finally {
    stopBeat(); setFiRunning(false); fiSetButtons();
  }
}

export { albaWlResolveBse, albaWlRunSync, renderWlPicker };
