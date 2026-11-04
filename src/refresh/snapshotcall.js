// The calls behind Refresh all stocks' snapshot step: paced requests to TradingView, how a failed batch is judged, and saving a record with one retry.
import { sleep } from '../core/util.js';
import { tvCall, tvErrorText, tvIsFatal } from '../tv/connector.js';
import { skippedForFailure } from './snapshotrows.js';

const FETCH_GAP_MS = 300;          // TradingView answers "Too Many Requests" when called back to back: a request waits until this long after the previous one started
const ERROR_BACKOFF_MS = 1500;     // ... and longer after a failed call
const RETRY_PAUSE_MS = 1000;       // wait before asking again for the stocks an answer left out
const SAVE_RETRY_PAUSE_MS = 1500;  // wait before saving a record a second time
const MAX_FAILED_BATCHES = 3;      // failed calls in a row that stop the run

/**
 * Requests snapshot batches one after another, keeping the pace TradingView allows.
 * `fetch(batch)` answers { payload } or { error }; `again(symbols)` is the call for stocks an answer left out (it throws on failure).
 */
function snapshotFetcher(columns){
  const pace = { lastStart: 0, backoff: 0 };
  const call = (symbols) => tvCall('mcp-tv-get-symbol-data-batch', { symbols, columns });
  return {
    slowDown(){ pace.backoff = ERROR_BACKOFF_MS; },
    /** @returns {Promise<{ payload?: any, error?: any }>} */
    async fetch(batch){
      const wait = Math.max(FETCH_GAP_MS, pace.backoff) - (Date.now() - pace.lastStart);
      pace.backoff = 0;
      if(wait > 0) await sleep(wait);
      pace.lastStart = Date.now();
      try { return { payload: await call(batch.map(x => x.sym)) }; }
      catch(e){ return { error: e }; }
    },
    async again(symbols){
      await sleep(RETRY_PAUSE_MS);
      try { return await call(symbols); } finally { pace.lastStart = Date.now(); }
    },
  };
}

/**
 * Judges one batch's answer. Returns its payload, or null when the batch failed and its stocks were added to `run.skipped`.
 * Throws when the failure is fatal, or when this is the third failed batch in a row (`state.failed` counts them).
 */
function settleBatch(run, state, batch, res){
  if(!res.error){ state.failed = 0; return res.payload || {}; }
  if(tvIsFatal(res.error)) throw res.error;
  if(++state.failed >= MAX_FAILED_BATCHES) throw new Error(tvErrorText(res.error) + ' Three batches in a row failed, so the run stopped.');
  run.skipped.push(...skippedForFailure(batch, tvErrorText(res.error)));
  return null;
}

/** Saves a record, trying twice. Returns the last error, or null when it was saved. */
async function setWithRetry(db, path, doc){
  let err = null;
  for(let attempt = 0; attempt < 2; attempt++){
    try { await db.doc(path).set(doc); return null; } catch(e){ err = e; if(attempt === 0) await sleep(SAVE_RETRY_PAUSE_MS); }
  }
  return err;
}

export { setWithRetry, settleBatch, snapshotFetcher };
