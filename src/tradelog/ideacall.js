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
import { capClass } from '../core/capclass.js';
import { newsCounts } from '../strategies/news.js';
import { marginOfSafety } from '../core/mos.js';
import { factsFor, tradeSignal } from './signals.js';

// The stock's trend from its weekly and monthly MACD against their signal lines (the dashboard's own technical figures): 'up' when both are above, 'down' when
// both are below, 'mixed' when they disagree, null when either is missing. The same definition the two-week tests were split by.
function trendOf(stock){
  const r = (stock && stock.technical && stock.technical.raw) || {};
  const v = [r.weekMacdLevel, r.weekMacdSignal, r.monthMacdLevel, r.monthMacdSignal];
  if(v.some(x => typeof x !== 'number' || !isFinite(x))) return null;
  const w = r.weekMacdLevel > r.weekMacdSignal, m = r.monthMacdLevel > r.monthMacdSignal;
  return w && m ? 'up' : !w && !m && r.weekMacdLevel < r.weekMacdSignal && r.monthMacdLevel < r.monthMacdSignal ? 'down' : 'mixed';
}

// FII selling or buying last quarter, from the Screener columns (FII holding, its change over the last quarter, and its change over 3 years): a note, never a
// block, because no link to the next two weeks could be found and there is no history to test one. The change must be at least FII_MIN points AND at least
// FII_REL of what the funds held before, so a 1-point cut means something for a stock they own 55% of and a 0.5-point cut means something for one they own 3% of.
// Returns the sentence, or null. The figures are as of the last quarter end, so they cannot explain moves since.
const FII_MIN = 0.5, FII_REL = 0.1;
function fiiNote(stock){
  const v = (stock && stock.valuation) || {}, c = v.fiiChange, h = v.fiiHolding;
  if(typeof c !== 'number' || typeof h !== 'number' || !isFinite(c) || !isFinite(h)) return null;
  const prev = h - c;
  if(!(prev > 0) || Math.abs(c) < FII_MIN || Math.abs(c) / prev < FII_REL) return null;
  const w = fixedOrNull(prev, 1) + '% to ' + fixedOrNull(h, 1) + '%', long = typeof v.fiiChange3 === 'number' && (c < 0 ? v.fiiChange3 < 0 : v.fiiChange3 > 0);
  return c < 0 ? 'FII selling: holding down ' + fixedOrNull(-c, 1) + ' points last quarter (' + w + ')' + (long ? ', down over 3 years too' : '')
    : 'FII buying: holding up ' + fixedOrNull(c, 1) + ' points last quarter (' + w + ')' + (long ? ', up over 3 years too' : '');
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
  else if(n && n.pos >= NEWS_MIN && n.pos > n.neg) notes.push('Recent news is positive (' + n.pos + ' positive, ' + n.neg + ' negative)');
  const fn = fiiNote(stock); if(fn) notes.push(fn);
  return { blocks, notes, cap: capClass(lq.marketCap), resultsIn };
}

const sign = (x) => (x >= 0 ? '+' : '') + fixedOrNull(x, 1) + '%';
// Short, plain lines for the row (one idea each; the screen shows them as bullets).
const TREND_WORD = { up: 'Upward', down: 'Downward' };
function rankLine(r){ return 'Top ' + r.topPct + '% of the ' + (TREND_WORD[r.trend] || '') + ' stocks in this strategy today'; }
function recordLine(r){ return 'In 5 years of tests, stocks ranked like this were higher after 2 weeks ' + fixedOrNull(r.up, 0) + '% of the time (all ' + (TREND_WORD[r.trend] || '') + ' stocks: ' + fixedOrNull(r.base, 0) + '%)'; }
function moveLine(r){ const f = r.facts; return 'Price: last week ' + sign(f.week) + ', 4 weeks ' + sign(f.month) + ', 26 weeks ' + sign(f.half); }
function highLine(r){ const d = -r.facts.fromHigh; return d < 1 ? 'Near its 52-week high' : fixedOrNull(d, 0) + '% below its 52-week high'; }
function valueLine(mos){ return mos != null && mos > 0 ? 'Priced ' + fixedOrNull(mos, 0) + '% below its fair value' : null; }

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
  else if(!r.trend || r.trend === 'mixed') reasons.push(r.trend ? 'Weekly and monthly trends disagree, so it is in neither list' : 'No MACD figures saved yet, so its trend is unknown (import the data)', moveLine(r));
  else {
    if(r.trend === 'down') o.notes.unshift('Bounce-back pick: both trends are down, so this bets on a rebound');
    if(r.pct >= 100 - BUY_TOP) { if(o.blocks.length) o.blocks.forEach(b => reasons.push('held back: ' + b)); else call = 'buy'; }
    else if(r.pct <= AVOID_BOTTOM) call = 'sell';
    reasons.unshift(rankLine(r), recordLine(r));
    const v = valueLine(mos); if(v) reasons.push(v);
    reasons.push(moveLine(r), highLine(r));
    if(r.thin && !o.blocks.some(b => /thin trading/.test(b))) reasons.push('Trades thinly, so treat the score with care');
  }
  if(call !== 'sell') o.notes.forEach(x => reasons.push(x));
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

export { BUY_TOP, RESULTS_DAYS, THIN_LAKH, ideaCall, rankIdeas, topBuys, trendOf };
