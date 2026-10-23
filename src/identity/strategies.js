// Strategies (rules, goals, notes) are saved in their own record, data/users/<uid>/strategies, as one JSON text
// (so the database never has to cope with lists inside lists), and written within a third of a second of a change.
import { STRAT_AT_KEY, STRAT_KEY } from './keys.js';
import { getUid, userRef } from './session.js';

let stratTimer = null, stratPending = null, stratChain = Promise.resolve();
let status = '';   // '' | 'browser' | 'saving' | 'saved' | 'failed' (shown in the Strategies list)

function getStrategiesStatus(){ return status; }
function setStatus(v){ status = v; window.dispatchEvent(new Event('alba-strategies-status')); }
function stratWrite(){
  stratTimer = null;
  const ref = userRef('data/users/{uid}/strategies');
  if(!ref || stratPending === null) return;
  const json = stratPending; stratPending = null;
  stratChain = stratChain.then(() => ref.set({ v: 1, json, updatedAt: new Date().toISOString() }))
    .then(() => setStatus(stratPending === null ? 'saved' : 'saving'))
    .catch(e => { console.error('Could not save strategies', e); setStatus('failed'); });
}
function flushStrategies(){ if(stratTimer){ clearTimeout(stratTimer); stratWrite(); } }
function strategiesSave(json){
  try { localStorage.setItem(STRAT_KEY, json); localStorage.setItem(STRAT_AT_KEY, new Date().toISOString()); } catch(e){ /* storage unavailable */ }
  if(!userRef('data/users/{uid}/strategies')){ setStatus('browser'); return; }
  stratPending = json; setStatus('saving');
  clearTimeout(stratTimer); stratTimer = setTimeout(stratWrite, 300);
}
// Runs before the app starts (and may finish late): the saved strategies replace this browser's copy.
async function syncStrategies(){
  const ref = userRef('data/users/{uid}/strategies');
  if(!ref){ setStatus(getUid() ? 'failed' : 'browser'); return; }
  try {
    const snap = await ref.get();
    const d = snap && snap.exists ? snap.data() : null;
    let local = null, localAt = 0;
    try { local = localStorage.getItem(STRAT_KEY); localAt = Date.parse(localStorage.getItem(STRAT_AT_KEY)) || 0; } catch(e){ /* storage unavailable: the database copy is used */ }
    if(d && typeof d.json === 'string' && !(local && localAt > (Date.parse(d.updatedAt) || 0))){
      try { localStorage.setItem(STRAT_KEY, d.json); } catch(e){ /* storage unavailable: the database copy still applies */ }
      window.dispatchEvent(new Event('alba-strategies-synced'));
    } else if(local){
      await ref.set({ v: 1, json: local, updatedAt: new Date().toISOString() });   // first visit with this feature, or a newer change not yet saved
    }
    setStatus('saved');
  } catch(e){ console.error('Could not load strategies', e); setStatus('failed'); }
}

export { flushStrategies, getStrategiesStatus, strategiesSave, syncStrategies };
