// Technical Score 2 (v1.202): a second technical score built from the weekly price bars, shown beside the existing Tech score.
// Fitted on 204 weeks of history for ~1,500 NSE stocks, on the stock-weeks that meet the Positive MoS technical rules (weekly MACD
// bullish, week up at least 1%, average volume at least 20,000), to predict a close of +5% or more two weeks later. It is only rated
// for stocks that meet those conditions: outside them it was tested and is not reliable, so such a stock gets no score (null).
// The weights are fixed here; a re-fit is a new version of this file. Features use completed weekly bars only.
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { techCompleted } from './technical.js';

const T2_MIN_BARS = 60;
const T2_WEIGHTS = [-0.07566, 0.35818, -0.0245, 0.04407, 0.03773, 0.04664, -0.00315, -0.12921, -0.06618, 0.14473, 0.44532, 0.08532, -0.04314, 0.15477, 1.65387];
const T2_BIAS = -1.31226;
// The model's raw output at the 0, 10, 20 ... 100th percentile of the fitting stock-weeks; the 0-10 score is the position between them.
const T2_CUTS = [-1.58696, -1.334, -1.2843, -1.23748, -1.19409, -1.14942, -1.10286, -1.05074, -0.98584, -0.88189, -0.141];

function t2Ema(x, n){ const k = 2 / (n + 1), e = [x[0]]; for(let i = 1; i < x.length; i++) e.push(x[i] * k + e[i - 1] * (1 - k)); return e; }
function t2Rsi(c, n = 14){
  let ag = 0, al = 0;
  for(let i = 1; i <= n; i++){ const d = c[i] - c[i - 1]; if(d > 0) ag += d; else al -= d; }
  ag /= n; al /= n;
  for(let i = n + 1; i < c.length; i++){ const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
const t2Mean = (x, from, to) => { let s = 0; for(let i = from; i < to; i++) s += x[i]; return s / (to - from); };
function t2Scale(z){
  if(z <= T2_CUTS[0]) return 0;
  for(let q = 1; q < T2_CUTS.length; q++) if(z <= T2_CUTS[q]) return q - 1 + (z - T2_CUTS[q - 1]) / ((T2_CUTS[q] - T2_CUTS[q - 1]) || 1);
  return 10;
}
// bars: [t,o,h,l,c,v] weekly; today: IST date 'YYYY-MM-DD' (a week still in progress is left out), or undefined to use every bar.
// Returns { rated, score, z, week, why } or null when there are too few bars. score is 0-10 when rated, else null.
function computeTech2(weekBars, today){
  const B = techCompleted(weekBars || [], 'week', today), n = B.length;
  if(n < T2_MIN_BARS) return null;
  const c = B.map(b => b[4]), h = B.map(b => b[2]), v = B.map(b => b[5]), i = n - 1;
  if(!(c[i] > 0) || !(c[i - 1] > 0)) return null;
  const a12 = t2Ema(c, 12), a26 = t2Ema(c, 26), m = a12.map((x, j) => x - a26[j]), sg = t2Ema(m, 9);
  const ret1 = c[i] / c[i - 1] - 1, bull = m[i] > sg[i], dvol = t2Mean(v, i - 9, i + 1) / 5;
  const week = new Date((B[i][0] + 19800) * 1000).toISOString().slice(0, 10);
  if(!bull) return { rated: false, score: null, z: null, week, why: 'weekly MACD is not bullish' };
  if(ret1 < 0.01) return { rated: false, score: null, z: null, week, why: 'the week is up less than 1 %' };
  if(!(dvol >= 20000)) return { rated: false, score: null, z: null, week, why: 'average volume is under 20,000' };
  const s4 = t2Mean(c, i - 3, i + 1), s10 = t2Mean(c, i - 9, i + 1), s40 = t2Mean(c, i - 39, i + 1), s20 = t2Mean(c, i - 19, i + 1);
  const stack = c[i] > s4 && s4 > s10 && s10 > s40 ? 15 : (c[i] > s10 && s10 > s40 ? 10 : (c[i] > s40 ? 5 : 0));
  const r = t2Rsi(c), e30 = t2Ema(c, 30);
  let hh26 = 0, hh20 = 0, hi52 = 0, c26hi = 0;
  for(let j = i - 26; j < i; j++){ hh26 = Math.max(hh26, h[j]); c26hi = Math.max(c26hi, c[j]); }
  for(let j = i - 20; j < i; j++) hh20 = Math.max(hh20, h[j]);
  for(let j = i - 51; j <= i; j++) hi52 = Math.max(hi52, c[j]);
  const obv = [0]; for(let j = 1; j < n; j++) obv.push(obv[j - 1] + Math.sign(c[j] - c[j - 1]) * v[j]);
  let obvHi = -Infinity; for(let j = i - 26; j < i; j++) obvHi = Math.max(obvHi, obv[j]);
  const volRatio = v[i] / (t2Mean(v, i - 9, i + 1) || 1);
  let sd = 0; for(let j = i - 19; j <= i; j++) sd += (c[j] - s20) ** 2;
  const bw = 4 * Math.sqrt(sd / 20) / s20, upper = s20 * (1 + bw / 2);
  const f = [stack / 15, r < 30 ? 1 : 0, r >= 50 && r < 65 ? 1 : 0, r >= 65 && r <= 75 ? 1 : 0, r > 75 ? 1 : 0,
    obv[i] >= obvHi && c[i] >= 0.95 * c26hi ? 1 : 0, c[i] > hh26 && volRatio >= 1.5 ? 1 : 0, c[i] > hh20 ? 1 : 0, c[i] > e30[i] ? 1 : 0,
    c[i] / hi52 - 1, Math.max(-1, Math.min(i >= 13 ? c[i] / c[i - 13] - 1 : 0, 1.5)), Math.min(volRatio, 4) / 4, c[i] >= 0.98 * upper ? 1 : 0,
    m[i] > 0 && sg[i] > 0 ? 1 : 0, Math.max(0.01, Math.min(ret1, 0.3))];
  let z = T2_BIAS; f.forEach((x, j) => { z += T2_WEIGHTS[j] * x; });
  return { rated: true, score: Math.round(t2Scale(z) * 10) / 10, z: Math.round(z * 10000) / 10000, week, why: null };
}

const CHUNK = 250;

// The records to save: barsOf(stock) gives its weekly bars (or nothing); stocks with too few bars have no row.
function buildTech2Chunks(list, barsOf, today){
  const rows = [];
  for(const s of list){
    const bars = barsOf(s); if(!bars || !bars.length) continue;
    const r = computeTech2(bars, today); if(!r) continue;
    const row = { k: sanitizeDocId(tickerSymbol(s)), s: r.score, z: r.z, w: r.week };
    if(!r.rated) row.x = r.why;
    rows.push(row);
  }
  const out = [];
  for(let i = 0; i < rows.length; i += CHUNK) out.push({ id: 'c' + String(out.length + 1).padStart(3, '0'), doc: { v: 1, asof: today, at: new Date().toISOString(), rows: rows.slice(i, i + CHUNK) } });
  return out;
}

export { buildTech2Chunks };
