// Score history: one small record per stock per import, kept about three years, so the stock page can show how the
// Fundamental and Technical scores (and the price) moved. Stored in the database collection `scoreHistory`, as 64
// documents `h00`..`h63`; a stock lives in the document its ticker hashes to, so opening a stock reads one document.
//   scoreHistory/hNN = { v: 1, stocks: { <ticker>: [[yyyymmdd, fundamental, technical, price, engine], ...] } }
// Points are sorted by date. A score or price that was not known is null. `engine` is SCORE_ENGINE at the time, so
// the chart can mark where the scoring rules changed (a jump there is the rules, not the company).
import { dbCapabilityPromise } from '../core/store.js';

const SCORE_ENGINE = 3;        // 1 = before v1.171 scoring fixes, 2 = v1.171 onward, 3 = v1.181 onward (live refresh scores completed bars only). Raise it whenever the scoring rules change.
const BUCKETS = 64;
const KEEP_YEARS = 3;

function tickerKey(s){ return String((s && s.ticker) || '').split(' · ')[0].trim(); }
function bucketOf(key){
  let h = 2166136261;
  for(let i = 0; i < key.length; i++){ h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % BUCKETS;
}
function bucketId(n){ return 'h' + String(n).padStart(2, '0'); }
function ymdOf(d){ return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function ymdToDate(n){ return new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100); }
function cutoffYmd(todayYmd){ return todayYmd - KEEP_YEARS * 10000; }
const r2 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null;

// The point to record for a stock as it is now, or null when it has no scores at all.
function pointFor(s, ymd){
  const f = r2(s.score), t = r2(s.technical && s.technical.score), p = r2(s.valuation && s.valuation.currentPrice);
  if(f == null && t == null) return null;
  return [ymd, f, t, p, SCORE_ENGINE];
}
// Adds a point to one stock's series: replaces the same date, drops points older than three years, and skips a point
// that repeats the newest one exactly (an import that changed nothing for this stock). Returns the new series, or
// null when nothing changed.
function addPoint(series, pt){
  const cur = Array.isArray(series) ? series : [];
  const last = cur[cur.length - 1];
  if(last && last[1] === pt[1] && last[2] === pt[2] && last[3] === pt[3] && last[4] === pt[4]) return null;
  const cut = cutoffYmd(pt[0]);
  const next = cur.filter(x => x[0] !== pt[0] && x[0] >= cut);
  next.push(pt);
  next.sort((a, b) => a[0] - b[0]);
  return next;
}

// Records today's point for every stock, after an import. Never throws: the import has already succeeded, and a
// failure here only means the trend misses one point. Returns { written, stocks, error }.
async function recordScoreHistory(db, stockList, ymd){
  const out = { written: 0, stocks: 0, error: null };
  try {
    const today = ymd || ymdOf(new Date());
    const by = new Map();
    for(const s of stockList){
      const key = tickerKey(s); if(!key) continue;
      const pt = pointFor(s, today); if(!pt) continue;
      const b = bucketOf(key);
      if(!by.has(b)) by.set(b, []);
      by.get(b).push([key, pt]);
    }
    const todo = Array.from(by.keys());
    let i = 0;
    const worker = async () => {
      while(i < todo.length){
        const b = todo[i++], ref = db.doc('scoreHistory/' + bucketId(b));
        const snap = await ref.get();
        const doc = snap && snap.exists ? (snap.data() || {}) : {};
        const stocks = doc.stocks && typeof doc.stocks === 'object' ? doc.stocks : {};
        let changed = 0;
        for(const [key, pt] of by.get(b)){
          const next = addPoint(stocks[key], pt);
          if(next){ stocks[key] = next; changed++; }
        }
        if(changed){ await ref.set({ v: 1, stocks }); out.written++; out.stocks += changed; cache.delete(b); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  } catch(e){ out.error = String((e && e.message) || e); console.error('Score history was not recorded', e); }
  return out;
}

// ---- reading, one bucket at a time, cached for the page session ----
const cache = new Map();   // bucket number -> Promise of its `stocks` object
function loadBucket(n){
  if(!cache.has(n)){
    cache.set(n, (async () => {
      const db = await dbCapabilityPromise;
      if(!db) return {};
      const snap = await db.doc('scoreHistory/' + bucketId(n)).get();
      const d = snap && snap.exists ? snap.data() : null;
      return d && d.stocks ? d.stocks : {};
    })().catch(e => { cache.delete(n); throw e; }));
  }
  return cache.get(n);
}
async function loadScoreHistory(s){
  const key = tickerKey(s);
  if(!key) return [];
  const all = await loadBucket(bucketOf(key));
  return Array.isArray(all[key]) ? all[key] : [];
}

export { SCORE_ENGINE, loadScoreHistory, recordScoreHistory, tickerKey, ymdOf, ymdToDate };
