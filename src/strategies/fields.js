// The things a strategy rule can look at. Each field says how to read its value from a stock, how to show it, and
// whether it comes from price bars alone (`priceBased`). Price-based rules can be replayed on old bars later; the
// others read today's stored fundamentals, so a backtest using them would look ahead.
import { verdictLabel } from '../core/stocks.js';
import { MACD_CROSS_DAILY, MACD_CROSS_WEEKLY, techScore3 } from '../engine/technical.js';
import { isPinned } from '../core/pins.js';
import { daysSinceDate, daysUntil, tickerIndustry } from '../core/util.js';
import { mosPct, mosRatingAny } from '../list/metrics.js';
import { stockResearchAgeDays } from '../research/status.js';
import { NEWS_DAYS, daysSinceEvent, newsCounts } from './news.js';
import { MCAP_LARGE_CR, MCAP_MID_CR, capClass } from '../core/capclass.js';

const rawOf = (s) => (s.technical && s.technical.raw) || {};
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const factorScore = (key) => (s) => {
  const f = s.fundamentals && s.fundamentals.factors ? s.fundamentals.factors.find(x => x.key === key) : null;
  return f && f.weight ? num((f.score / f.weight) * 10) : null;
};
// Named as in the W Tech Rating / M Tech Rating columns of the tables (the rating is the MACD state underneath).
const MACD_OPTIONS = [
  ['bull_above', 'Bullish', 'buy'],
  ['bull_below', 'Turning Up', 'mbuy'],
  ['bear_above', 'Weakening', 'hold'],
  ['bear_below', 'Bearish', 'avoid']
];
// Each option may carry a third value, its colour tone, used by the rule editor's tags (buy, mbuy, hold, avoid, orange, accent; none = no tone).
// A stock with no rating (too little price history, or prices not loaded yet) can be allowed through by choosing this.
const NONE_LABEL = 'None (no rating)';
// Weekly MACD 30/60/5 against its signal line. The three states are exclusive; pick two to combine them (e.g. above + just crossed up).
const { fast: MACD_FAST, slow: MACD_SLOW, signal: MACD_SIGNAL, within: MACD_WITHIN } = MACD_CROSS_WEEKLY;
const MACD_CROSS_OPTIONS = [
  ['cross_up', `Just crossed up (${MACD_WITHIN === 1 ? 'this week' : `last ${MACD_WITHIN} weeks`})`, 'mbuy'],
  ['above', 'Above signal', 'buy'],
  ['below', 'Below signal', 'avoid']
];
// The same three choices for the daily MACD, read by the daily import of Refresh all stocks for one strategy's stocks (src/refresh/dailymacd.js). A reading older than
// DAILY_FRESH_DAYS (a long weekend) counts as missing, so a rule never rests on days-old data without saying so.
const { fast: DAY_FAST, slow: DAY_SLOW, signal: DAY_SIGNAL } = MACD_CROSS_DAILY;
const DAILY_FRESH_DAYS = 4;
const MACD_DAILY_OPTIONS = [
  ['cross_up', 'Just crossed up (latest day)', 'mbuy'],
  ['above', 'Above signal', 'buy'],
  ['below', 'Below signal', 'avoid']
];
const macdState = (key) => (s) => (s.technical && s.technical.states && s.technical.states[key]) || null;

const dayMacdState = (s) => { const age = daysSinceDate(rawOf(s).dayMacdAsof); return age !== null && age <= DAILY_FRESH_DAYS ? macdState('dayMacd3060')(s) : null; };

