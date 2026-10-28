// The call for one stock in the Buy / Sell ideas, aimed at gaining about 5% within 1 to 4 weeks.
// A stock you hold gets the same call as its Trade Log card (add, hold, trim or review). A stock you do not hold gets two
// separate readings: QUALITY (is it worth owning: verdict, margin of safety, Fundamental score) and SETUP (does the chart look
// like one that moves 5% soon: swing.js). Buy needs both; the Buy list is ranked by setup, then quality. Fixed rules on
// the dashboard's own numbers, so the same data always gives the same answer. A reference for your own decision, not an order.
import { daysUntil, fixedOrNull } from '../core/util.js';
import { CAP_NAME, capClass } from '../core/capclass.js';
import { newsCounts } from '../strategies/news.js';
import { marginOfSafety } from '../core/mos.js';
import { factsFor, tradeSignal } from './signals.js';

const BUY_SETUP = 2, AVOID_AT = -2, MOS_MIN = 10, SCORE_MIN = 5;
// Next-week checks (v1.287). Two are gates that stop a Buy outright: a weekly or monthly MACD below its signal line, and results due within RESULTS_DAYS
// days (an earnings gap decides the week, whatever the chart says). Two add or take away a setup point: very thin trading (average daily traded value
// under THIN_LAKH lakh rupees) and the stock's own recent news. A stretched RSI is deliberately NOT penalised: replayed over 10 years of weekly bars, stocks
// with both MACDs bullish did no worse above RSI 75 than below it. Thin stocks did worse (51% beat the middle stock, against 49% when thin).
const RESULTS_DAYS = 7, THIN_LAKH = 50, NEWS_MIN = 2;
const VERDICT_PTS = { buy: 2, mbuy: 1, hold: -1, avoid: -2 };
const VERDICT_NAME = { buy: 'Strong', mbuy: 'Good', hold: 'Hold', avoid: 'Avoid' };

// Quality points and the reasons for them, from the facts factsFor returns.
function qualityOf(f){
  let pts = 0;
  const why = [];
  const add = (n, text) => { pts += n; why.push(text); };
  if(f.verdict && VERDICT_PTS[f.verdict] != null) add(VERDICT_PTS[f.verdict], 'Verdict ' + VERDICT_NAME[f.verdict]);
  const mos = marginOfSafety(f.intrinsic, f.price);
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

// Trend, event and trading checks for a stock you do not hold: { blocks: [reasons a Buy is held back], adj: setup points added or taken away,
// notes: reasons for the points, cap: 'large' | 'mid' | 'small' | null, resultsIn: days until results or null }. `today` is YYYY-MM-DD in India.
// A figure the stock has not been refreshed for yet (MACD levels, results date, market cap, news) never blocks and never scores.
function outlookOf(stock, today){
  const raw = (stock && stock.technical && stock.technical.raw) || {};
  const blocks = [], notes = [];
  let adj = 0;
  const below = (lvl, sig) => (typeof lvl === 'number' && typeof sig === 'number' ? lvl < sig : null);
  if(below(raw.weekMacdLevel, raw.weekMacdSignal)) blocks.push('weekly MACD is below its signal line');
  if(below(raw.monthMacdLevel, raw.monthMacdSignal)) blocks.push('monthly MACD is below its signal line');
  const lq = (stock && stock.liquidity) || {};
  const resultsIn = today ? daysUntil(lq.nextResults, today) : null;
  if(resultsIn != null && resultsIn <= RESULTS_DAYS) blocks.push('results due ' + (resultsIn === 0 ? 'today' : 'in ' + resultsIn + ' day' + (resultsIn === 1 ? '' : 's')) + ' (' + lq.nextResults + ')');
  const px = stock && stock.valuation && stock.valuation.currentPrice;
  if(typeof lq.avgVolume === 'number' && typeof px === 'number' && (lq.avgVolume * px) / 100000 < THIN_LAKH){ adj -= 1; notes.push('thin trading (under \u20b9' + THIN_LAKH + ' lakh a day)'); }
  const n = stock ? newsCounts(stock) : null;
  if(n && n.neg >= NEWS_MIN && n.neg > n.pos){ adj -= 1; notes.push('recent news leans negative (' + n.neg + ' negative, ' + n.pos + ' positive)'); }
  else if(n && n.pos >= NEWS_MIN && n.pos > n.neg){ adj += 1; notes.push('recent news leans positive (' + n.pos + ' positive, ' + n.neg + ' negative)'); }
  return { blocks, adj, notes, cap: capClass(lq.marketCap), resultsIn };
}

// The call for one stock. `trade` is the open trade in it, or null; `setup` is swingSetup's reading for the stock (null without weekly bars).
function ideaCall(stock, trade, setup, today){
  const f = factsFor(trade || {}, stock);
  const q = qualityOf(f);
  const s = setup || null;
  const o = outlookOf(stock, today), adj = trade ? 0 : o.adj;   // a stock you hold keeps its trade call: the checks only judge a new Buy
  const base = { pts: q.pts, mos: q.mos, adj, cap: o.cap, rankSetup: s ? s.pts + adj : null, setup: s ? s.pts : null, of: s ? s.of : null, chance: s ? s.chance : null, touch: s ? s.touch : null, fromHigh: s ? s.fromHigh : null };
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
  else if(q.worth && s && s.pts + o.adj >= BUY_SETUP && weekMacd !== 'bear_below' && !o.blocks.length) call = 'buy';
  if(call !== 'sell'){
    if(!q.worth) reasons.push('not yet worth owning (needs a Strong or Good verdict, margin of safety ' + MOS_MIN + '%+, Fundamental score ' + SCORE_MIN + '+)');
    if(s) reasons.push('setup ' + s.pts + '/' + s.of + ': ' + (s.hits.length ? s.hits.join(', ') : 'no timing signal') + (call === 'buy' ? '' : (s.misses.length ? '; missing: ' + s.misses.join(', ') : '')));
    else if(q.worth) reasons.push('no weekly price history yet, so the timing cannot be judged');
    if(q.worth && s && s.pts >= BUY_SETUP && weekMacd === 'bear_below') reasons.push('weekly MACD is bearish below zero');
    if(q.worth && s && s.pts + o.adj >= BUY_SETUP && weekMacd !== 'bear_below') o.blocks.forEach(b => reasons.push('held back: ' + b));
  }
  if(call !== 'sell') o.notes.forEach(x => reasons.push(x));
  if(o.cap) reasons.push(CAP_NAME[o.cap]);
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
    const ra = typeof A.rankSetup === 'number' ? A.rankSetup : n(A.setup), rb = typeof B.rankSetup === 'number' ? B.rankSetup : n(B.setup);
    return rb - ra || n(B.setup) - n(A.setup) || B.pts - A.pts || n(B.fromHigh) - n(A.fromHigh) || (a.s.name || '').localeCompare(b.s.name || '');
  });
}

export { RESULTS_DAYS, THIN_LAKH, ideaCall, rankIdeas };
