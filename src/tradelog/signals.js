// Daily call for each open trade: Hold, Consider trimming, Consider adding, or Review, with the reasons behind it.
// Fixed rules on the dashboard's own numbers (verdict, score, margin of safety, RSI, gain against the buy price), so
// the same data always gives the same call. It is a reference for the person's own decision, never an order.
// The thresholds below are the defaults; they are plain numbers so they can become settings later.

const LIMITS = {
  lossReview: -15,       // % below the buy price: look at the position again
  scoreDropReview: 1.0,  // fundamental score fell this much since entry
  rsiStretchedWeek: 80,  // weekly RSI at or above this is stretched
  rsiWarmWeek: 75, rsiWarmMonth: 70,
  gainTrim: 15,          // % gain from which a stretched RSI suggests trimming
  gainBig: 40,           // % gain that suggests taking some off whatever the RSI
  mosThin: 10,           // margin of safety (%) below which the cushion is thin
  mosThinGain: 10,       // ... if the position is also up this much
  mosAdd: 30, rsiAddMax: 60, nearEntry: 10   // adding: roomy cushion, not stretched, price within +-10% of the buy price
};
const GOOD = new Set(['buy', 'mbuy']), WEAK = new Set(['hold', 'avoid']);
const CALLS = { hold: 'Hold', trim: 'Consider trimming', add: 'Consider adding', review: 'Review' };
const fx = (v, d = 1) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : null;

// facts: { buyPrice, price, entryScore, score, verdict, intrinsic, rsiWeek, rsiMonth }; any of them may be null.
function tradeSignal(facts, limits = LIMITS){
  const f = facts || {};
  const gain = (f.price != null && f.buyPrice) ? (f.price - f.buyPrice) / f.buyPrice * 100 : null;
  const mos = (f.price != null && f.intrinsic) ? (f.intrinsic - f.price) / f.intrinsic * 100 : null;
  const drop = (f.entryScore != null && f.score != null) ? f.entryScore - f.score : null;
  const reasons = [];
  const out = (call) => ({ call, label: CALLS[call], reasons, gain, mos });

  // Review: the case for the position itself looks weaker.
  const review = [];
  if(f.verdict && WEAK.has(f.verdict)) review.push('The verdict is now ' + (f.verdict === 'avoid' ? 'Avoid' : 'Hold') + ', below the level you bought at.');
  if(drop != null && drop >= limits.scoreDropReview) review.push('The Fundamental score fell ' + fx(drop, 2) + ' since you bought (' + fx(f.entryScore, 2) + ' to ' + fx(f.score, 2) + ').');
  if(gain != null && gain <= limits.lossReview) review.push('The price is ' + fx(-gain) + '% below your buy price.');
  if(mos != null && mos < 0) review.push('The price is above the fair value estimate (margin of safety ' + fx(mos) + '%).');
  if(review.length){ reasons.push(...review); return out('review'); }

  // Trim: a good gain with a stretched price or a thin cushion.
  const trim = [];
  const stretched = f.rsiWeek != null && f.rsiWeek >= limits.rsiStretchedWeek;
  const warm = f.rsiWeek != null && f.rsiMonth != null && f.rsiWeek >= limits.rsiWarmWeek && f.rsiMonth >= limits.rsiWarmMonth;
  if(gain != null && gain >= limits.gainTrim && (stretched || warm)) trim.push('Weekly RSI is ' + fx(f.rsiWeek) + (f.rsiMonth != null ? ' and monthly RSI ' + fx(f.rsiMonth) : '') + ', which is stretched, and you are up ' + fx(gain) + '%.');
  if(gain != null && gain >= limits.gainBig) trim.push('You are up ' + fx(gain) + '%, a large gain to protect.');
  if(mos != null && mos < limits.mosThin && gain != null && gain >= limits.mosThinGain) trim.push('The margin of safety is down to ' + fx(mos) + '% and you are up ' + fx(gain) + '%.');
  if(trim.length){
    reasons.push(...trim);
    if(mos != null) reasons.push('Margin of safety is ' + fx(mos) + '%.');
    return out('trim');
  }

  // Add: still a good verdict, a roomy cushion, not stretched, and near the price you paid.
  if(f.verdict && GOOD.has(f.verdict) && mos != null && mos >= limits.mosAdd && (f.rsiWeek == null || f.rsiWeek <= limits.rsiAddMax) && gain != null && Math.abs(gain) <= limits.nearEntry){
    reasons.push('The verdict is still ' + (f.verdict === 'buy' ? 'Strong' : 'Good') + ', the margin of safety is ' + fx(mos) + '%, and the price is within ' + limits.nearEntry + '% of your buy price' + (f.rsiWeek != null ? ' with weekly RSI at ' + fx(f.rsiWeek) : '') + '.');
    return out('add');
  }

  if(f.verdict && GOOD.has(f.verdict)) reasons.push('The verdict is still ' + (f.verdict === 'buy' ? 'Strong' : 'Good') + '.');
  if(mos != null) reasons.push('Margin of safety is ' + fx(mos) + '%.');
  if(gain != null) reasons.push('You are ' + (gain >= 0 ? 'up ' : 'down ') + fx(Math.abs(gain)) + '% on the buy price.');
  if(f.rsiWeek != null) reasons.push('Weekly RSI is ' + fx(f.rsiWeek) + ', not stretched.');
  return out('hold');
}

// Facts for a trade from the live stock record and the trade's own entry snapshot.
function factsFor(trade, stock){
  const buy = trade.buy || {}, snap = buy.snapshot || {};
  const tech = stock && stock.technical, raw = tech && tech.raw;
  return {
    buyPrice: buy.price || null,
    price: stock && stock.valuation && stock.valuation.currentPrice != null ? stock.valuation.currentPrice : null,
    entryScore: snap.score != null ? snap.score : null,
    score: stock && typeof stock.score === 'number' ? stock.score : null,
    verdict: stock && stock.verdict || null,
    intrinsic: stock && stock.valuation && stock.valuation.intrinsicValue || null,
    rsiWeek: raw && typeof raw.weekRsi === 'number' ? raw.weekRsi : null,
    rsiMonth: raw && typeof raw.monthRsi === 'number' ? raw.monthRsi : null
  };
}

// ---- the daily record, one document per trade: portfolio/signals/<trade id> = { history: [[yyyymmdd, call, price, score, rsiWeek, mos, gain], ...], notes: [{ d, text }] }
const KEEP_DAYS = 400;
function addSignalPoint(history, ymd, sig, facts){
  const cur = Array.isArray(history) ? history : [];
  const r = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 100) / 100 : null;
  const pt = [ymd, sig.call, r(facts.price), r(facts.score), r(facts.rsiWeek), r(sig.mos), r(sig.gain)];
  const same = cur.filter(p => p[0] !== ymd);
  same.push(pt);
  same.sort((a, b) => a[0] - b[0]);
  return same.slice(-KEEP_DAYS);
}
// The dates on which the call changed (the first entry counts as a change), newest first.
function callChanges(history){
  const h = Array.isArray(history) ? history : [];
  const out = [];
  h.forEach((p, i) => { if(i === 0 || p[1] !== h[i - 1][1]) out.push({ ymd: p[0], call: p[1], price: p[2] }); });
  return out.reverse();
}

export { addSignalPoint, callChanges, factsFor, tradeSignal };
