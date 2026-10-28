// The call for one stock in the Buy / Sell ideas, built around one question: which stock is likely to be higher two weeks from now? (rewritten in v1.289)
// A stock you hold gets the same call as its Trade Log card (add, hold, trim or review). A stock you do not hold gets the TWO-WEEK reading from
// nextweek.js (a model trained and tested week by week on five years of weekly prices) and then plain checks:
//   Buy    the stock is in the top BUY_TOP percent of two-week scores and none of the checks holds it back;
//   Avoid  it is in the bottom AVOID_BOTTOM percent (stocks like that lagged the market in the tests);
//   Wait   anything else, including a Buy held back by a check (the reason is shown in the row).
// The checks are not part of the model: quality (a margin of safety above zero and a Fundamental verdict that is not Avoid), results due within RESULTS_DAYS days
// (an earnings gap decides the fortnight), very thin trading (average daily traded value under THIN_LAKH lakh rupees, hard to enter and leave) and clearly
// negative recent news. Fixed rules on the dashboard's own numbers, so the
// same data always gives the same answer. A reference for your own decision, not an order, and it cannot see the market: when every stock falls together,
// the best of them usually falls too.
import { daysUntil, fixedOrNull } from '../core/util.js';
import { CAP_NAME, capClass } from '../core/capclass.js';
import { newsCounts } from '../strategies/news.js';
import { marginOfSafety } from '../core/mos.js';
import { factsFor, tradeSignal } from './signals.js';

const TREND_NAME = { up: 'Upward trend', down: 'Downward trend', mixed: 'Mixed trend' };
// The stock's trend from its weekly and monthly MACD against their signal lines (the dashboard's own technical figures): 'up' when both are above, 'down' when
// both are below, 'mixed' when they disagree, null when either is missing. The same definition the two-week tests were split by.
function trendOf(stock){
  const r = (stock && stock.technical && stock.technical.raw) || {};
  const v = [r.weekMacdLevel, r.weekMacdSignal, r.monthMacdLevel, r.monthMacdSignal];
  if(v.some(x => typeof x !== 'number' || !isFinite(x))) return null;
  const w = r.weekMacdLevel > r.weekMacdSignal, m = r.monthMacdLevel > r.monthMacdSignal;
  return w && m ? 'up' : !w && !m && r.weekMacdLevel < r.weekMacdSignal && r.monthMacdLevel < r.monthMacdSignal ? 'down' : 'mixed';
}

const BUY_TOP = 10, AVOID_BOTTOM = 10, RESULTS_DAYS = 7, THIN_LAKH = 50, NEWS_MIN = 2;

// Risk checks for a stock you do not hold: { blocks: reasons a Buy is held back, notes: other news worth saying, cap, resultsIn }. `today` is YYYY-MM-DD in India.
// A figure the stock has not been refreshed for yet (results date, volume, market cap, news) never blocks.
function risksOf(stock, today, f, mos){
  const blocks = [], notes = [];
  if(f && f.verdict === 'avoid') blocks.push('its Fundamental verdict is Avoid');
  if(mos != null && mos <= 0) blocks.push('it trades at or above fair value (margin of safety ' + fixedOrNull(mos) + '%)');
  const lq = (stock && stock.liquidity) || {};
  const resultsIn = today ? daysUntil(lq.nextResults, today) : null;
  if(resultsIn != null && resultsIn <= RESULTS_DAYS) blocks.push('results due ' + (resultsIn === 0 ? 'today' : 'in ' + resultsIn + ' day' + (resultsIn === 1 ? '' : 's')) + ' (' + lq.nextResults + ')');
  const px = stock && stock.valuation && stock.valuation.currentPrice;
  if(typeof lq.avgVolume === 'number' && typeof px === 'number' && (lq.avgVolume * px) / 100000 < THIN_LAKH) blocks.push('very thin trading (under ₹' + THIN_LAKH + ' lakh a day)');
  const n = stock ? newsCounts(stock) : null;
  if(n && n.neg >= NEWS_MIN && n.neg > n.pos) blocks.push('recent news leans negative (' + n.neg + ' negative, ' + n.pos + ' positive)');
  else if(n && n.pos >= NEWS_MIN && n.pos > n.neg) notes.push('recent news leans positive (' + n.pos + ' positive, ' + n.neg + ' negative)');
  return { blocks, notes, cap: capClass(lq.marketCap), resultsIn };
}

