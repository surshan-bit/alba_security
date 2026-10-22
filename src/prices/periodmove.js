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

// Last week's move: the close of last week's bar against the close before it, or null when last week's bar is missing (stale bars).
function lastWeekMove(bars, now = Date.now()){
  const s0 = periodStartSec('W', now), s1 = s0 - 7 * 86400;
  if(!Array.isArray(bars) || !bars.some(b => Array.isArray(b) && b[0] >= s1 && b[0] < s0)) return null;
  const end = periodRef(bars, s0), start = periodRef(bars, s1);
  return end == null || start == null ? null : Math.round((end / start - 1) * 10000) / 100;
}

// A move this large, while TradingView's own figure for the same period is less than half of it, means the saved bars are on another scale than today's
// price (a split or bonus since they were saved): TradingView's figure is used instead. Smaller disagreements stay as worked out, because TradingView
// reports its last candle for a stock that has not traded in the period, which is not the current period's move.
const SCALE_JUMP = 40;
function checkedMove(move, tv){
  if(move === null) return null;
  if(typeof tv === 'number' && isFinite(tv) && Math.abs(move) >= SCALE_JUMP && Math.abs(tv) < Math.abs(move) / 2) return Math.round(tv * 100) / 100;
  return move;
}

// The bar of the period still in progress is only as new as the last refresh that touched it (the month's bar is often weeks old), so the plotted bar
// and W % chg / M % chg would disagree. For drawing, that bar's close follows the current price and its high and low stretch to include it. A stock that
// has moved since its last bar but has no bar of this period gets one, only when its last bar is from the period just before (gapSec: 8 days for a week,
// 32 for a month): with older bars the whole jump would land in one invented bar, so they are left as they are. A price equal to the last close leaves the
// bars alone (no trade, no bar). Returns a new array; the saved bars are never changed. Bars are [t, o, h, l, c, v]; a bar opens 09:15 India time, 33300 s
// after the period start.
function followPrice(bars, price, startSec, gapSec){
  if(!Array.isArray(bars) || !bars.length || !(price > 0)) return bars;
  const last = bars[bars.length - 1];
  if(!Array.isArray(last) || !(last[4] > 0)) return bars;
  const out = bars.slice();
  if(last[0] >= startSec){ out[out.length - 1] = [last[0], last[1], Math.max(last[2], price), Math.min(last[3], price), price, last[5]]; return out; }
  if(price === last[4] || last[0] < startSec - gapSec) return bars;
  out.push([startSec + 33300, last[4], Math.max(last[4], price), Math.min(last[4], price), price, 0]);
  return out;
}

export { checkedMove, followPrice, lastWeekMove, periodMove, periodStartSec };
