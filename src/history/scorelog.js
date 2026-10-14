// Score log: one record per stock per live refresh, WITH the inputs the score was built from, so the real live score can be
// replayed and back-tested later (the trend in scoreHistory keeps only the final scores, and only after imports).
// Stored in the database collection `scoreLog`, one document per stock:
//   scoreLog/<ticker> = { v: 1, rows: [ { d, src, engine, score, val, wk, mo, mR, wR, mML, mMS, wML, wMS, pS }, ... ] }
//   d = IST date of the refresh, src = 'bars', engine = SCORE_ENGINE, score = saved technical score, val = valuation pillar,
//   wk / mo = open date of the last COMPLETED weekly / monthly bar, mR / wR = monthly / weekly RSI, mML / mMS and wML / wMS =
//   MACD level and signal (monthly, weekly), pS = provisional score from the in-progress week or month (null when none).
// One row per date (a second refresh the same day replaces it); the oldest rows are dropped past MAX_ROWS.
import { SCORE_ENGINE } from './scorehistory.js';

const MAX_ROWS = 400;
const r4 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10000) / 10000 : null;

// The row for a technical block as computeTechnical returns it, or null when it has no score.
function logRowFor(t, today){
  if(!t || typeof t.score !== 'number') return null;
  const r = t.raw || {}, b = t.basis || {};
  return { d: today, src: 'bars', engine: SCORE_ENGINE, score: r4(t.score), val: r4(r.valuationScore), wk: b.week || null, mo: b.month || null,
    mR: r4(r.monthRsi), wR: r4(r.weekRsi), mML: r4(r.monthMacdLevel), mMS: r4(r.monthMacdSignal), wML: r4(r.weekMacdLevel), wMS: r4(r.weekMacdSignal),
    pS: t.provisional ? r4(t.provisional.score) : null };
}
// Adds a row to a stock's rows: replaces the same date, keeps them sorted by date, caps the length.
function addLogRow(rows, row){
  const next = (Array.isArray(rows) ? rows : []).filter(x => x && x.d !== row.d);
  next.push(row);
  next.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
}
// Writes today's row for one stock. Never throws: the score has already been saved, a failure here only means a missing row.
async function recordScoreLog(db, id, t, today){
  try {
    const row = logRowFor(t, today); if(!row) return false;
    const ref = db.doc('scoreLog/' + id);
    const snap = await ref.get();
    const cur = snap && snap.exists ? (snap.data() || {}) : {};
    await ref.set({ v: 1, rows: addLogRow(cur.rows, row) });
    return true;
  } catch(e){ console.error('Score log was not recorded', e); return false; }
}

export { recordScoreLog };