const sign = (x) => (x >= 0 ? '+' : '') + fixedOrNull(x, 1) + '%';
// The sentence that says what the next-week score means, with the numbers from the tests.
function scoreLine(r){
  return 'two-week score in the top ' + r.topPct + '% of this strategy\'s ' + (TREND_NAME[r.trend] || '').toLowerCase() + ' stocks today; in five years of tests stocks that ranked like this within their trend each week were higher two weeks later ' + fixedOrNull(r.up, 1) + '% of the time (all ' + (TREND_NAME[r.trend] || '').toLowerCase() + ' stocks ' + fixedOrNull(r.base, 1) + '%) and beat the median stock ' + fixedOrNull(r.beat, 1) + '% of the time';
}
function factsLine(r){
  const f = r.facts;
  return 'last week ' + sign(f.week) + ', 4 weeks ' + sign(f.month) + ', 26 weeks ' + sign(f.half) + ', ' + fixedOrNull(-f.fromHigh, 0) + '% below its 52-week high';
}

// The call for one stock. `trade` is the open trade in it, or null; `read` is nextWeekRead's reading for the stock (null without enough weekly history).
function ideaCall(stock, trade, read, today){
  const f = factsFor(trade || {}, stock);
  const mos = marginOfSafety(f.intrinsic, f.price);
  const r = read || null, o = risksOf(stock, today, f, mos);
  const base = { trend: r ? r.trend || null : null, base: r ? r.base : null, mos, cap: o.cap, resultsIn: o.resultsIn, p: r ? r.p : null, pct: r ? r.pct : null, topPct: r ? r.topPct : null, up: r ? r.up : null, beat: r ? r.beat : null };
  if(trade){
    const sig = tradeSignal(f);
    const call = sig.call === 'add' ? 'buy' : sig.call === 'hold' ? 'hold' : 'sell';
    const label = { add: 'Add more', hold: 'Hold', trim: 'Trim', review: 'Review' }[sig.call];
    return { ...base, call, label, held: true, reasons: sig.reasons };
  }
  const reasons = [];
  let call = 'hold';
  if(!r) reasons.push('no weekly price history yet (80 weeks are needed), so the next two weeks cannot be judged');
  else if(!r.trend || r.trend === 'mixed') reasons.push(r.trend ? 'weekly and monthly trends disagree, so it is in neither the Upward nor the Downward list' : 'no MACD figures saved for this stock yet, so its trend is unknown (Refresh all stocks)', factsLine(r));
  else {
    if(r.trend === 'down') o.notes.push('a bounce-back pick: the weekly and monthly trends are both down, so this is a bet on a rebound, not on strength');
    if(r.pct >= 100 - BUY_TOP) { if(o.blocks.length) o.blocks.forEach(b => reasons.push('held back: ' + b)); else call = 'buy'; }
    else if(r.pct <= AVOID_BOTTOM) call = 'sell';
    reasons.unshift(scoreLine(r));
    reasons.push(factsLine(r));
    if(r.thin && !o.blocks.some(b => /thin trading/.test(b))) reasons.push('weekly traded value is below what the model was trained on, so treat the score with care');
  }
  if(call !== 'sell') o.notes.forEach(x => reasons.push(x));
  if(o.cap) reasons.push(CAP_NAME[o.cap]);
  return { ...base, call, label: { buy: 'Buy', hold: 'Wait', sell: 'Avoid' }[call], held: false, reasons };
}

// Buy first, then Wait, then Avoid. Buy and Wait lead with the highest two-week score; Avoid leads with the lowest. A stock without a score goes last in its group.
const GROUP = { buy: 0, hold: 1, sell: 2 };
function rankIdeas(items){
  const n = (v) => (typeof v === 'number' ? v : -Infinity);
  return items.slice().sort((a, b) => {
    const A = a.c, B = b.c;
    if(GROUP[A.call] !== GROUP[B.call]) return GROUP[A.call] - GROUP[B.call];
    if(A.call === 'sell'){ const lo = (v) => (typeof v === 'number' ? v : Infinity); return lo(A.p) - lo(B.p) || (a.s.name || '').localeCompare(b.s.name || ''); }
    return n(B.p) - n(A.p) || (a.s.name || '').localeCompare(b.s.name || '');
  });
}

// The best Buy calls of one trend ('up' or 'down') for stocks you do not hold, in ranked order (rankIdeas has already put the Buys first).
function topBuys(ranked, trend, n = 5){ return ranked.filter(x => x.c.call === 'buy' && !x.c.held && x.c.trend === trend).slice(0, n); }

export { AVOID_BOTTOM, BUY_TOP, RESULTS_DAYS, THIN_LAKH, TREND_NAME, ideaCall, rankIdeas, topBuys, trendOf };
