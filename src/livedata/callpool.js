// A shared limit on how many Claude calls are in flight at once, across every stock of a batch, with a retry for a call the runtime rejects (v1.359).
// Why: Claude lets a page have only a few calls in flight at once and turns the rest away with "too many sample calls at once from this page - let some finish"
// (code rate_limited). A Fundamental refresh asks four things at once per stock, so several stocks at once went over it and those steps were lost.
// The limit starts at four (what one stock alone has always used without trouble), goes down by one for every rejected call (never below two) and comes back up
// after twenty good calls (never above five). Calls over the limit wait their turn; a rejected call is tried again after a wait, three times at most.
const POOL_START = 4, POOL_MAX = 5, POOL_MIN = 2;
const GROW_AFTER = 20;                   // good calls in a row before the limit goes up by one
const BACKOFF_MS = [3000, 6000, 10000];  // waits before the first, second and third retry
// Errors that would only repeat: a missing permission, a reply that was not data, a stop. A real usage limit is also code rate_limited, so it is told apart by its text.
const FINAL_CODES = new Set(['cancelled', 'not_granted', 'sampling_disabled', 'capability_disabled', 'not_declared', 'capability_removed', 'invalid_json', 'session_expired', 'prompt_too_large', 'invalid_request']);
const TRANSIENT_RE = /request failed|network|timeout|timed out|overloaded|unavailable|temporar|connection|try again/i;
const TOO_MANY_RE = /too many .*at once|let some finish/i;   // Claude's limit on calls in flight, not the usage limit

/**
 * True when a failed call is worth trying again.
 * @param {any} e
 * @returns {boolean}
 */
function isTransient(e){
  if(!e) return false;
  const text = String(e.message || '');
  if(e.code === 'rate_limited') return TOO_MANY_RE.test(text);
  return !FINAL_CODES.has(e.code) && TRANSIENT_RE.test(text);
}

/**
 * True when Claude turned a call away only because too many were in flight at once (it is not the usage limit).
 * @param {any} e
 * @returns {boolean}
 */
function isTooManyAtOnce(e){ return !!e && e.code === 'rate_limited' && TOO_MANY_RE.test(String(e.message || '')); }

/**
 * @param {{ start?: number, max?: number, min?: number, sleep?: (ms: number) => Promise<any> }} [opts]
 */
function createCallPool(opts = {}){
  const { start = POOL_START, max = POOL_MAX, min = POOL_MIN, sleep = ms => new Promise(r => setTimeout(r, ms)) } = opts;
  let limit = Math.min(start, max), inFlight = 0, good = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  const drain = () => { while(waiting.length && inFlight < limit){ inFlight++; /** @type {() => void} */ (waiting.shift())(); } };
  const take = () => new Promise(resolve => { if(inFlight < limit){ inFlight++; resolve(undefined); } else waiting.push(() => resolve(undefined)); });
  const free = () => { inFlight--; drain(); };
  const once = async (fn, signal) => {
    await take();
    try {
      if(signal && signal.aborted) throw { code: 'cancelled' };   // stopped while waiting for a turn
      return await fn();
    } finally { free(); }
  };
  return {
    /**
     * Runs `fn` (one Claude call) when a turn is free; retries a rejected call.
     * @param {() => Promise<any>} fn
     * @param {AbortSignal} [signal]
     */
    async run(fn, signal){
      for(let attempt = 0; ; attempt++){
        try {
          const r = await once(fn, signal);
          if(++good >= GROW_AFTER && limit < max){ limit++; good = 0; drain(); }
          return r;
        } catch(e){
          if(!isTransient(e)) throw e;
          good = 0; limit = Math.max(min, limit - 1);
          if(attempt >= BACKOFF_MS.length) throw e;
          await sleep(BACKOFF_MS[attempt]);
        }
      }
    },
    state: () => ({ limit, inFlight, waiting: waiting.length })
  };
}

export { createCallPool, isTooManyAtOnce };
