// The two-week reading for the Buy / Sell ideas (v1.289): how likely is this stock to beat the typical stock over the next two weeks, and so to be higher?
// A small gradient-boosted tree model (nextweek-model.js) trained on about 294,000 stock-weeks of weekly prices (2021 to 2026, liquid stocks) against the
// return two weeks later, and checked week by week on data it had not seen: its top tenth was higher two weeks later 51.9% of the time (all stocks 48.1%).
// It reads only the stock's own completed weekly bars, so a stock can be scored on its own. The figures here must match the Python that trained it
// (tests/nextweek-fixture.json holds five stocks scored by that code); change one and the other, never one alone.
import { techCompleted } from '../engine/technical.js';
import { NEXTWEEK_MODEL } from './nextweek-model.js';
/** @type {{ features: string[], base: number, trees: any[][][], seg: Record<string, { up: number[], beat: number[], base: number }> }} */
const M = /** @type {any} */ (NEXTWEEK_MODEL);

// Fewest weekly bars a stock needs (the model's 52-week figures need 53), the length under which a stock counts as a recent listing (a short history), and the
// weekly traded value of 1 crore rupees that the model was trained on. v1.292: the minimum is 53, down from 80, because in the five-year tests the model still ranked
// recent listings (53 to 79 weeks of prices) usefully. Their own numbers are in SHORT_HISTORY: stocks ranked in the top decile were higher two weeks later 52.4% of the
// time (719 stock-weeks), against 45.1% for all recent listings, because recent listings fall more often than older stocks (48.2%).
const MIN_BARS = 53, SHORT_WEEKS = 80, MIN_TURN = 1e7;
const SHORT_HISTORY = { up: 52.4, base: 45.1, n: 719 };

// Exponentially weighted mean the way pandas computes it with adjust=true (every value from the start counts, newest most).
function ewm(x, span){
  const a = 2 / (span + 1), out = [];
  let num = 0, den = 0;
  for(const v of x){ num = v + (1 - a) * num; den = 1 + (1 - a) * den; out.push(num / den); }
  return out;
}
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / (x.length - 1)); };
const last = (x, n) => x.slice(x.length - n);

