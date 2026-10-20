// This week's and this month's move of a stock: its price against the last close before the week (Monday) or the month (the 1st) began,
// India time. Used for the W % chg and M % chg columns, from the saved weekly and monthly bars. No imports, so the page, the live ticker
// and the tests share it.
function periodStartSec(kind, now = Date.now()){
  const ist = new Date(now + 330 * 60000);
  const day = kind === 'W' ? ist.getUTCDate() - (ist.getUTCDay() + 6) % 7 : 1;   // the Monday of this week, or the 1st of this month
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), day) / 1000 - 330 * 60;
}
// bars = [[t, o, h, l, c, v], ...] oldest first. The last bar that opened before startSec is the reference; a bar of the period itself is ignored.
function periodRef(bars, startSec){
  let ref = null;
  if(Array.isArray(bars)) for(const b of bars){ const v = Array.isArray(b) ? Number(b[4]) : NaN; if(b[0] < startSec && isFinite(v) && v > 0) ref = v; }
  return ref;
}
// Percent move of `price` against that reference (two decimals), or null when either is missing.
function periodMove(price, bars, startSec){
  const ref = periodRef(bars, startSec);
  return ref == null || !(price > 0) ? null : Math.round((price / ref - 1) * 10000) / 100;
}

export { periodMove, periodRef, periodStartSec };
