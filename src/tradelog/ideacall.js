// The call for one stock in the Buy / Sell ideas, aimed at gaining about 5% within 1 to 4 weeks.
// A stock you hold gets the same call as its Trade Log card (add, hold, trim or review). A stock you do not hold gets two
// separate readings: QUALITY (is it worth owning: verdict, margin of safety, Fundamental score) and SETUP (does the chart look
// like one that moves 5% soon: swing.js). Buy needs both; the Buy list is ranked by setup, then quality. Fixed rules on
// the dashboard's own numbers, so the same data always gives the same answer. A reference for your own decision, not an order.
import { fixedOrNull } from '../core/util.js';
import { factsFor, tradeSignal } from './signals.js';

const BUY_SETUP = 2, AVOID_AT = -2, MOS_MIN = 10, SCORE_MIN = 5;
const VERDICT_PTS = { buy: 2, mbuy: 1, hold: -1, avoid: -2 };
const VERDICT_NAME = { buy: 'Strong', mbuy: 'Good', hold: 'Hold', avoid: 'Avoid' };

// Quality points and the reasons for them, from the facts factsFor returns.
function qualityOf(f){
  let pts = 0;
  const why = [];
  const add = (n, text) => { pts += n; why.push(text); };
  if(f.verdict && VERDICT_PTS[f.verdict] != null) add(VERDICT_PTS[f.verdict], 'Verdict ' + VERDICT_NAME[f.verdict]);
  const mos = (f.price != null && f.intrinsic) ? (f.intrinsic - f.price) / f.intrinsic * 100 : null;
  if(mos != null){
    if(mos >= 30) add(2, 'margin of safety ' + fixedOrNull(mos) + '%');
    else if(mos >= 10) add(1, 'margin of safety ' + fixedOrNull(mos) + '%');
    else if(mos < 0) add(-2, 'above fair value (' + fixedOrNull(mos) + '%)');
  }
  if(f.score != null){
    if(f.score >= 7) add(1, 'Fundamental score ' + fixedOrNull(f.score, 2));
    else if(f.score < SCORE_MIN) add(-1, 'Fundamental score only ' + fixedOrNull(f.score, 2));
  }
  // Worth owning at all: a Strong or Good verdict, at least a 10% cushion, and a Fundamental score of 5 or more.
  const worth = !!f.verdict && (f.verdict === 'buy' || f.verdict === 'mbuy') && mos != null && mos >= MOS_MIN && f.score != null && f.score >= SCORE_MIN;
  return { pts, why, mos, worth };
}

// The call for one stock. `trade` is the open trade in it, or null; `setup` is swingSetup's reading for the stock (null without weekly bars).
function ideaCall(stock, trade, setup){
  const f = factsFor(trade || {}, stock);
  const q = qualityOf(f);
  const s = setup || null;
  const base = { pts: q.pts, mos: q.mos, setup: s ? s.pts : null, of: s ? s.of : null, chance: s ? s.chance : null, touch: s ? s.touch : null, fromHigh: s ? s.fromHigh : null };
  if(trade){
    const sig = tradeSignal(f);
    const call = sig.call === 'add' ? 'buy' : sig.call === 'hold' ? 'hold' : 'sell';
    const label = { add: 'Add more', hold: 'Hold', trim: 'Trim', review: 'Review' }[sig.call];
    return { ...base, call, label, held: true, reasons: sig.reasons };
  }
  const weekMacd = stock && stock.technical && stock.technical.states && stock.technical.states.weekMacd;
  let call = 'hold';
  const reasons = q.why.slice();
  if(q.pts <= AVOID_AT) call = 'sell';
  else if(q.worth && s && s.pts >= BUY_SETUP && weekMacd !== 'bear_below') call = 'buy';
  if(call !== 'sell'){
    if(!q.worth) reasons.push('not yet worth owning (needs a Strong or Good verdict, margin of safety ' + MOS_MIN + '%+, Fundamental score ' + SCORE_MIN + '+)');
    if(s) reasons.push('setup ' + s.pts + '/' + s.of + ': ' + (s.hits.length ? s.hits.join(', ') : 'no timing signal') + (call === 'buy' ? '' : (s.misses.length ? '; missing: ' + s.misses.join(', ') : '')));
    else if(q.worth) reasons.push('no weekly price history yet, so the timing cannot be judged');
    if(q.worth && s && s.pts >= BUY_SETUP && weekMacd === 'bear_below') reasons.push('weekly MACD is bearish below zero');
  }
  return { ...base, call, label: { buy: 'Buy', hold: 'Wait', sell: 'Avoid' }[call], held: false, reasons };
}

// Buy first, then Hold, then Sell. Buy and Wait lead with the best setup, then quality, then the stock nearest its high;
// Sell leads with the weakest quality so the most urgent is on top.
const GROUP = { buy: 0, hold: 1, sell: 2 };
function rankIdeas(items){
  const n = (v) => (typeof v === 'number' ? v : -Infinity);
  return items.slice().sort((a, b) => {
    const A = a.c, B = b.c;
    if(GROUP[A.call] !== GROUP[B.call]) return GROUP[A.call] - GROUP[B.call];
    if(A.call === 'sell') return A.pts - B.pts || (a.s.name || '').localeCompare(b.s.name || '');
    return n(B.setup) - n(A.setup) || B.pts - A.pts || n(B.fromHigh) - n(A.fromHigh) || (a.s.name || '').localeCompare(b.s.name || '');
  });
}

export { ideaCall, rankIdeas };