const ALL_FIELDS = [
  { id: 'score', group: 'Fundamental', label: 'Fundamental score', type: 'num', unit: '/10', dp: 1, get: (s) => num(s.score) },
  { id: 'verdict', group: 'Fundamental', label: 'Verdict', type: 'enum', get: (s) => s.verdict || null,
    options: ['buy', 'mbuy', 'hold', 'avoid'].map(k => [k, verdictLabel[k], k]) },
  { id: 'mos', group: 'Fundamental', label: 'MoS % (margin of safety)', type: 'num', unit: '%', dp: 0, get: (s) => { const m = mosPct(s); return isFinite(m) ? m : null; } },
  { id: 'mosRating', group: 'Fundamental', label: 'MoS rating (Green, Orange, Red)', type: 'enum', get: (s) => mosRatingAny(s),
    options: [['green', 'Green (0% or more)', 'buy'], ['orange', 'Orange (0 to -25%)', 'orange'], ['red', 'Red (below -25%)', 'avoid']] },
  { id: 'fin', group: 'Fundamental factors (0-10)', label: 'Financial health', type: 'num', unit: '/10', dp: 1, get: factorScore('fin') },
  { id: 'prof', group: 'Fundamental factors (0-10)', label: 'Profitability', type: 'num', unit: '/10', dp: 1, get: factorScore('prof') },
  { id: 'growth', group: 'Fundamental factors (0-10)', label: 'Growth', type: 'num', unit: '/10', dp: 1, get: factorScore('growth') },
  { id: 'val', group: 'Fundamental factors (0-10)', label: 'Valuation vs industry', type: 'num', unit: '/10', dp: 1, get: factorScore('val') },
  { id: 'moat', group: 'Fundamental factors (0-10)', label: 'Moat', type: 'num', unit: '/10', dp: 1, get: factorScore('moat') },
  { id: 'gov', group: 'Fundamental factors (0-10)', label: 'Governance', type: 'num', unit: '/10', dp: 1, get: factorScore('gov') },
  { id: 'predict', group: 'Fundamental factors (0-10)', label: 'Earnings predictability', type: 'num', unit: '/10', dp: 1, get: factorScore('predict') },
  { id: 'reinvest', group: 'Fundamental factors (0-10)', label: 'Reinvestment efficiency', type: 'num', unit: '/10', dp: 1, get: factorScore('reinvest') },
  { id: 'dcf', group: 'Fundamental factors (0-10)', label: 'Margin-of-safety factor', type: 'num', unit: '/10', dp: 1, get: factorScore('dcf') },
  { id: 'promoterHolding', group: 'Holdings and returns', label: 'Promoter holding %', type: 'num', unit: '%', dp: 2, get: (s) => num(s.valuation && s.valuation.promoterHolding) },
  { id: 'fiiHolding', group: 'Holdings and returns', label: 'FII holding %', type: 'num', unit: '%', dp: 2, get: (s) => num(s.valuation && s.valuation.fiiHolding) },
  { id: 'fiiChange', group: 'Holdings and returns', label: 'FII holding change last quarter (points)', type: 'num', unit: '', dp: 2, get: (s) => num(s.valuation && s.valuation.fiiChange) },
  { id: 'fiiChange3', group: 'Holdings and returns', label: 'FII holding change over 3 years (points)', type: 'num', unit: '', dp: 2, get: (s) => num(s.valuation && s.valuation.fiiChange3) },
  { id: 'diiChange3', group: 'Holdings and returns', label: 'DII holding change over 3 years (points)', type: 'num', unit: '', dp: 2, get: (s) => num(s.valuation && s.valuation.diiChange3) },
  { id: 'ret1y', group: 'Holdings and returns', label: 'Return over 1 year %', type: 'num', unit: '%', dp: 1, get: (s) => num(s.valuation && s.valuation.ret1y) },
  { id: 'ret3y', group: 'Holdings and returns', label: 'Return over 3 years %', type: 'num', unit: '%', dp: 1, get: (s) => num(s.valuation && s.valuation.ret3y) },
  { id: 'ret5y', group: 'Holdings and returns', label: 'Return over 5 years %', type: 'num', unit: '%', dp: 1, get: (s) => num(s.valuation && s.valuation.ret5y) },
  { id: 'weekRsi', group: 'Technical', label: 'W RSI', type: 'num', unit: '', dp: 1, priceBased: true, get: (s) => num(rawOf(s).weekRsi) },
  { id: 'monthRsi', group: 'Technical', label: 'M RSI', type: 'num', unit: '', dp: 1, priceBased: true, get: (s) => num(rawOf(s).monthRsi) },
  { id: 'weekMacd', group: 'Technical', label: 'W Tech Rating', type: 'enum', priceBased: true, get: macdState('weekMacd'), options: MACD_OPTIONS, noneLabel: NONE_LABEL },
  // Not priceBased: the learning search has no menu for it, so applying a suggestion must not drop a rule the user chose by hand.
  { id: 'weekMacd3060', group: 'Technical', label: `W MACD ${MACD_FAST}/${MACD_SLOW}/${MACD_SIGNAL} vs signal`, type: 'enum', get: macdState('weekMacd3060'), options: MACD_CROSS_OPTIONS, noneLabel: NONE_LABEL },
  // Not priceBased, for the same reason as the weekly one. Only the stocks of the strategy chosen for the daily import have a reading.
  { id: 'dayMacd3060', group: 'Technical', label: `D MACD ${DAY_FAST}/${DAY_SLOW}/${DAY_SIGNAL} vs signal`, type: 'enum', get: dayMacdState, options: MACD_DAILY_OPTIONS, noneLabel: NONE_LABEL },
  { id: 'monthMacd', group: 'Technical', label: 'M Tech Rating', type: 'enum', priceBased: true, get: macdState('monthMacd'), options: MACD_OPTIONS, noneLabel: NONE_LABEL },
  { id: 'weekPct', group: 'Technical', label: 'Weekly % change', type: 'num', unit: '%', dp: 1, priceBased: true, get: (s) => num(rawOf(s).weekPctChange) },
  { id: 'monthPct', group: 'Technical', label: 'Monthly % change', type: 'num', unit: '%', dp: 1, priceBased: true, get: (s) => num(rawOf(s).monthPctChange) },
  { id: 'techScore', group: 'Technical', label: 'Technical score', type: 'num', unit: '/10', dp: 1, get: (s) => num(s.technical && s.technical.score) },
  { id: 'techScore2', group: 'Technical', label: 'Technical score 2', hidden: true, type: 'num', unit: '/10', dp: 1, get: (s) => num(s.technical2 && s.technical2.score) },
  { id: 'techScore3', group: 'Technical', label: 'Technical score 3', hidden: true, type: 'num', unit: '/10', dp: 1, get: (s) => num(techScore3(s.technical)) },
  { id: 'newsPos', group: 'News and events', label: `Positive news items (last ${NEWS_DAYS} days)`, type: 'num', unit: '', dp: 0, get: (s) => { const c = newsCounts(s); return c ? c.pos : null; } },
  { id: 'newsNeg', group: 'News and events', label: `Negative news items (last ${NEWS_DAYS} days)`, type: 'num', unit: '', dp: 0, get: (s) => { const c = newsCounts(s); return c ? c.neg : null; } },
  { id: 'newsAll', group: 'News and events', label: `All news items (last ${NEWS_DAYS} days)`, type: 'num', unit: '', dp: 0, get: (s) => { const c = newsCounts(s); return c ? c.total : null; } },
  { id: 'resultsAge', group: 'News and events', label: 'Days since latest results', type: 'num', unit: ' days', dp: 0, get: (s) => daysSinceEvent(s, 'earn') },
  { id: 'resultsIn', group: 'News and events', label: 'Days until next results (TradingView date)', type: 'num', unit: ' days', dp: 0, get: (s) => daysUntil(s.liquidity && s.liquidity.nextResults) },
  { id: 'corpAge', group: 'News and events', label: 'Days since latest company event', type: 'num', unit: ' days', dp: 0, get: (s) => daysSinceEvent(s, 'corp') },
  { id: 'avgTraded', group: 'Liquidity (risk of low trading)', label: 'Average daily traded value (30 days, ₹ lakh)', type: 'num', unit: ' lakh', dp: 1,
    get: (s) => { const v = s.liquidity && num(s.liquidity.avgVolume), p = num(s.valuation && s.valuation.currentPrice); return v != null && p != null ? (v * p) / 100000 : null; } },
  { id: 'avgVolume', group: 'Liquidity (risk of low trading)', label: 'Average daily volume (30 days, shares)', type: 'num', unit: ' shares', dp: 0, get: (s) => num(s.liquidity && s.liquidity.avgVolume) },
  { id: 'marketCap', group: 'Size (market capitalisation)', label: 'Market cap (₹ crore)', type: 'num', unit: ' Cr', dp: 0, get: (s) => num(s.liquidity && s.liquidity.marketCap) },
  { id: 'capClass', group: 'Size (market capitalisation)', label: 'Cap class (Large, Mid, Small)', type: 'enum', get: (s) => capClass(num(s.liquidity && s.liquidity.marketCap)),
    options: [['large', `Large cap (₹${MCAP_LARGE_CR.toLocaleString('en-IN')} Cr or more)`, 'buy'], ['mid', `Mid cap (₹${MCAP_MID_CR.toLocaleString('en-IN')} to ${MCAP_LARGE_CR.toLocaleString('en-IN')} Cr)`, 'accent'], ['small', `Small cap (below ₹${MCAP_MID_CR.toLocaleString('en-IN')} Cr)`, 'orange']] },
  { id: 'price', group: 'Other', label: 'Price', type: 'num', unit: '', dp: 2, priceBased: true, get: (s) => num(s.valuation && s.valuation.currentPrice) },
  { id: 'researchAge', group: 'Other', label: 'Days since Fundamental refresh', type: 'num', unit: ' days', dp: 0, get: (s) => stockResearchAgeDays(s) },
  { id: 'pinned', group: 'Other', label: 'Pinned', type: 'enum', get: (s) => (isPinned(s) ? 'yes' : 'no'), options: [['yes', 'Pinned', 'accent'], ['no', 'Not pinned']] },
  { id: 'industry', group: 'Other', label: 'Industry', type: 'text', get: (s) => { const i = tickerIndustry(s); return i === '—' ? null : i; } }
];
// Fields marked hidden (Tech 2 and Tech 3, hidden from every screen in v1.261) are not offered in the rule picker or the learning, but stay in FIELD_BY_ID so a strategy saved earlier with such a rule still reads and applies.
const FIELDS = ALL_FIELDS.filter(f => !f.hidden);
const FIELD_BY_ID = new Map(ALL_FIELDS.map(f => [f.id, f]));

export { FIELDS, FIELD_BY_ID };
