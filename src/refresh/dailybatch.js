// Daily (1D) bars of the stocks that already have saved bars, from TradingView's batch call (50 stocks per call) instead of one call per stock (v1.356).
// The batch tool returns the current bar and the two before it (open, high, low, close, volume) but no bar times. The newest saved bar is found among them by its prices, and the bars
// after it are dated from a trading calendar: the real bar times of one liquid stock, read once per run (v1.365). No weekday or holiday rule is used, so a holiday or a special
// session (a Sunday Muhurat session) is placed correctly. A stock that is more than two sessions behind, whose saved bar is not found, or whose prices were adjusted returns
// null and is fetched on its own.
const IST = 19800, DAY = 86400;
const SAME_REL = 1e-4, COPY_CLOSE = 0.005;
const BAR_FIELDS = ['open', 'high', 'low', 'close', 'volume'];
const DAILY_BAR_COLUMNS = BAR_FIELDS.concat(BAR_FIELDS.map(f => f + '[1]'), BAR_FIELDS.map(f => f + '[2]'));
const dayNo = t => Math.floor((t + IST) / DAY);

/**
 * The newest bars out of a batch row, oldest first: the current bar, the one before it and, when TradingView has it, the one before that. Null when the first two are not whole.
 * @returns {{ o: number, h: number, l: number, c: number, v: number }[] | null}
 */
function dailyBatchBars(row){
  if(!row) return null;
  const pick = s => ({ o: row['open' + s], h: row['high' + s], l: row['low' + s], c: row['close' + s], v: row['volume' + s] });
  const ok = b => [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite);
  const cur = pick(''), prev = pick('[1]'), older = pick('[2]');
  if(!ok(cur) || !ok(prev)) return null;
  return ok(older) ? [older, prev, cur] : [prev, cur];
}
const sameNum = (a, b) => Math.abs(a - b) <= SAME_REL * Math.abs(b) + 1e-9;
const rowOf = (t, b) => [t, b.o, b.h, b.l, b.c, b.v];

// True when saved bar `a` has the open, high and low of `b` and about its close (the repeated bar of a coming day, see alignDaily).
const repeats = (a, b) => [1, 2, 3].every(i => sameNum(a[i], b[i])) && Math.abs(a[4] - b[4]) <= COPY_CLOSE * Math.abs(b[4]);   // the copy's close and volume may have moved a little since

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
 * `stored` = the saved daily bars (oldest first, at least two), `bars` = dailyBatchBars of the stock, `calendar` = the bar times of a liquid stock, oldest first (at least as many as `bars`).
 * Returns the bars brought up to date, or null when the stock must be fetched on its own.
 * @returns {any[][] | null}
 */
function alignDaily(stored, bars, calendar){
  if(!Array.isArray(stored) || stored.length < 2 || !bars || !Array.isArray(calendar) || calendar.length < bars.length) return null;
  // Before the open TradingView serves the coming day's bar as a copy of the last session's, and a run then saved it: a newest bar that repeats the one before it is that copy, so it is set aside.
  const copy = stored.length > 2 && repeats(stored[stored.length - 1], stored[stored.length - 2]);
  if(copy) stored = stored.slice(0, -1);
  const L = stored[stored.length - 1], head = stored.slice(0, -1), days = calendar.slice(-bars.length);
  // The saved newest bar may have been still forming when it was saved: the same bar later can only have a higher high, a lower low and more volume, and the same open.
  const same = b => sameNum(b.o, L[1]) && b.h >= L[2] - SAME_REL && b.l <= L[3] + SAME_REL && b.v >= L[5] * 0.99;
  // It is the bar of index i when its prices fit, the bar before it is the one saved before, and it is the same trading day in the calendar.
  const fits = i => same(bars[i]) && (i === 0 || sameNum(bars[i - 1].o, stored[stored.length - 2][1])) && dayNo(L[0]) === dayNo(days[i]);
  const found = bars.map((b, i) => i).filter(fits);
  if(found.length !== 1) return null;   // not found, or cannot tell which of two similar bars it is
  const i = found[0], fresh = bars.slice(i + 1).map((b, k) => rowOf(days[i + 1 + k], b));
  const out = head.concat([rowOf(L[0], bars[i])], fresh);
  return wellFormed(out) ? out : null;
}

export { DAILY_BAR_COLUMNS, alignDaily, dailyBatchBars };
