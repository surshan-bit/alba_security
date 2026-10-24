// The News page's saved data, listened to live: news/pulse, news/macro and news/events (see model.js). Nothing is kept anywhere else.
import { dbCapabilityPromise } from '../core/store.js';
import { renderLoadedPart } from '../core/lazy.js';

/** @type {{ pulse: any, macro: any, events: any, ready: boolean, noDb: boolean }} */
const news = { pulse: null, macro: null, events: null, ready: false, noDb: false };
let started = false;

// Starts listening once. The page is redrawn (if it is open) on every change.
async function startNewsSync(){
  if(started) return;
  started = true;
  let db = null;
  try { db = await dbCapabilityPromise; } catch(e){ db = null; }
  const done = () => { news.ready = true; renderLoadedPart('news'); };
  if(!db){ news.noDb = true; done(); return; }
  try {
    db.collection('news').onSnapshot(
      (snap) => {
        const seen = new Set();
        snap.docs.forEach(d => { if(d.exists && (d.id === 'pulse' || d.id === 'macro' || d.id === 'events')){ news[d.id] = d.data(); seen.add(d.id); } });
        ['pulse', 'macro', 'events'].forEach(k => { if(!seen.has(k)) news[k] = null; });
        done();
      },
      (err) => { console.error('News sync error', err); done(); }
    );
  } catch(e){ console.error('News unavailable', e); done(); }
}

export { news, startNewsSync };
