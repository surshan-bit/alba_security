// Forward test: "Track these picks" saves today's qualifying stocks with their entry prices. Later each pick is judged
// against the strategy's goal (did the price reach +target% within the horizon?), so the real success rate builds up.
//
// Stored per user at data/users/<uid>/strategyTracking/runs/<id> (or in this browser only, when not signed in).
// Judging uses the stored weekly bars plus the prices seen each time the page is opened:
//  - a weekly bar that starts after the entry counts with its high;
//  - the week the pick was entered only counts through its latest close and the highest price seen since
//    (its weekly high may be from before the entry), so a hit is never claimed from a move before entry;
//  - the finest detail is therefore one week, unless prices are refreshed more often.
import { tickerSymbol } from '../core/util.js';
import { newsCounts } from './news.js';
import { getIdentityDb, getUid } from '../identity/session.js';

const LS_KEY = 'albaDashboard.strategyRuns.v1';
const DAY_MS = 86400000;
let runsCache = null;

function runsCol(){
  const db = getIdentityDb(), uid = getUid();
  return (db && uid) ? db.doc('data/users/' + uid + '/strategyTracking').collection('runs') : null;
}
const byNewest = (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : (a.id < b.id ? 1 : -1));
function readLocal(){ try { const r = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(r) ? r : []; } catch(e){ return []; } }
function writeLocal(runs){ try { localStorage.setItem(LS_KEY, JSON.stringify(runs)); } catch(e){ /* storage unavailable */ } }

// The database hands documents back read-only (also the lists inside them), but judging a list raises a pick's highest price seen
// so far, so every list is loaded as a plain copy that can be changed.
const editableCopy = (x) => JSON.parse(JSON.stringify(x));
async function loadRuns(){
  if(runsCache) return runsCache;
  let runs = [];
  const col = runsCol();
  if(col){
    try { const snap = await col.get(); runs = snap.docs.filter(d => d.exists).map(d => ({ ...editableCopy(d.data()), id: d.id })); }
    catch(e){ console.error('Could not load tracked picks', e); }
  } else runs = readLocal();
  runs.sort(byNewest);
  runsCache = runs;
  return runs;
}
async function saveRun(run){
  const runs = await loadRuns();
  if(!runs.includes(run)) { runs.push(run); runs.sort(byNewest); }
  const col = runsCol();
  if(col){ try { await col.doc(run.id).set(run); } catch(e){ console.error('Could not save tracked picks', e); return false; } }
  else writeLocal(runs);
  return true;
}
async function deleteRun(run){
  const runs = await loadRuns();
  const i = runs.indexOf(run);
  if(i >= 0) runs.splice(i, 1);
  const col = runsCol();
  if(col){ try { await col.doc(run.id).delete(); } catch(e){ console.error('Could not delete tracked picks', e); return false; } }
  else writeLocal(runs);
  return true;
}
const savesToAccount = () => !!runsCol();

const pad = (n) => String(n).padStart(2, '0');
function todayIso(){ const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isoToMs(iso){ const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function newRunId(){ return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

// Picks are the qualifying stocks that have a price today.
function makeRun(strategy, matches){
  const picks = [];
  matches.forEach(s => {
    const price = s.valuation && s.valuation.currentPrice;
    if(typeof price === 'number' && price > 0){
      const pick = { sym: tickerSymbol(s), name: s.name, entry: price, peak: price, peakAt: todayIso() };
      const c = newsCounts(s);   // the news picture at the time of saving, so results can later be split by it
      if(c){ pick.np = c.pos; pick.nn = c.neg; }
      picks.push(pick);
    }
  });
  return { v: 1, id: newRunId(), strategyId: strategy.id, strategyName: strategy.name, startedAt: todayIso(),
    target: strategy.goal.target, days: strategy.goal.days, rules: JSON.parse(JSON.stringify(strategy.rules)), picks };
}

// -> { status: 'hit' | 'open' | 'miss', hitMs, now, retNow, retBest }. May raise pick.peak (the run then needs saving).
function evaluatePick(run, pick, weekBars, curPrice, nowMs){
  const startMs = isoToMs(run.startedAt), endMs = startMs + run.days * DAY_MS;
  const goalPrice = pick.entry * (1 + run.target / 100);
  let best = Math.max(pick.entry, pick.peak || 0), hitMs = null, last = null;
  let changed = false;
  if(typeof curPrice === 'number' && curPrice > 0){
    last = curPrice;
    if(curPrice > (pick.peak || 0)){ pick.peak = curPrice; pick.peakAt = todayIso(); changed = true; }
    best = Math.max(best, curPrice);
  }
  if(weekBars && weekBars.length){
    for(const b of weekBars){
      const ms = b[0] * 1000;
      if(ms > endMs) break;
      if(ms > startMs){ best = Math.max(best, b[2]); if(hitMs === null && b[2] >= goalPrice) hitMs = ms; }
    }
    const tail = weekBars[weekBars.length - 1];
    if(last === null && tail[4] > 0) last = tail[4];
    if(tail[0] * 1000 <= startMs) best = Math.max(best, tail[4]);   // the entry week: its close only
  }
  if(hitMs === null && best >= goalPrice) hitMs = pick.peak >= goalPrice && pick.peakAt ? Math.max(startMs, isoToMs(pick.peakAt)) : nowMs;
  const status = hitMs !== null ? 'hit' : (nowMs >= endMs ? 'miss' : 'open');
  return { status, hitMs, now: last, retNow: last ? (last / pick.entry - 1) * 100 : null, retBest: (best / pick.entry - 1) * 100, changed };
}

// priceSet: Map(symbol -> {w}); stockBySym: Map(symbol -> stock).
function evaluateRun(run, priceSet, stockBySym, nowMs){
  const startMs = isoToMs(run.startedAt), endMs = startMs + run.days * DAY_MS;
  let changed = false;
  const items = run.picks.map(pick => {
    const s = stockBySym.get(pick.sym);
    const price = s && s.valuation ? s.valuation.currentPrice : null;
    const ev = evaluatePick(run, pick, (priceSet.get(pick.sym) || {}).w, price, nowMs);
    if(ev.changed) changed = true;
    return { pick, ev };
  });
  const counts = { hit: 0, open: 0, miss: 0 };
  items.forEach(it => { counts[it.ev.status]++; });
  const days = items.filter(it => it.ev.status === 'hit').map(it => Math.max(0, Math.round((it.ev.hitMs - startMs) / DAY_MS))).sort((a, b) => a - b);
  return { run, items, counts, finished: nowMs >= endMs, endMs, changed,
    rate: items.length ? counts.hit / items.length : null, medianDays: days.length ? days[Math.floor(days.length / 2)] : null };
}

export { deleteRun, evaluateRun, loadRuns, makeRun, saveRun, savesToAccount };
