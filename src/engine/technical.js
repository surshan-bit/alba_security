// Technical Score engine: EMA, MACD, RSI and the composite. This is the ONE place the score's rules live: the bar-based
// refresh (computeTechnical, from TradingView bars) and the CSV import (import/tech-engine.js, from the readings in a
// TradingView export) both turn their readings into a block with techBlock(), so the zones, weights and wording cannot drift apart.

// ---- Technical score from price bars (added 2026-10-07) ----
// Same rules as Knowledge Base section 4 and the Part B prompt: MACD(12,26,9) level and signal and RSI(14) on
// weekly and monthly closes; EMAs are seeded with the first close, RSI uses Wilder smoothing seeded with a simple average.
const TECH_MIN_MACD_BARS = 35;   // 26 bars to seed the slow EMA plus 9 for the signal line
const TECH_MIN_RSI_BARS = 15;    // 14 changes
function techEma(x, n){ const k = 2 / (n + 1); const e = [x[0]]; for(let i = 1; i < x.length; i++) e.push(x[i] * k + e[i - 1] * (1 - k)); return e; }
function techMacd(c){
  if(!c || c.length < TECH_MIN_MACD_BARS) return null;
  const a = techEma(c, 12), b = techEma(c, 26), m = a.map((v, i) => v - b[i]), s = techEma(m, 9);
  return { level: m[m.length - 1], signal: s[s.length - 1] };
}
function techRsi(c, n = 14){
  if(!c || c.length < n + 1) return null;
  let ag = 0, al = 0;
  for(let i = 1; i <= n; i++){ const d = c[i] - c[i - 1]; if(d > 0) ag += d; else al -= d; }
  ag /= n; al /= n;
  for(let i = n + 1; i < c.length; i++){ const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  if(ag === 0 && al === 0) return null;   // flat series: RSI is undefined, not 100
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ---- The scoring rules, shared by both paths ----
function techMacdState(level, signal){ return level == null || signal == null ? null : (level > signal ? 'bull' : 'bear') + (level > 0 ? '_above' : '_below'); }
function techRsiState(r){ return r == null ? null : r >= 70 ? 'overbought' : r >= 55 ? 'strong' : r >= 45 ? 'neutral' : r >= 30 ? 'weak' : 'oversold'; }
function techValLabel(v){ return v == null ? null : v >= 8 ? 'attractively valued' : v >= 6 ? 'reasonably valued' : v >= 4 ? 'fully valued' : 'expensive / stretched valuation'; }
const TECH_MACD_MULT = { bull_above: 1, bear_above: 0.5, bull_below: 1 / 3, bear_below: 0 };
const TECH_RSI_PTS = { strong: 2.0, neutral: 1.2, overbought: 0.8, weak: 0.4, oversold: 0 };
function techComposite(st, valScore){
  let pts = 0, wt = 0;
  if(st.monthMacd){ pts += 2.5 * TECH_MACD_MULT[st.monthMacd]; wt += 2.5; }
  if(st.weekMacd){ pts += 1.5 * TECH_MACD_MULT[st.weekMacd]; wt += 1.5; }
  if(st.monthRsi){ pts += TECH_RSI_PTS[st.monthRsi]; wt += 2.0; }
  if(st.weekRsi){ pts += TECH_RSI_PTS[st.weekRsi]; wt += 2.0; }
  if(valScore != null){ pts += valScore / 10 * 2.0; wt += 2.0; }
  return wt ? Math.round(pts / wt * 10 * 100) / 100 : null;
}
// The components a reading set lacks, in a fixed order.
function techMissing(raw){
  const missing = [];
  if(techMacdState(raw.monthMacdLevel, raw.monthMacdSignal) == null) missing.push('monthly MACD');
  if(techMacdState(raw.weekMacdLevel, raw.weekMacdSignal) == null) missing.push('weekly MACD');
  if(raw.monthRsi == null) missing.push('monthly RSI');
  if(raw.weekRsi == null) missing.push('weekly RSI');
  return missing;
}
// Technical block from raw readings ({month|week}{MacdLevel,MacdSignal,Rsi,PctChange}) and the valuation pillar (0-10).
// `why` says why a missing component is missing. Returns null without any MACD or RSI reading.
function techBlock(readings, valScore, asof, why){
  const v = valScore == null ? null : valScore;
  const raw = { monthMacdLevel: null, monthMacdSignal: null, weekMacdLevel: null, weekMacdSignal: null, weekPctChange: null, monthPctChange: null, monthRsi: null, weekRsi: null };
  for(const k of Object.keys(raw)) if(readings[k] != null) raw[k] = readings[k];
  raw.valuationScore = v;
  const states = { monthMacd: techMacdState(raw.monthMacdLevel, raw.monthMacdSignal), weekMacd: techMacdState(raw.weekMacdLevel, raw.weekMacdSignal),
    monthRsi: techRsiState(raw.monthRsi), weekRsi: techRsiState(raw.weekRsi), valuation: techValLabel(v) };
  const missing = techMissing(raw);
  if(missing.length === 4) return null;
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const mt = s => (s.startsWith('bull') ? 'bullish' : 'bearish') + ', ' + (s.endsWith('above') ? 'above' : 'below') + ' zero';
  const parts = [], rs = [];
  if(states.monthMacd) parts.push('monthly MACD ' + mt(states.monthMacd));
  if(states.weekMacd) parts.push('weekly MACD ' + mt(states.weekMacd));
  if(raw.monthRsi != null) rs.push('monthly RSI ' + f1(raw.monthRsi) + ' (' + states.monthRsi + ')');
  if(raw.weekRsi != null) rs.push('weekly RSI ' + f1(raw.weekRsi) + ' (' + states.weekRsi + ')');
  let reason = parts.join(', ') + (parts.length ? '. ' : '') + rs.join(', ') + (rs.length ? '. ' : '');
  if(v != null) reason += 'Valuation pillar reading of ' + f1(v) + '/10 (' + states.valuation + ').';
  if(missing.length){
    const list = missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] : missing[0];
    reason += ' (' + list + ' not available: ' + why + '. Composite computed from available components only, rescaled to a 0–10 scale.)';
  }
  return { score: techComposite(states, v), reason: reason.trim(), states, raw, asof };
}

// ---- Completed bars (added 2026-10-14) ----
// The saved score uses completed bars only, like the back-test (analysis/technical-backtest): a weekly bar counts from the
// Friday close (15:30 IST) of its week, a monthly bar from 15:30 IST on the month's last weekday. Exchange holidays are ignored.
// Bars are [t, o, h, l, c, v] with t = bar open in unix seconds; only the last bar can still be forming.
const IST = 19800, DAY = 86400, CLOSE = 15.5 * 3600;
function techBarClosesAt(t, interval){
  const d = new Date((t + IST) * 1000);   // IST wall time read through the UTC fields
  if(interval === '1W'){
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7) / 1000;
    return monday + 4 * DAY + CLOSE - IST;
  }
  let last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / 1000;
  while([0, 6].includes(new Date(last * 1000).getUTCDay())) last -= DAY;
  return last + CLOSE - IST;
}
function techCompletedBars(bars, interval, nowSec){
  if(!bars || !bars.length) return bars || [];
  return nowSec >= techBarClosesAt(bars[bars.length - 1][0], interval) ? bars : bars.slice(0, -1);
}

// Technical block from [t,o,h,l,c,v] bars (weekly, monthly) and the stock's valuation pillar (0-10). Returns null without any usable component.
// The caller decides which bars count (see techCompletedBars); this uses every bar it is given.
function computeTechnical(weekBars, monthBars, pillarsVal, today){
  const wc = (weekBars || []).map(b => b[4]), mc = (monthBars || []).map(b => b[4]);
  const wm = techMacd(wc), mm = techMacd(mc);
  const pct = c => c.length >= 2 && c[c.length - 2] ? (c[c.length - 1] / c[c.length - 2] - 1) * 100 : null;
  return techBlock({ monthMacdLevel: mm && mm.level, monthMacdSignal: mm && mm.signal, weekMacdLevel: wm && wm.level, weekMacdSignal: wm && wm.signal,
    weekPctChange: pct(wc), monthPctChange: pct(mc), monthRsi: techRsi(mc), weekRsi: techRsi(wc) }, pillarsVal, today, 'too little price history');
}

export { TECH_MIN_MACD_BARS, TECH_MIN_RSI_BARS, computeTechnical, techBlock, techCompletedBars, techMissing };
