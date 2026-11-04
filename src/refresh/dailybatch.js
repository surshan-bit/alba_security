// Daily (1D) bars of the stocks that already have saved bars, from TradingView's batch call (50 stocks per call) instead of one call per stock (v1.356).
// The batch tool returns the current and the previous daily bar (open, high, low, close, volume) but no bar times, so a bar is placed by the Indian day it belongs to,
// the same way historyplan.js does it for the weekly and monthly bars. A stock whose newest saved bar is the current or the previous session can be brought up to
// date this way; anything else (a longer gap, prices adjusted by a split, an unclear match) returns null and the stock is fetched on its own.
const IST = 19800, DAY = 86400, OPEN_S = 33300;   // 09:15 Indian time: the time a daily bar opens
const SAME_REL = 1e-4;
const DAILY_BAR_COLUMNS = ['open', 'high', 'low', 'close', 'volume', 'open[1]', 'high[1]', 'low[1]', 'close[1]', 'volume[1]'];
const dayNo = t => Math.floor((t + IST) / DAY);
const weekday = d => (d + 3) % 7;   // day number 0 = 1970-01-01, a Thursday: Monday = 0 ... Sunday = 6
const isWeekend = d => weekday(d) >= 5;
// The last weekday on or before day number d, and the first weekday after it.
const lastWeekdayUpTo = d => { while(isWeekend(d)) d--; return d; };
const nextWeekday = d => { d++; while(isWeekend(d)) d++; return d; };

/**
 * The current and the previous daily bar out of a batch row: { cur, prev } with { o, h, l, c, v }, or null when a number is missing.
 * @returns {{ cur: any, prev: any } | null}
 */
function dailyBatchBars(row){
  if(!row) return null;
  const pick = s => ({ o: row['open' + s], h: row['high' + s], l: row['low' + s], c: row['close' + s], v: row['volume' + s] });
  const cur = pick(''), prev = pick('[1]');
  const ok = b => [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite);
  return ok(cur) && ok(prev) ? { cur, prev } : null;
}
const sameNum = (a, b) => Math.abs(a - b) <= SAME_REL * Math.abs(b) + 1e-9;
const rowOf = (t, b) => [t, b.o, b.h, b.l, b.c, b.v];

// True when every bar is a whole bar, in time order (the same checks as the weekly bars).
function wellFormed(out){
  let prevT = -Infinity;
  for(const r of out){
    if(!r.every(Number.isFinite) || r[0] <= prevT || r[2] < Math.max(r[1], r[4]) - SAME_REL || r[3] > Math.min(r[1], r[4]) + SAME_REL || r[5] < 0) return false;
    prevT = r[0];
  }
  return true;
}

/**
 * `stored` = the saved daily bars (oldest first, at least two), `bars` = dailyBatchBars of the stock, `nowS` = now in unix seconds. Returns the bars brought up to date,
 * or null when the stock must be fetched on its own.
 * @returns {any[][] | null}
 */
function alignDaily(stored, bars, nowS){
  if(!Array.isArray(stored) || stored.length < 2 || !bars) return null;
  const L = stored[stored.length - 1], head = stored.slice(0, -1);
  // The saved newest bar may have been still forming when it was saved: the same bar later can only have a higher high, a lower low and more volume, and the same open.
  const same = b => sameNum(b.o, L[1]) && b.h >= L[2] - SAME_REL && b.l <= L[3] + SAME_REL && b.v >= L[5] * 0.99;
  // When TradingView's "current" bar is the saved bar itself, its "previous" bar must be the one saved before it.
  const prevIsBefore = sameNum(bars.prev.o, stored[stored.length - 2][1]);
  const isPrev = same(bars.prev), isCur = same(bars.cur) && prevIsBefore;
  let out = null;
  if(isCur && !isPrev) out = head.concat([rowOf(L[0], bars.cur)]);   // no session since: the newest bar is still the saved one
  else if(isPrev && !isCur){   // the saved bar has finished; the new bar is the very next weekday's, which must also be the latest weekday up to today
    const next = nextWeekday(dayNo(L[0]));
    if(next === lastWeekdayUpTo(dayNo(nowS))) out = head.concat([rowOf(L[0], bars.prev), rowOf(next * DAY - IST + OPEN_S, bars.cur)]);
  }
  return out && wellFormed(out) ? out : null;
}

export { DAILY_BAR_COLUMNS, alignDaily, dailyBatchBars };
