// Technical Score engine: EMA, MACD, RSI and the composite.

// ---- Technical score from price bars (added 2026-10-07) ----
// Same rules as Knowledge Base section 4 and the Part B prompt: MACD(12,26,9) level and signal and RSI(14) on
// weekly and monthly closes; EMAs are seeded with the first close, RSI uses Wilder smoothing seeded with a simple average.
function techEma(x, n){ const k = 2 / (n + 1); const e = [x[0]]; for(let i = 1; i < x.length; i++) e.push(x[i] * k + e[i - 1] * (1 - k)); return e; }
function techMacd(c){
  if(!c || c.length < 35) return null;   // 26 bars to seed the slow EMA plus 9 for the signal line
  const a = techEma(c, 12), b = techEma(c, 26), m = a.map((v, i) => v - b[i]), s = techEma(m, 9);
  return { level: m[m.length - 1], signal: s[s.length - 1] };
}
function techRsi(c, n = 14){
  if(!c || c.length < n + 1) return null;
  let ag = 0, al = 0;
  for(let i = 1; i <= n; i++){ const d = c[i] - c[i - 1]; if(d > 0) ag += d; else al -= d; }
  ag /= n; al /= n;
  for(let i = n + 1; i < c.length; i++){ const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function techMacdState(m){ return !m ? null : (m.level > m.signal ? 'bull' : 'bear') + (m.level > 0 ? '_above' : '_below'); }
function techRsiState(r){ return r == null ? null : r >= 70 ? 'overbought' : r >= 55 ? 'strong' : r >= 45 ? 'neutral' : r >= 30 ? 'weak' : 'oversold'; }
function techValLabel(v){ return v == null ? null : v >= 8 ? 'attractively valued' : v >= 6 ? 'reasonably valued' : v >= 4 ? 'fully valued' : 'expensive / stretched valuation'; }
var TECH_MACD_MULT = { bull_above: 1, bear_above: 0.5, bull_below: 1 / 3, bear_below: 0 };
var TECH_RSI_PTS = { strong: 2.0, neutral: 1.2, overbought: 0.8, weak: 0.4, oversold: 0 };
function techComposite(st, valScore){
  let pts = 0, wt = 0;
  if(st.monthMacd){ pts += 2.5 * TECH_MACD_MULT[st.monthMacd]; wt += 2.5; }
  if(st.weekMacd){ pts += 1.5 * TECH_MACD_MULT[st.weekMacd]; wt += 1.5; }
  if(st.monthRsi){ pts += TECH_RSI_PTS[st.monthRsi]; wt += 2.0; }
  if(st.weekRsi){ pts += TECH_RSI_PTS[st.weekRsi]; wt += 2.0; }
  if(valScore != null){ pts += valScore / 10 * 2.0; wt += 2.0; }
  return wt ? Math.round(pts / wt * 10 * 100) / 100 : null;
}
// Technical block from [t,o,h,l,c,v] bars (weekly, monthly) and the stock's valuation pillar (0-10). Returns null without any usable component.
function computeTechnical(weekBars, monthBars, pillarsVal, today){
  const wc = (weekBars || []).map(b => b[4]), mc = (monthBars || []).map(b => b[4]);
  const wm = techMacd(wc), mm = techMacd(mc), wr = techRsi(wc), mr = techRsi(mc);
  const states = { monthMacd: techMacdState(mm), weekMacd: techMacdState(wm), monthRsi: techRsiState(mr), weekRsi: techRsiState(wr), valuation: techValLabel(pillarsVal) };
  if(!wm && !mm && wr == null && mr == null) return null;
  const pct = c => c.length >= 2 && c[c.length - 2] ? (c[c.length - 1] / c[c.length - 2] - 1) * 100 : null;
  const raw = { monthMacdLevel: mm ? mm.level : null, monthMacdSignal: mm ? mm.signal : null, weekMacdLevel: wm ? wm.level : null, weekMacdSignal: wm ? wm.signal : null,
    weekPctChange: pct(wc), monthPctChange: pct(mc), monthRsi: mr, weekRsi: wr, valuationScore: pillarsVal == null ? null : pillarsVal };
  const mt = s => s ? (s.startsWith('bull') ? 'bullish' : 'bearish') + ', ' + (s.endsWith('above') ? 'above' : 'below') + ' zero' : null;
  const parts = [];
  if(states.monthMacd) parts.push('monthly MACD ' + mt(states.monthMacd));
  if(states.weekMacd) parts.push('weekly MACD ' + mt(states.weekMacd));
  const rs = [];
  if(mr != null) rs.push('monthly RSI ' + mr.toFixed(1) + ' (' + states.monthRsi + ')');
  if(wr != null) rs.push('weekly RSI ' + wr.toFixed(1) + ' (' + states.weekRsi + ')');
  let reason = parts.join(', ') + (parts.length ? '. ' : '') + rs.join(', ') + (rs.length ? '. ' : '');
  if(pillarsVal != null) reason += 'Valuation pillar reading of ' + pillarsVal.toFixed(1) + '/10 (' + states.valuation + ').';
  const missing = [];
  if(!states.monthMacd) missing.push('monthly MACD'); if(mr == null) missing.push('monthly RSI');
  if(!states.weekMacd) missing.push('weekly MACD'); if(wr == null) missing.push('weekly RSI');
  if(missing.length) reason += ' (' + missing.join(' and ') + ' not available: too little price history. Composite computed from available components only, rescaled to a 0–10 scale.)';
  return { score: techComposite(states, pillarsVal), reason: reason.trim(), states, raw, asof: today };
}

export { computeTechnical };
