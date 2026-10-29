// The last Process result of each Buy / Sell ideas strategy (v1.293), kept so the lists and their date stamp are still there after the page is refreshed or opened on
// another device. One small record per person, data/users/<uid>/ideasResults, holding one JSON text: { <strategy id>: snapshot }. The browser keeps a copy for an
// instant first paint and for use without a sign-in; the saved record is merged in when the page opens (the newer result of each strategy wins).
import { userRef } from './session.js';

const KEY = 'albaDashboard.ideasResults.v1', MAX_KEPT = 20;
let timer = null, chain = Promise.resolve();

// v1.306: parsed once per stored text, so asking again (Analysis does, many times per redraw) costs nothing and returns the same object while nothing changed.
let lastRaw = null, lastMap = {};
function readLocal(){
  let raw = '{}';
  try { raw = localStorage.getItem(KEY) || '{}'; } catch(e){ return {}; }
  if(raw === lastRaw) return lastMap;
  let o = {};
  try { o = JSON.parse(raw); } catch(e){ o = {}; }
  lastRaw = raw; lastMap = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  return lastMap;
}
// The newest results first, at most MAX_KEPT strategies.
function trim(map){
  const keep = Object.keys(map).sort((a, b) => String(map[b].at).localeCompare(String(map[a].at))).slice(0, MAX_KEPT), out = {};
  keep.forEach(k => { out[k] = map[k]; });
  return out;
}
function ideasResultsGet(){ return readLocal(); }
function write(){
  timer = null;
  const ref = userRef('data/users/{uid}/ideasResults');
  if(!ref) return;
  const json = JSON.stringify(readLocal());
  chain = chain.then(() => ref.set({ v: 1, json, updatedAt: new Date().toISOString() })).catch(e => console.error('Could not save the Buy / Sell ideas result', e));
}
function ideasResultsSave(sid, snapshot){
  const map = readLocal(); map[sid] = snapshot;
  try { localStorage.setItem(KEY, JSON.stringify(trim(map))); } catch(e){ /* storage unavailable: the saved record still keeps it */ }
  if(!userRef('data/users/{uid}/ideasResults')) return;
  clearTimeout(timer); timer = setTimeout(write, 300);
}
// Runs while the page starts (and may finish late): the saved record is merged with this browser's copy, the newer result of each strategy winning.
async function syncIdeasResults(){
  const ref = userRef('data/users/{uid}/ideasResults');
  if(!ref) return;
  try {
    const snap = await ref.get();
    const d = snap && snap.exists ? snap.data() : null;
    let remote = {};
    try { remote = d && typeof d.json === 'string' ? JSON.parse(d.json) : {}; } catch(e){ remote = {}; }
    const local = readLocal(), merged = {};
    let changedLocal = false, changedRemote = false;
    new Set([...Object.keys(remote), ...Object.keys(local)]).forEach(k => {
      const a = remote[k], b = local[k];
      if(a && (!b || String(a.at) > String(b.at))){ merged[k] = a; changedLocal = true; }
      else { merged[k] = b; if(!a || String(b.at) > String(a.at)) changedRemote = true; }
    });
    const out = trim(merged);
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch(e){ /* storage unavailable */ }
    if(changedRemote) await ref.set({ v: 1, json: JSON.stringify(out), updatedAt: new Date().toISOString() });
    if(changedLocal) window.dispatchEvent(new Event('alba-ideas-synced'));
  } catch(e){ console.error('Could not load the Buy / Sell ideas result', e); }
}

export { ideasResultsGet, ideasResultsSave, syncIdeasResults };
