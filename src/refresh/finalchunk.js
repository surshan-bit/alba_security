// A snapshot chunk saved after the market closed does not change until the next session opens, so Refresh all stocks does not ask TradingView for it again (v1.357).
// The market is the NSE/BSE cash session: Monday to Friday, 09:15 to 15:30 Indian time. A market holiday is not known here, so the next weekday counts as a session
// day and a chunk is then asked for as usual: the rule only ever skips less, never more, than it could.
const IST_MS = 19800000, DAY_MS = 86400000;
const OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30;   // minutes after midnight, Indian time
const dayNo = ms => Math.floor((ms + IST_MS) / DAY_MS);
const isWeekend = d => (d + 3) % 7 >= 5;   // day number 0 = 1970-01-01, a Thursday
const atMs = (d, min) => d * DAY_MS - IST_MS + min * 60000;   // the moment of `min` Indian minutes on day number d

/**
 * True when a record saved at `savedMs` already holds the final prices of the latest finished session and no session has begun since (`nowMs` is now).
 * @param {number} savedMs
 * @param {number} nowMs
 * @returns {boolean}
 */
function savedAfterClose(savedMs, nowMs){
  if(!Number.isFinite(savedMs) || !Number.isFinite(nowMs) || savedMs > nowMs) return false;
  let d = dayNo(nowMs);
  while(isWeekend(d) || atMs(d, CLOSE_MIN) > nowMs) d--;   // the latest weekday whose close has passed
  let next = d + 1;
  while(isWeekend(next)) next++;
  return savedMs >= atMs(d, CLOSE_MIN) && nowMs < atMs(next, OPEN_MIN);
}

/**
 * True when a saved snapshot chunk can stand for a batch without asking TradingView: it was saved after the close (see above), it holds a priced row for exactly the
 * stocks of the batch (`keys`), and none of its rows is an older figure kept for a stock TradingView had not answered for.
 * @param {any} chunk the saved liveSnapshot record, or undefined
 * @param {string[]} keys the stock keys of the batch
 * @param {number} nowMs
 * @returns {boolean}
 */
function chunkIsFinal(chunk, keys, nowMs){
  if(!chunk || !Array.isArray(chunk.rows) || chunk.rows.length !== keys.length || !savedAfterClose(Date.parse(chunk.at), nowMs)) return false;
  const have = new Set(chunk.rows.filter(r => r && r.d === undefined && Array.isArray(r.c)).map(r => r.k));
  return have.size === keys.length && keys.every(k => have.has(k));
}

export { chunkIsFinal };
