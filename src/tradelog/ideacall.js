// The call for one stock in the Buy / Sell ideas: a stock you hold gets the same call as its Trade Log card (add, hold, trim or
// review); a stock you do not hold gets a Buy, Wait or Avoid from fixed points on the verdict, margin of safety, RSI and
// Fundamental score, so the same data always gives the same answer. A reference for your own decision, not an order.
import { factsFor, tradeSignal } from './signals.js';

const BUY_AT = 4, AVOID_AT = -2;
const VERDICT_PTS = { buy: 2, mbuy: 1, hold: -1, avoid: -2 };
const fx = (v, d = 1) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : null;

// Points and reasons for a stock from its facts (the shape factsFor returns).
function ideaPoints(f){
  let pts = 0;
  const why = [];
  const add = (n, text) => { pts += n; why.push(text); };
  if(f.verdict && VERDICT_PTS[f.verdict] != null){
    const n = VERDICT_PTS[f.verdict];
    add(n, 'Verdict ' + (f.verdict === 'buy' ? 'Strong' : f.verdict === 'mbuy' ? 'Good' : f.verdict === 'hold' ? 'Hold' : 'Avoid'));
  }
  const mos = (f.price != null && f.intrinsic) ? (f.intrinsic - f.price) / f.intrinsic * 100 : null;
  if(mos != null){
    if(mos >= 30) add(2, 'margin of safety ' + fx(mos) + '%');
    else if(mos >= 10) add(1, 'margin of safety ' + fx(mos) + '%');
    else if(mos < 0) add(-2, 'above fair value (' + fx(mos) + '%)');
  }
  if(f.rsiWeek != null){
    if(f.rsiWeek >= 80) add(-2, 'weekly RSI stretched at ' + fx(f.rsiWeek));
    else if(f.rsiWeek >= 75) add(-1, 'weekly RSI warm at ' + fx(f.rsiWeek));
  }
  if(f.rsiMonth != null && f.rsiMonth >= 75) add(-1, 'monthly RSI high at ' + fx(f.rsiMonth));
  if(f.score != null){
    if(f.score >= 7) add(1, 'Fundamental score ' + fx(f.score, 2));
    else if(f.score < 5) add(-1, 'Fundamental score only ' + fx(f.score, 2));
  }
  // The Technical score already folds in the weekly and monthly MACD and RSI, so it replaces the old "calm RSI" point.
  if(f.techScore != null){
    if(f.techScore >= 7) add(1, 'Technical score ' + fx(f.techScore, 1));
    else if(f.techScore < 4) add(-1, 'Technical score only ' + fx(f.techScore, 1));
  }
  return { pts, why, mos };
}

// The call for one stock. `trade` is the open trade in it, or null.
function ideaCall(stock, trade){
  const f = factsFor(trade || {}, stock);
  const p = ideaPoints(f);
  if(trade){
    const sig = tradeSignal(f);
    const call = sig.call === 'add' ? 'buy' : sig.call === 'hold' ? 'hold' : 'sell';
    const label = { add: 'Add more', hold: 'Hold', trim: 'Trim', review: 'Review' }[sig.call];
    return { call, label, pts: p.pts, mos: p.mos, held: true, reasons: sig.reasons };
  }
  const call = p.pts >= BUY_AT && !(f.rsiWeek != null && f.rsiWeek >= 80) ? 'buy' : p.pts <= AVOID_AT ? 'sell' : 'hold';
  return { call, label: { buy: 'Buy', hold: 'Wait', sell: 'Avoid' }[call], pts: p.pts, mos: p.mos, held: false, reasons: p.why };
}

// Buy first (most points first), then Hold, then Sell (weakest first, so the most urgent leads).
const GROUP = { buy: 0, hold: 1, sell: 2 };
function rankIdeas(items){
  return items.slice().sort((a, b) => GROUP[a.c.call] - GROUP[b.c.call] || (a.c.call === 'sell' ? a.c.pts - b.c.pts : b.c.pts - a.c.pts) || (a.s.name || '').localeCompare(b.s.name || ''));
}

export { ideaCall, rankIdeas };
