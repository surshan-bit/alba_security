// Dated events drawn as tags under the weekly and monthly price charts: news, results, corporate events,
// your own trades and the day research was saved. News, results and corporate events are read from TradingView by
// Refresh Fundamental Info and kept on the stock (s.__events); trades come from the Trade Log.
import { allTrades } from '../core/store.js';
import { tickerSymbol } from '../core/util.js';
import { stockResearchAsof } from '../research/status.js';

const IST = 19800;
// One lane (row of tags) per group, in this order. `glyph` is the letter or symbol drawn inside the tag.
const EVENT_GROUPS = [
  { id: 'news', label: 'News', glyph: '⚡' },
  { id: 'earn', label: 'Results', glyph: 'E' },
  { id: 'corp', label: 'Company event', glyph: 'C' },
  { id: 'trade', label: 'Your trades', glyph: 'T' },
  { id: 'res', label: 'Research saved', glyph: 'R' }
];
const GROUP_OF = { news: 'news', earn: 'earn', corp: 'corp', buy: 'trade', sell: 'trade', res: 'res' };
const GLYPH_OF = { buy: 'B', sell: 'S' };

// "YYYY-MM-DD" (or an ISO time) to unix seconds at midnight IST; null when it is not a date.
function eventTime(d){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 - IST : null;
}

// Every dated event known for a stock: { t, d, k, group, glyph, text, src, url }, oldest first.
function stockChartEvents(s){
  const out = [];
  const add = (k, d, text, src, url, sentiment) => {
    const t = eventTime(d);
    if(t === null || !text) return;
    out.push({ t, d: String(d).slice(0, 10), k, group: GROUP_OF[k], glyph: GLYPH_OF[k] || '', text: String(text), src: src || '', url: url || '', s: sentiment || '' });
  };
  (Array.isArray(s.__events) ? s.__events : []).forEach(e => { if(e && GROUP_OF[e.k]) add(e.k, e.d, e.t, e.src, e.url, e.s); });
  const sym = tickerSymbol(s);
  allTrades().forEach(tr => {
    if(!tr || tr.ticker !== sym) return;
    if(tr.buy && tr.buy.date) add('buy', tr.buy.date, 'Bought' + (tr.buy.quantity != null ? ' ' + tr.buy.quantity : '') + (tr.buy.price != null ? ' at ₹' + tr.buy.price : ''), 'Trade Log', '');
    if(tr.status === 'closed' && tr.sell && tr.sell.date) add('sell', tr.sell.date, 'Sold' + (tr.sell.price != null ? ' at ₹' + tr.sell.price : ''), 'Trade Log', '');
  });
  const ra = stockResearchAsof(s);
  if(ra) add('res', ra, 'Research saved', 'Refresh Fundamental Info', '');
  return out.sort((a, b) => a.t - b.t);
}

// Index of the bar that contains time t (bars are [start, ...] ascending), or -1 when t falls outside the bars.
function barIndexFor(bars, t, lastSpan){
  if(!bars.length || t < bars[0][0] || t >= bars[bars.length - 1][0] + lastSpan) return -1;
  let lo = 0, hi = bars.length - 1;
  while(lo < hi){ const mid = (lo + hi + 1) >> 1; if(bars[mid][0] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

// Events of the groups in `shown`, keyed by bar index.
function eventsByBar(events, bars, lastSpan, shown){
  const map = new Map();
  events.forEach(e => {
    if(!shown.has(e.group)) return;
    const i = barIndexFor(bars, e.t, lastSpan);
    if(i < 0) return;
    if(!map.has(i)) map.set(i, []);
    map.get(i).push(e);
  });
  return map;
}

// Price move around a bar: that bar's close against the previous close, and the next bar's close against that bar's close (null when unknown).
function barReaction(bars, i){
  const b = bars[i]; if(!b) return null;
  const prev = i > 0 ? bars[i - 1][4] : b[1];
  const next = i + 1 < bars.length ? bars[i + 1] : null;
  return { same: prev ? (b[4] / prev - 1) * 100 : null, next: next && b[4] ? (next[4] / b[4] - 1) * 100 : null };
}
export { EVENT_GROUPS, barReaction, eventTime, eventsByBar, stockChartEvents };
