// Technical Score engine: EMA, MACD, RSI and the composite. The one home of this maths: techscore2.js and the strategy search reuse it.

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
  if(ag === 0 && al === 0) return null;   // flat series: RSI is undefined, not 100
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function techMacdStateOf(level, signal){ return level == null || signal == null ? null : (level > signal ? 'bull' : 'bear') + (level > 0 ? '_above' : '_below'); }
function techMacdState(m){ return !m ? null : techMacdStateOf(m.level, m.signal); }
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
// ---- Completed bars only (v1.181) ----
// A weekly or monthly bar that is still in progress keeps moving, so a score saved from it can flip on the next refresh.
// The saved score therefore uses completed bars only; the in-progress reading is kept apart as `provisional`.
// Bar times are unix seconds (bar open); `today` is the IST date 'YYYY-MM-DD' of the refresh, which keeps this testable.
function techIstDate(sec){ return new Date((sec + 19800) * 1000).toISOString().slice(0, 10); }
function techDayNo(ymd){ return Math.floor(new Date(ymd + 'T00:00:00Z').getTime() / 86400000); }
function techWeekStart(ymd){ const n = techDayNo(ymd); return n - ((n + 3) % 7); }   // Monday of that week (day 0 was a Thursday)
// True when the bar's week (or month) has not finished on `today`. A weekly bar counts as finished from Saturday; a
// monthly bar from the first day of the next month.
function techBarForming(bar, kind, today){
  if(!bar || !today) return false;
  const open = techIstDate(bar[0]);
  if(kind === 'month') return open.slice(0, 7) >= today.slice(0, 7);
  if((techDayNo(today) + 3) % 7 >= 5) return techWeekStart(open) > techWeekStart(today);
  return techWeekStart(open) >= techWeekStart(today);
}
function techCompleted(bars, kind, today){ return bars.length && techBarForming(bars[bars.length - 1], kind, today) ? bars.slice(0, -1) : bars; }
// States, raw figures and score from two close series; null without any usable component.
function techReading(wc, mc, pillarsVal){
  const wm = techMacd(wc), mm = techMacd(mc), wr = techRsi(wc), mr = techRsi(mc);
  if(!wm && !mm && wr == null && mr == null) return null;
  const states = { monthMacd: techMacdState(mm), weekMacd: techMacdState(wm), monthRsi: techRsiState(mr), weekRsi: techRsiState(wr), valuation: techValLabel(pillarsVal) };
  const raw = { monthMacdLevel: mm ? mm.level : null, monthMacdSignal: mm ? mm.signal : null, weekMacdLevel: wm ? wm.level : null, weekMacdSignal: wm ? wm.signal : null, monthRsi: mr, weekRsi: wr };
  return { states, raw, score: techComposite(states, pillarsVal) };
}
// The plain-English line saved with a technical block (states, RSI figures, valuation, and which components were missing).
function techReason(states, r, pillarsVal){
  const mt = s => s ? (s.startsWith('bull') ? 'bullish' : 'bearish') + ', ' + (s.endsWith('above') ? 'above' : 'below') + ' zero' : null;
  const parts = [];
  if(states.monthMacd) parts.push('monthly MACD ' + mt(states.monthMacd));
  if(states.weekMacd) parts.push('weekly MACD ' + mt(states.weekMacd));
  const rs = [];
  if(r.monthRsi != null) rs.push('monthly RSI ' + r.monthRsi.toFixed(1) + ' (' + states.monthRsi + ')');
  if(r.weekRsi != null) rs.push('weekly RSI ' + r.weekRsi.toFixed(1) + ' (' + states.weekRsi + ')');
  let reason = parts.join(', ') + (parts.length ? '. ' : '') + rs.join(', ') + (rs.length ? '. ' : '');
  if(pillarsVal != null) reason += 'Valuation pillar reading of ' + pillarsVal.toFixed(1) + '/10 (' + states.valuation + ').';
  const missing = [];
  if(!states.monthMacd) missing.push('monthly MACD'); if(r.monthRsi == null) missing.push('monthly RSI');
  if(!states.weekMacd) missing.push('weekly MACD'); if(r.weekRsi == null) missing.push('weekly RSI');
  if(missing.length) reason += ' (' + missing.join(' and ') + ' not available: too little price history. Composite computed from available components only, rescaled to a 0–10 scale.)';
  return reason.trim();
}
// Technical block from [t,o,h,l,c,v] bars (weekly, monthly) and the stock's valuation pillar (0-10). Returns null without any usable component.
// The score uses completed bars only; when a week or month is still in progress its reading is kept as `provisional`.
function computeTechnical(weekBars, monthBars, pillarsVal, today){
  const wAll = weekBars || [], mAll = monthBars || [];
  const wDone = techCompleted(wAll, 'week', today), mDone = techCompleted(mAll, 'month', today);
  const closes = bars => bars.map(b => b[4]);
  const wc = closes(wDone), mc = closes(mDone);
  const done = techReading(wc, mc, pillarsVal);
  if(!done) return null;
  const { states, raw: r } = done;
  const wp = closes(wAll), mp = closes(mAll);
  const pct = c => c.length >= 2 && c[c.length - 2] ? (c[c.length - 1] / c[c.length - 2] - 1) * 100 : null;
  // The price changes show the current move, so they use every bar; the score inputs use completed bars.
  const raw = { monthMacdLevel: r.monthMacdLevel, monthMacdSignal: r.monthMacdSignal, weekMacdLevel: r.weekMacdLevel, weekMacdSignal: r.weekMacdSignal,
    weekPctChange: pct(wp), monthPctChange: pct(mp), monthRsi: r.monthRsi, weekRsi: r.weekRsi, valuationScore: pillarsVal == null ? null : pillarsVal };
  const reason = techReason(states, r, pillarsVal);
  const out = { score: techComposite(states, pillarsVal), reason, states, raw, asof: today };
  // Which bars the score rests on, and the in-progress reading when a week or month is not finished yet.
  out.basis = { week: wDone.length ? techIstDate(wDone[wDone.length - 1][0]) : null, month: mDone.length ? techIstDate(mDone[mDone.length - 1][0]) : null };
  if(wDone.length !== wAll.length || mDone.length !== mAll.length){
    const live = techReading(closes(wAll), closes(mAll), pillarsVal);
    if(live) out.provisional = { score: techComposite(live.states, pillarsVal), states: { monthMacd: live.states.monthMacd, weekMacd: live.states.weekMacd, monthRsi: live.states.monthRsi, weekRsi: live.states.weekRsi }, monthRsi: live.raw.monthRsi, weekRsi: live.raw.weekRsi };
  }
  return out;
}

