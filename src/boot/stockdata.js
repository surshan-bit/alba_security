// STOCK DATA LOADER. The stock list is stored in the artifact database:
//   stockMeta/main  -> { version, updatedAt, count, chunks:[ids], index:{docId: chunkId} }
//   stockData/cNNN  -> { chunk, count, stocks:[...] }   (~190 KB each, in score order)
// The page reads the (tiny) meta document first; if its version matches the copy cached in this browser (IndexedDB) the
// cached list is used, otherwise every chunk is fetched and cached. Research overlays (stockResearch, stockUpdates,
// priceHistory) are applied on top afterwards. Whoever changes the base data (CSV refresh) writes the changed chunks and
// then bumps stockMeta/main.version; open pages show a "data updated - reload" banner.
import { debugHandle } from './handoff.js';
import { bootMessage, hideBootMessage, showUpdateBanner } from './status.js';

const DATA_DB = 'albaStockCache', DATA_STORE = 'kv';

function cacheOpen(){
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(DATA_DB, 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore(DATA_STORE); } catch(e){} };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch(e){ resolve(null); }
  });
}
async function cacheGet(version){
  const idb = await cacheOpen(); if(!idb) return null;
  return new Promise((resolve) => {
    try {
      const q = idb.transaction(DATA_STORE, 'readonly').objectStore(DATA_STORE).get('v' + version);
      q.onsuccess = () => { try { resolve(typeof q.result === 'string' ? JSON.parse(q.result) : null); } catch(e){ resolve(null); } };
      q.onerror = () => resolve(null);
    } catch(e){ resolve(null); }
  });
}
async function cachePut(version, list){
  const idb = await cacheOpen(); if(!idb) return;
  try {
    const tx = idb.transaction(DATA_STORE, 'readwrite');
    const os = tx.objectStore(DATA_STORE);
    os.clear();
    os.put(JSON.stringify(list), 'v' + version);
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve; });
  } catch(e){ /* cache is optional */ }
}
async function fetchChunk(db, id){
  let lastErr;
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      const snap = await db.doc('stockData/' + id).get();
      const d = snap && snap.exists ? snap.data() : null;
      if(d && Array.isArray(d.stocks)) return d.stocks;
      lastErr = new Error('chunk ' + id + ' is missing');
    } catch(e){ lastErr = e; }
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
  }
  throw lastErr;
}

// Resolves with the stock list; on failure shows the reason on the cover (with a Retry button) and rejects.
async function loadStocks(){
  const t0 = performance.now();
  const info = { source: 'database', cache: false, version: null, count: 0, ms: 0 };
  const db = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('db').catch(() => null) : null;
  let list = null, meta = null, failure = '';
  if(db){
    try {
      bootMessage('Loading stock data…');
      const ms = await db.doc('stockMeta/main').get();
      meta = ms && ms.exists ? ms.data() : null;
      if(!meta || !Array.isArray(meta.chunks)) throw new Error('stock index not found in the database');
      info.version = meta.version;
      list = await cacheGet(meta.version);
      if(list && list.length === meta.count){ info.cache = true; }
      else {
        list = null;
        const parts = new Array(meta.chunks.length);
        let next = 0, done = 0;
        const worker = async () => {
          while(next < meta.chunks.length){
            const i = next++;
            parts[i] = await fetchChunk(db, meta.chunks[i]);
            done++;
            bootMessage('Loading stock data… ' + Math.round(done / meta.chunks.length * 100) + '%');
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, meta.chunks.length) }, worker));
        list = [].concat(...parts);
        if(list.length !== meta.count) throw new Error('expected ' + meta.count + ' stocks but received ' + list.length);
        cachePut(meta.version, list);
      }
    } catch(e){
      failure = (e && (e.message || e.code)) || String(e);
      list = null;
    }
  } else {
    failure = 'the database is not available in this view';
  }
  if(!list){
    bootMessage('Could not load the stock data: ' + failure + '.', true);
    throw new Error('stock data unavailable: ' + failure);
  }
  info.count = list.length; info.ms = Math.round(performance.now() - t0);
  hideBootMessage();
  debugHandle().loadInfo = info;
  if(db){
    // Record how this view loaded, but only when it differs from the last record (never on every load).
    (async () => {
      try {
        const ref = db.doc('diagnostics/stockLoad');
        const cur = await ref.get();
        const c = cur && cur.exists ? cur.data() : null;
        if(!c || c.source !== info.source || c.version !== info.version || c.count !== info.count){
          await ref.set({ source: info.source, version: info.version, count: info.count, cache: info.cache, ms: info.ms, failure: info.failure || null, at: new Date().toISOString() });
        }
      } catch(e){ /* diagnostics are optional */ }
    })();
    if(meta){
      try {
        db.doc('stockMeta/main').onSnapshot((snap) => {
          const d = snap && snap.exists ? snap.data() : null;
          if(d && info.version != null && d.version !== info.version) showUpdateBanner();
        }, () => {});
      } catch(e){}
    }
  }
  return list;
}

// After an import or restore the page already holds the new list: saving it under the new version lets the reload that follows
// start from this browser's copy instead of fetching every part again.
const primeStockCache = (version, list) => cachePut(version, list);

export { loadStocks, primeStockCache };
