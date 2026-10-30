// The News page's saved data, listened to live: news/pulse, news/macro and news/events (see model.js). Nothing is kept anywhere else.
import { dbCapabilityPromise } from '../core/store.js';
import { renderLoadedPart } from '../core/lazy.js';

/** @type {{ pulse: any, macro: any, events: any, ready: boolean, noDb: boolean }} */
const news = { pulse: null, macro: null, events: null, ready: false, noDb: false };
let started = false;
/** @type {null | (() => void)} */
let onChange = null;
// Called after every change of the saved news, so the grids and the stock page can show the event marks.
const setNewsChangeHook = (fn) => { onChange = fn; };
const newsChanged = () => { if(onChange) onChange(); };

// Starts listening once; `again` (the News page opening) listens afresh, so a boot-time listener that never delivered cannot leave the page empty.
// A listener that errors is restarted a few times, and one that has delivered nothing after a few seconds is restarted once.
/** @type {null | (() => void)} */
let unsub = null;
let heard = false, tries = 0;
/** @param {boolean} [again] */
async function startNewsSync(again){
  if(started && !again) return;
  started = true;
  let db = null;
  try { db = await dbCapabilityPromise; } catch(e){ db = null; }
  const done = () => { news.ready = true; renderLoadedPart('news'); newsChanged(); };
  if(!db){ news.noDb = true; done(); return; }
  if(unsub){ try { unsub(); } catch(e){ /* the old listener is already gone */ } unsub = null; }
  heard = false;
  const retry = () => { if(tries++ < 5) setTimeout(() => startNewsSync(true), 3000 * tries); };
  try {
    unsub = db.collection('news').onSnapshot(
      (snap) => {
        const seen = new Set();
        snap.docs.forEach(d => { if(d.exists && (d.id === 'pulse' || d.id === 'macro' || d.id === 'events')){ news[d.id] = d.data(); seen.add(d.id); } });
        ['pulse', 'macro', 'events'].forEach(k => { if(!seen.has(k)) news[k] = null; });
        if(seen.size) heard = true;
        done();
      },
      (err) => { console.error('News sync error', err); done(); retry(); }
    );
    setTimeout(() => { if(!heard) retry(); }, 8000);
  } catch(e){ console.error('News unavailable', e); done(); }
}

export { news, newsChanged, setNewsChangeHook, startNewsSync };
