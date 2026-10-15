// The live snapshot of Refresh all stocks (v1.198): TradingView's price, MACD and RSI for every stock, saved as ONE record per TradingView
// batch of 50 stocks (collection liveSnapshot, ids c001, c002 ...) instead of one record per stock. The database takes about 1.5 saves a
// second however many are sent at once, so about 44 saves per run instead of about 2,000 is what makes a full refresh fast.
//   liveSnapshot/<c001...> = { v: 1, asof: 'YYYY-MM-DD', at: ISO time, rows: [ { k, y, c: [ ...values in COLS order, null when missing ] }, ... ] }
//   k = the stock's record id (its ticker), y = the TradingView symbol it was read from.
// The page turns each row back into what the refresh used to save per stock ({ valuation, liquidity, technical }) and lays it under that
// stock's own saved update (stockUpdates), which still carries the research notes, Global factors and completed-weeks scores:
// mergedDoc() decides which of the two is newer for each part.
import { snapshotTechnical, techKeepsBarsBlock } from '../engine/technical.js';

// The columns asked of TradingView, in the order they are packed into a row.
const COLS = ['close', 'MACD.macd|1W', 'MACD.signal|1W', 'MACD.macd|1M', 'MACD.signal|1M', 'RSI|1W', 'RSI|1M', 'change|1W', 'change|1M', 'average_volume_30d_calc'];

// A row's values as TradingView returned them, packed in COLS order (null for a missing or non-numeric value).
const packValues = (tv) => COLS.map(k => (tv && typeof tv[k] === 'number' && isFinite(tv[k])) ? tv[k] : null);
// ... and back into the object snapshotUpdate reads.
function unpackValues(c){
  const tv = {};
  COLS.forEach((k, i) => { if(Array.isArray(c) && typeof c[i] === 'number') tv[k] = c[i]; });
  return tv;
}

// What to save for one stock from its TradingView row: { valuation?, liquidity?, technical?, kept? }, or { reason } when nothing can be saved.
// `keepAgainst` is the saved technical block to protect: a completed-weeks block from the last 3 days is kept (only the price moves);
// pass null to skip that check (the merge below does it against the stock's own saved update).
function snapshotUpdate(s, row, today, sym, keepAgainst){
  const px = row && typeof row.close === 'number' && row.close > 0 ? row.close : null;
  if(px == null) return { reason: 'TradingView returned no price' };
  const out = { valuation: { currentPrice: px, asof: today, source: 'TradingView (' + sym + ')' } };
  if(typeof row['average_volume_30d_calc'] === 'number' && row['average_volume_30d_calc'] >= 0) out.liquidity = { avgVolume: Math.round(row['average_volume_30d_calc']), asof: today };
  const pv = s && s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
  if(pv == null){ out.note = 'no valuation reading, technical score not updated'; return out; }
  if(keepAgainst && techKeepsBarsBlock(keepAgainst, today)){ out.kept = true; return out; }
  const t = snapshotTechnical({ monthMacdLevel: row['MACD.macd|1M'], monthMacdSignal: row['MACD.signal|1M'], weekMacdLevel: row['MACD.macd|1W'], weekMacdSignal: row['MACD.signal|1W'],
    monthRsi: row['RSI|1M'], weekRsi: row['RSI|1W'], weekPctChange: row['change|1W'], monthPctChange: row['change|1M'] }, pv, today);
  if(!t) out.note = 'TradingView returned no MACD or RSI'; else out.technical = t;
  return out;
}

// The part of two saved readings that is newer. `at` (the exact time) decides when both have it, else the date; on the same date the
// snapshot wins over a reading with no time on it (those were all saved before the snapshot existed).
function newerValuation(real, snap, snapAt){
  if(!real || typeof real !== 'object' || typeof real.currentPrice !== 'number') return Object.assign({}, snap, { at: snapAt });
  if(typeof real.at === 'string' && snapAt) return real.at > snapAt ? real : Object.assign({}, snap, { at: snapAt });
  if(typeof real.asof === 'string' && typeof snap.asof === 'string' && real.asof > snap.asof) return real;
  return Object.assign({}, snap, { at: snapAt });
}
const newerByAsof = (real, snap) => (real && typeof real === 'object' && typeof real.asof === 'string' && real.asof > snap.asof ? real : snap);

// One stock's saved update (`real`, may be undefined) combined with its snapshot row ({ row, asof, at }, may be undefined).
// Everything in `real` that the snapshot does not cover (Global factors, notes, price history flags) is kept as it is.
function mergedDoc(s, real, snap){
  if(!snap) return real;
  const u = snapshotUpdate(s, unpackValues(snap.row.c), snap.asof, snap.row.y, null);
  if(u.reason) return real;
  const out = Object.assign({}, real || {});
  out.valuation = newerValuation(real && real.valuation, u.valuation, snap.at);
  if(u.liquidity) out.liquidity = newerByAsof(real && real.liquidity, u.liquidity);
  if(u.technical){
    const rt = real && real.technical;
    // A saved technical block wins when it is a completed-weeks score from the last 3 days, is dated later, or is dated the same day and
    // did not come from an earlier snapshot (an imported file or a bars refresh).
    const realWins = !!rt && typeof rt === 'object' && (techKeepsBarsBlock(rt, snap.asof) || (typeof rt.asof === 'string' && (rt.asof > snap.asof || (rt.asof === snap.asof && rt.src !== 'snapshot'))));
    out.technical = realWins ? rt : u.technical;
  }
  return out;
}

export { COLS, mergedDoc, packValues, snapshotUpdate };
