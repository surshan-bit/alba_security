// The Rocky page's saved data, listened to live: the documents of the `rocky` collection (state, picks, weights, learn, log).
// Rocky's daily run writes them (a copy of the agent's own ledger); this page only reads. Paper trading only, no real orders.
import { dbCapabilityPromise } from '../core/store.js';
import { renderLoadedPart } from '../core/lazy.js';

const IDS = ['state', 'picks', 'weights', 'learn', 'log'];
/** @type {{ state: any, picks: any, weights: any, learn: any, log: any, ready: boolean, noDb: boolean }} */
const rocky = { state: null, picks: null, weights: null, learn: null, log: null, ready: false, noDb: false };
let started = false, heard = false, tries = 0;
/** @type {null | (() => void)} */
let unsub = null;

// Starts listening once; `again` (the page opening) listens afresh, so a listener that never delivered cannot leave the page empty.
/** @param {boolean} [again] */
async function startRockySync(again){
  if(started && !again) return;
  started = true;
  let db = null;
  try { db = await dbCapabilityPromise; } catch(e){ db = null; }
  const done = () => { rocky.ready = true; renderLoadedPart('rocky'); };
  if(!db){ rocky.noDb = true; done(); return; }
  if(unsub){ try { unsub(); } catch(e){ /* the old listener is already gone */ } unsub = null; }
  heard = false;
  const retry = () => { if(tries++ < 5) setTimeout(() => startRockySync(true), 3000 * tries); };
  try {
    unsub = db.collection('rocky').onSnapshot(
      (snap) => {
        const seen = new Set();
        snap.docs.forEach(d => { if(d.exists && IDS.includes(d.id)){ rocky[d.id] = d.data(); seen.add(d.id); } });
        IDS.forEach(k => { if(!seen.has(k)) rocky[k] = null; });
        if(seen.size) heard = true;
        done();
      },
      (err) => { console.error('Rocky sync error', err); done(); retry(); }
    );
    setTimeout(() => { if(!heard) retry(); }, 8000);
  } catch(e){ console.error('Rocky unavailable', e); done(); }
}

export { rocky, startRockySync };