// The model's 17 inputs (in the order of M.features) and the weekly traded value, from completed weekly bars [t, o, h, l, c, v]; null with too little history or a bad price.
function weekFeatures(bars){
  if(!Array.isArray(bars) || bars.length < MIN_BARS) return null;
  const b = bars.slice(-300), n = b.length, c = b.map(x => x[4]), h = b.map(x => x[2]), l = b.map(x => x[3]), v = b.map(x => x[5] || 0);
  if(c.some(x => !(x > 0)) || h.slice(-52).some(x => !(x > 0)) || l.slice(-52).some(x => !(x > 0))) return null;
  const cc = c[n - 1], lr = [];
  for(let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const f = {};
  for(const k of [1, 2, 4, 8, 13, 26, 52]) f['r' + k] = Math.log(cc / c[n - 1 - k]);
  f.vol8 = sd(last(lr, 8)); f.vol26 = sd(last(lr, 26));
  f.dhi52 = cc / Math.max(...last(h, 52)) - 1; f.dlo52 = cc / Math.min(...last(l, 52)) - 1;
  f.rngpos = h[n - 1] === l[n - 1] ? null : (cc - l[n - 1]) / (h[n - 1] - l[n - 1]);
  const d = []; for(let i = 1; i < n; i++) d.push(c[i] - c[i - 1]);
  const up = mean(last(d, 14).map(x => Math.max(x, 0))), dn = mean(last(d, 14).map(x => Math.max(-x, 0)));
  f.rsi = dn === 0 ? null : 100 - 100 / (1 + up / dn);
  const e26 = ewm(c, 26), e12 = ewm(c, 12), macd = e12.map((x, i) => x - e26[i]), sig = ewm(macd, 9);
  f.macdh = (macd[n - 1] - sig[n - 1]) / cc;
  f.volr = Math.log((mean(last(v, 4)) + 1) / (mean(last(v, 26)) + 1));
  f.sma10d = cc / mean(last(c, 10)) - 1; f.sma40d = cc / mean(last(c, 40)) - 1;
  const out = M.features.map(k => f[k]);
  if(out.some(x => typeof x !== 'number' || !isFinite(x))) return null;
  return { x: out, byName: f, turn: mean(last(c.map((x, i) => x * v[i]), 8)) };
}

// The model's probability of beating the median stock next week, from the 17 inputs.
function modelProb(x){
  let s = M.base;
  for(const t of M.trees){
    let i = 0;
    for(;;){
      const nd = t[i];
      if(nd[5]){ s += nd[4]; break; }
      i = x[nd[0]] <= nd[1] ? nd[2] : nd[3];
    }
  }
  return 1 / (1 + Math.exp(-s));
}


// The reading for one stock: { p (the model's raw score), partial (the week in progress was used), turn, thin, facts } or null when the stock cannot be scored (fewer than 53 weekly bars); `short` is true under 80 weeks.
// `thin` is true below the weekly traded value the model was trained on. The raw score moves with the whole market (every stock scores higher after a calm
// rally), so what counts is where a stock ranks among the others: rankReads adds that.
function nextWeekRead(weekBars, today){
  const bars = Array.isArray(weekBars) ? weekBars : [];
  // The reading is as of today (v1.290): the week in progress is used as this week's bar (partial: true) on any weekday, so the latest prices count; once the week
  // is finished (from Saturday) it counts as it is. The model was trained on whole weeks, so early in the week the reading rests on fewer days of this week's move.
  const done = techCompleted(bars, 'week', today);
  const partial = done.length < bars.length, use = partial ? bars : done;
  const w = weekFeatures(use);
  if(!w) return null;
  const p = modelProb(w.x), f = w.byName;
  return { p, partial, weeks: use.length, short: use.length < SHORT_WEEKS, turn: w.turn, thin: w.turn < MIN_TURN,
    facts: { week: f.r1 * 100, month: f.r4 * 100, half: f.r26 * 100, fromHigh: f.dhi52 * 100, swing: f.vol8 * 100 } };
}

// Adds each reading's rank among the readings of the same trend (the stocks of one strategy today, split into 'up', 'early', 'down' and 'mixed'; `trends` is one entry per
// reading): pct (0 lowest to 100 highest), topPct (it is in the top N%), and what happened in the five-year tests to stocks that ranked in the same 5% band
// within their trend group each week: how often they were higher two weeks later (up) and how often they beat the median stock (beat), with `base`, how often
// any stock of that trend was higher. The 'early' group (weekly up, monthly not) was not split out in those tests, so it is ranked but its up, beat and base are null.
// A reading with no trend, or a down or mixed one (in neither list), gets no rank. Returns new objects in the same order; a null stays null.
function rankReads(reads, trends){
  const groups = {};
  reads.forEach((r, i) => { const t = trends && trends[i]; if(r && (t === 'up' || t === 'early')) (groups[t] = groups[t] || []).push(r.p); });
  Object.keys(groups).forEach(t => groups[t].sort((a, b) => a - b));
  return reads.map((r, i) => {
    if(!r) return null;
    const t = trends && trends[i], ps = t && groups[t];
    if(!ps) return { ...r, trend: t || null };
    let lo = 0; while(lo < ps.length && ps[lo] < r.p) lo++;
    const pct = ps.length > 1 ? 100 * lo / (ps.length - 1) : 50, bin = Math.min(19, Math.floor(pct / 5)), seg = M.seg[t];
    return { ...r, trend: t, pct, topPct: Math.max(1, Math.round(100 - pct)), up: seg ? Math.round(seg.up[bin] * 1000) / 10 : null, beat: seg ? Math.round(seg.beat[bin] * 1000) / 10 : null, base: seg ? seg.base : null };
  });
}

export { SHORT_HISTORY, nextWeekRead, rankReads };
