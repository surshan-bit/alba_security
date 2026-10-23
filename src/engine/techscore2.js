// Technical Score 2 (v1.203): a second technical score built from the weekly price bars, shown beside the existing Tech score, for every
// stock with at least 60 finished weeks. Fitted on 204 weeks of history for ~1,500 NSE stocks (every stock-week, no conditions) to
// predict a close of +5% or more two weeks later; tested on a different period from the one it was fitted on. It reads where the
// price sits (moving-average stack, distance from the 52-week high, RSI zone, on-balance volume, volume breakouts), the weekly MACD,
// and the last week's and last four weeks' move. The weights are fixed here; a re-fit is a new version of this file. Completed weekly bars only.
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { techCompleted, techEma, techRsi } from './technical.js';

const T2_MIN_BARS = 60;
const T2_WEIGHTS = [0.11034, 0.36898, 0.12924, 0.06497, 0.27126, 0.30203, 0.06286, -0.02101, -0.10541, 0.04323, -1.07844, 0.03593, 0.01748, -0.04041, 0.22604, -0.00871, 1.5953, -4.11067, 0.40297];
const T2_BIAS = -1.79728;
// The model's raw output at the 0, 10, 20 ... 100th percentile of all the fitting stock-weeks; the 0-10 score is the position between them.
const T2_CUTS = [-1.74763, -1.4641, -1.37366, -1.31351, -1.26524, -1.21671, -1.15953, -1.09435, -1.02559, -0.92692, 0.63518];

// A flat series has no RSI in the Technical Score engine (null); this model reads it as 100, as it always has.
const t2Rsi = (c) => { const r = techRsi(c); return r === null ? 100 : r; };
const t2Mean = (x, from, to) => { let s = 0; for(let i = from; i < to; i++) s += x[i]; return s / (to - from); };
function t2Scale(z){
  if(z <= T2_CUTS[0]) return 0;
  for(let q = 1; q < T2_CUTS.length; q++) if(z <= T2_CUTS[q]) return q - 1 + (z - T2_CUTS[q - 1]) / ((T2_CUTS[q] - T2_CUTS[q - 1]) || 1);
  return 10;
}
// bars: [t,o,h,l,c,v] weekly; today: IST date 'YYYY-MM-DD' (a week still in progress is left out), or undefined to use every bar.
// Returns { score (0-10), z, week } or null when there are too few bars.
function computeTech2(weekBars, today){
  const B = techCompleted(weekBars || [], 'week', today), n = B.length;
  if(n < T2_MIN_BARS) return null;
  const c = B.map(b => b[4]), h = B.map(b => b[2]), v = B.map(b => b[5]), i = n - 1;
  if(!(c[i] > 0) || !(c[i - 1] > 0)) return null;
  const a12 = techEma(c, 12), a26 = techEma(c, 26), m = a12.map((x, j) => x - a26[j]), sg = techEma(m, 9);
  const ret1 = c[i] / c[i - 1] - 1, bull = m[i] > sg[i];
  const week = new Date((B[i][0] + 19800) * 1000).toISOString().slice(0, 10);
  const s4 = t2Mean(c, i - 3, i + 1), s10 = t2Mean(c, i - 9, i + 1), s40 = t2Mean(c, i - 39, i + 1), s20 = t2Mean(c, i - 19, i + 1);
  const stack = c[i] > s4 && s4 > s10 && s10 > s40 ? 15 : (c[i] > s10 && s10 > s40 ? 10 : (c[i] > s40 ? 5 : 0));
  const r = t2Rsi(c), e30 = techEma(c, 30);
  let hh26 = 0, hh20 = 0, hi52 = 0, c26hi = 0;
  for(let j = i - 26; j < i; j++){ hh26 = Math.max(hh26, h[j]); c26hi = Math.max(c26hi, c[j]); }
  for(let j = i - 20; j < i; j++) hh20 = Math.max(hh20, h[j]);
  for(let j = i - 51; j <= i; j++) hi52 = Math.max(hi52, c[j]);
  const obv = [0]; for(let j = 1; j < n; j++) obv.push(obv[j - 1] + Math.sign(c[j] - c[j - 1]) * v[j]);
  let obvHi = -Infinity; for(let j = i - 26; j < i; j++) obvHi = Math.max(obvHi, obv[j]);
  const volRatio = v[i] / (t2Mean(v, i - 9, i + 1) || 1);
  let sd = 0; for(let j = i - 19; j <= i; j++) sd += (c[j] - s20) ** 2;
  const bw = 4 * Math.sqrt(sd / 20) / s20, upper = s20 * (1 + bw / 2);
  const f = [stack / 15, r < 30 ? 1 : 0, r >= 30 && r < 40 ? 1 : 0, r >= 50 && r < 65 ? 1 : 0, r >= 65 && r <= 75 ? 1 : 0, r > 75 ? 1 : 0,
    obv[i] >= obvHi && c[i] >= 0.95 * c26hi ? 1 : 0, c[i] > hh26 && volRatio >= 1.5 ? 1 : 0, c[i] > hh20 ? 1 : 0, c[i] > e30[i] ? 1 : 0,
    c[i] / hi52 - 1, Math.max(-1, Math.min(c[i] / c[i - 13] - 1, 1.5)), Math.min(volRatio, 4) / 4, c[i] >= 0.98 * upper ? 1 : 0,
    m[i] > 0 && sg[i] > 0 ? 1 : 0, bull ? 1 : 0, Math.max(0, Math.min(ret1, 0.3)), Math.max(-0.3, Math.min(ret1, 0)), Math.max(-0.5, Math.min(c[i] / c[i - 4] - 1, 0.6))];
  let z = T2_BIAS; f.forEach((x, j) => { z += T2_WEIGHTS[j] * x; });
  return { score: Math.round(t2Scale(z) * 10) / 10, z: Math.round(z * 10000) / 10000, week };
}

const CHUNK = 250;

// The records to save: barsOf(stock) gives its weekly bars (or nothing); stocks with too few bars have no row.
function buildTech2Chunks(list, barsOf, today){
  const rows = [];
  for(const s of list){
    const bars = barsOf(s); if(!bars || !bars.length) continue;
    const r = computeTech2(bars, today); if(!r) continue;
    const row = { k: sanitizeDocId(tickerSymbol(s)), s: r.score, z: r.z, w: r.week };
    rows.push(row);
  }
  const out = [];
  for(let i = 0; i < rows.length; i += CHUNK) out.push({ id: 'c' + String(out.length + 1).padStart(3, '0'), doc: { v: 1, asof: today, at: new Date().toISOString(), rows: rows.slice(i, i + CHUNK) } });
  return out;
}

export { buildTech2Chunks };
