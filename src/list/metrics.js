// Derived per-stock numbers and predicates used by Analysis, Strategies and the detail page (score band, MoS, week and month change).
function scoreDelta(s){
  return typeof s.prevScore === 'number' ? Math.round((s.score - s.prevScore)*100)/100 : 0;
}

function weekPct(s){
  return (s.technical && s.technical.raw) ? s.technical.raw.weekPctChange : -Infinity;
}
function monthPct(s){
  return (s.technical && s.technical.raw) ? s.technical.raw.monthPctChange : -Infinity;
}
// Margin of safety (vs. Screener.in Intrinsic Value), as a plain number for sorting — same formula as marginOfSafetyInfo()
// below, duplicated rather than shared because that function also returns a display color
// class this purely-numeric sort helper doesn't need. Stocks with no Valuation Snapshot on
// file sort to the bottom of a "highest MoS first" list rather than the top.
function mosPct(s){
  const v = s.valuation;
  if(!v || v.intrinsicValue == null || v.currentPrice == null) return -Infinity;
  return ((v.intrinsicValue - v.currentPrice) / v.intrinsicValue) * 100;
}

// The green/orange/red Margin-of-Safety bucketing (>= 0%, -25% to 0%, below -25%) with NO Fundamental
// Score verdict requirement. Used by the Analysis section's MoS Rating filter.
function mosRatingAny(s){
  const v = s.valuation;
  if(!v || v.intrinsicValue == null || v.currentPrice == null) return null;
  const mos = ((v.intrinsicValue - v.currentPrice) / v.intrinsicValue) * 100;
  if(mos >= 0) return 'green';
  if(mos >= -25) return 'orange';
  return 'red';
}


function scoreBand(v){
  if(v==null) return 'fs-pending';
  if(v>=8) return 'fs-buy';
  if(v>=6) return 'fs-mbuy';
  if(v>=5) return 'fs-hold';
  return 'fs-avoid';
}

export { monthPct, mosPct, mosRatingAny, scoreBand, scoreDelta, weekPct };