// Technical block from the MACD / RSI figures TradingView calculated for a symbol (the batch snapshot), with no bars at hand.
// TradingView's figures include the week and month still in progress, so the block is marked src 'snapshot' and carries no
// completed-bar dates (basis). `r` = { monthMacdLevel, monthMacdSignal, weekMacdLevel, weekMacdSignal, monthRsi, weekRsi, weekPctChange, monthPctChange }.
// Returns null when none of the four indicators is available.
function snapshotTechnical(r, pillarsVal, today){
  const states = { monthMacd: techMacdStateOf(r.monthMacdLevel, r.monthMacdSignal), weekMacd: techMacdStateOf(r.weekMacdLevel, r.weekMacdSignal),
    monthRsi: techRsiState(r.monthRsi), weekRsi: techRsiState(r.weekRsi), valuation: techValLabel(pillarsVal) };
  if(!states.monthMacd && !states.weekMacd && !states.monthRsi && !states.weekRsi) return null;
  const n = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const raw = { monthMacdLevel: n(r.monthMacdLevel), monthMacdSignal: n(r.monthMacdSignal), weekMacdLevel: n(r.weekMacdLevel), weekMacdSignal: n(r.weekMacdSignal),
    weekPctChange: n(r.weekPctChange), monthPctChange: n(r.monthPctChange), monthRsi: n(r.monthRsi), weekRsi: n(r.weekRsi), valuationScore: pillarsVal == null ? null : pillarsVal };
  return { score: techComposite(states, pillarsVal), reason: techReason(states, raw, pillarsVal) + ' Read from TradingView, including the week and month in progress.', states, raw, asof: today, src: 'snapshot', basis: { week: null, month: null } };
}
// True when a saved block was built from completed bars and is recent enough that a snapshot (which includes the bar in progress) should not replace it.
function techKeepsBarsBlock(t, today, days = 3){
  if(!t || t.src === 'snapshot' || !t.basis || !t.basis.week || typeof t.asof !== 'string') return false;
  return techDayNo(today) - techDayNo(t.asof) <= days;
}

export { computeTechnical, snapshotTechnical, techCompleted, techComposite, techEma, techKeepsBarsBlock, techMacdStateOf, techRsi, techRsiState, techValLabel };
