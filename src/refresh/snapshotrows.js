// What one batch of TradingView snapshot answers turns into: the rows saved in liveSnapshot, the stocks skipped and why, and the weekly / monthly bars
// the same call carried. Pure apart from filling the maps it is given: no network, no page.
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { packValues, snapshotUpdate } from '../overlays/livesnapshot.js';
import { alignBars, batchBars } from './historyplan.js';

/** Whether TradingView answered with a usable closing price for the stock `x` = { s, sym }. */
function isPriced(data, x){ return !!data[x.sym] && typeof data[x.sym].close === 'number' && data[x.sym].close > 0; }

const skipEntry = (s, reason) => ({ sym: tickerSymbol(s), name: s.name, reason });

/** Every stock of a failed batch, skipped with the reason TradingView gave. */
function skippedForFailure(batch, reason){ return batch.map(({ s }) => skipEntry(s, reason)); }

/**
 * The rows to save for a batch. A stock with no usable answer keeps its earlier row when one is saved (`prevRows`, keyed by doc id), else it is skipped.
 * @returns {{ rows: any[], skipped: any[], carried: number, scored: number, kept: number }}
 */
function snapshotRows(batch, data, prevRows, today){
  /** @type {{ rows: any[], skipped: any[], carried: number, scored: number, kept: number }} */
  const out = { rows: [], skipped: [], carried: 0, scored: 0, kept: 0 };
  for(const { s, sym } of batch){
    const k = sanitizeDocId(tickerSymbol(s)), u = snapshotUpdate(s, data[sym], today, sym, s.technical);
    if(!u.reason){
      out.rows.push({ k, y: sym, c: packValues(data[sym]) });
      if(u.technical) out.scored++;
      if(u.kept) out.kept++;
      continue;
    }
    const prev = prevRows.get(k);
    if(!prev){ out.skipped.push(skipEntry(s, u.reason + ' (' + sym + ')')); continue; }
    out.rows.push({ k, y: prev.y, c: prev.c, d: prev.d, t: prev.t });
    out.carried++;
    out.skipped.push(skipEntry(s, u.reason + ' (' + sym + '): kept its figures from ' + prev.d));
  }
  return out;
}

/** Why a stock's bars could not be placed from the snapshot answer: no answer at all, a needed bar type missing, or bars that do not line up. */
function leftReason(row, job, bw, bm){
  if(!row) return 'noAnswer';
  return (job.needW && !bw) || (job.needM && !bm) ? 'missing' : 'unclear';
}

/**
 * The bars of the stocks that asked for them in this snapshot call. Stocks whose bars could be placed with certainty go into `ctx.ready`; for the rest
 * the reason is counted in `batchLeft` (they are fetched one by one later).
 */
function collectBatchBars(batch, data, ctx, batchLeft){
  for(const { s, sym } of batch){
    const j = ctx.jobs.get(s);
    if(!j) continue;
    const row = data[sym], bw = j.needW ? batchBars(row, 'W') : null, bm = j.needM ? batchBars(row, 'M') : null;
    const W = j.needW ? alignBars(j.h['1W'], bw, 'W', ctx.nowS) : j.h['1W'];
    const M = j.needM ? alignBars(j.h['1M'], bm, 'M', ctx.nowS) : j.h['1M'];
    if(W && M){ ctx.ready.set(s, { s, W, M, w: j.needW, m: j.needM }); continue; }
    const why = leftReason(row, j, bw, bm);
    batchLeft[why] = (batchLeft[why] || 0) + 1;
  }
}

export { collectBatchBars, isPriced, skippedForFailure, snapshotRows };
