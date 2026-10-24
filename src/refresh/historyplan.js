// Which stocks need price bars when "Refresh all stocks" runs its history stages (v1.200). Pure, so it can be tested on its own.
//   none    = stocks with no saved weekly bars: their full history (about 5 years, up to today) is downloaded.
//   stale   = stocks with saved bars where a weekly or monthly bar has finished since the newest saved one: only the new bars are downloaded.
//   current = everything else: nothing to do (the bar in progress is not used by the completed-weeks score, so it is not chased every day).
// Bar times are unix seconds (the bar's open). Weeks start on Monday and months on the 1st, in Indian time.
const IST = 19800, DAY = 86400, TOLERANCE = 12 * 3600;   // a bar may open a few hours before midnight Indian time

// Midnight (Indian time) at the start of the Monday of the week containing `nowS`, as unix seconds.
function weekStartS(nowS){
  const dayStart = Math.floor((nowS + IST) / DAY) * DAY - IST;
  const dow = (new Date((nowS + IST) * 1000).getUTCDay() + 6) % 7;   // Monday = 0
  return dayStart - dow * DAY;
}
// Midnight (Indian time) at the start of the month containing `nowS`.
function monthStartS(nowS){
  const d = new Date((nowS + IST) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - IST;
}
const lastBar = rows => (Array.isArray(rows) && rows.length ? rows[rows.length - 1][0] : null);

// `have` = { '1W': bars, '1M': bars } for one stock, or null / empty when nothing is saved.
function barsNeeded(have, nowS){
  const w = have && lastBar(have['1W']);
  if(w == null) return 'none';
  const m = lastBar(have['1M']);
  if(m == null || w < weekStartS(nowS) - TOLERANCE || m < monthStartS(nowS) - TOLERANCE) return 'stale';
  return 'current';
}
function planHistory(list, haveOf, nowS){
  /** @type {{ none: any[], stale: any[], current: any[], [k: string]: any[] }} */
  const plan = { none: [], stale: [], current: [] };
  for(const s of list) plan[barsNeeded(haveOf(s), nowS)].push(s);
  return plan;
}

// ---- Bars from the batch call (50 stocks per call) instead of one call per stock ----
// The batch tool returns the current and the previous weekly and monthly bar (open, high, low, close, volume) but no bar times, so a bar is placed by
// the week (Monday to Sunday) or month it belongs to. A stock whose newest saved bar is the current or the previous week / month can be brought up to date
// this way; anything else (a longer gap, prices adjusted by a split, an unclear match) returns null and the stock is fetched on its own.
const weekBucket = t => Math.floor((t + IST - 4 * DAY) / (7 * DAY));
const monthBucket = t => { const d = new Date((t + IST) * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const OPEN_S = 33300;   // 09:15 Indian time: a bar opens with the first session of its week or month (a holiday moves it by a day, fixed at the next full download)
const BAR_COLS = { W: ['open|1W', 'high|1W', 'low|1W', 'close|1W', 'volume|1W', 'open[1]|1W', 'high[1]|1W', 'low[1]|1W', 'close[1]|1W', 'volume[1]|1W'],
  M: ['open|1M', 'high|1M', 'low|1M', 'close|1M', 'volume|1M', 'open[1]|1M', 'high[1]|1M', 'low[1]|1M', 'close[1]|1M', 'volume[1]|1M'] };
const BAR_COLUMNS = BAR_COLS.W.concat(BAR_COLS.M);
// The two bars of one kind ('W' or 'M') out of a batch row: { cur, prev }, or null when a number is missing.
function batchBars(row, kind){
  if(!row) return null;
  const c = BAR_COLS[kind], pick = i => ({ o: row[c[i]], h: row[c[i + 1]], l: row[c[i + 2]], c: row[c[i + 3]], v: row[c[i + 4]] });
  const cur = pick(0), prev = pick(5);
  const ok = b => [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite);
  return ok(cur) && ok(prev) ? { cur, prev } : null;
}
const sameNum = (a, b) => Math.abs(a - b) <= 1e-4 * Math.abs(b) + 1e-9;
// `stored` = the saved bars of one kind (oldest first); returns the bars brought up to date, or null when this stock must be fetched on its own.
function alignBars(stored, bars, kind, nowS){
  if(!Array.isArray(stored) || !stored.length || !bars) return null;
  const bucket = kind === 'W' ? weekBucket : monthBucket, L = stored[stored.length - 1];
  const gap = bucket(nowS) - bucket(L[0]);
  const row = (t, b) => [t, b.o, b.h, b.l, b.c, b.v];
  const head = stored.slice(0, -1);
  // The saved newest bar was still forming when it was saved, so the same bar now can only have a higher high, a lower low and more volume, and the same open.
  const same = b => sameNum(b.o, L[1]) && b.h >= L[2] - 1e-4 && b.l <= L[3] + 1e-4 && b.v >= L[5] * 0.99;
  // When TradingView's "current" bar is the saved bar itself, its "previous" bar must be the one saved before it.
  const prevIsBefore = stored.length < 2 || sameNum(bars.prev.o, stored[stored.length - 2][1]);
  let out = null;
  if(gap === 0){ if(same(bars.cur) && prevIsBefore) out = head.concat([row(L[0], bars.cur)]); }
  else if(gap === 1){
    const isPrev = same(bars.prev), isCur = same(bars.cur) && prevIsBefore;
    if(isPrev && !isCur) out = head.concat([row(L[0], bars.prev), row((kind === 'W' ? weekStartS(nowS) : monthStartS(nowS)) + OPEN_S, bars.cur)]);   // the saved bar has finished and a new one has begun
    else if(isCur && !isPrev) out = head.concat([row(L[0], bars.cur)]);   // the new week or month has no bar yet: the newest bar is still the saved one
  }
  if(!out) return null;
  let prevT = -Infinity;
  for(const r of out){
    if(!r.every(Number.isFinite) || r[0] <= prevT || r[2] < Math.max(r[1], r[4]) - 1e-4 || r[3] > Math.min(r[1], r[4]) + 1e-4 || r[5] < 0) return null;
    prevT = r[0];
  }
  return out;
}

export { planHistory, weekStartS, monthStartS, weekBucket, monthBucket, alignBars, batchBars, BAR_COLUMNS, TOLERANCE };
