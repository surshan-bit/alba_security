// Business page numbers: how each industry has moved over a period, and the news of its stocks.
// Pure functions of the stock list (and the price bars handed in), so they are easy to test.
import { tickerIndustry } from '../core/util.js';
import { eventMs } from '../strategies/news.js';

const DAY = 86400;
// days: how far back the period reaches. bars: weekly price bars are needed for everything longer than a month.
const PERIODS = [
  { key: '1W', label: '1 week', days: 7 },
  { key: '1M', label: '1 month', days: 30 },
  { key: '3M', label: '3 months', days: 91 },
  { key: '6M', label: '6 months', days: 182 },
  { key: '1Y', label: '1 year', days: 365 }
];
const periodOf = (key) => PERIODS.find(p => p.key === key) || PERIODS[1];
const needsBars = (key) => key !== '1W' && key !== '1M';

// A stock's % change over the period, or null when it is not known.
// 1W and 1M are the figures saved with the stock; longer periods come from its weekly bars [t, o, h, l, c, v].
function stockChange(s, key, weeklyBars){
  if(key === '1W' || key === '1M'){
    const raw = s.technical && s.technical.raw, v = raw ? (key === '1W' ? raw.weekPctChange : raw.monthPctChange) : null;
    return Number.isFinite(v) ? v : null;
  }
  const bars = weeklyBars;
  if(!Array.isArray(bars) || bars.length < 2) return null;
  const last = bars[bars.length - 1], target = last[0] - periodOf(key).days * DAY;
  let base = null;
  for(let i = bars.length - 2; i >= 0; i--){ if(bars[i][0] <= target){ base = bars[i]; break; } }
  if(!base || !(base[4] > 0) || !(last[4] > 0)) return null;
  return (last[4] / base[4] - 1) * 100;
}

const median = (xs) => { const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

function newsOf(s, days, now){
  const out = [];
  (Array.isArray(s.__events) ? s.__events : []).forEach(e => {
    if(!e || e.k !== 'news') return;
    const ms = eventMs(e.d);
    if(ms === null || now - ms > days * DAY * 1000 || ms - now > DAY * 1000) return;
    out.push({ d: e.d, t: e.t, src: e.src || '', url: e.url || '', s: e.s || '', stock: s.name, ticker: s.ticker.split(' · ')[0] });
  });
  return out;
}

// One row per industry. by: 'industry' (the fine label) or 'group' (the wider Industry Group).
// barsFor(stock) returns that stock's weekly bars (or undefined).
// matchSet (optional): the stocks that pass the Analysis filters. They are counted and averaged on their own and listed
// first within the industry, but nothing is removed: the industry's own figures still cover all of its stocks.
function industryTable(stocks, { by = 'industry', period = '1M', barsFor = /** @type {(s: any) => any} */ (() => undefined), now = Date.now(), matchSet = null } = {}){
  const days = periodOf(period).days, groups = new Map();
  stocks.forEach(s => {
    const name = by === 'group' ? (s.industryGroup || '—') : tickerIndustry(s);
    if(!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  });
  const rows = [];
  groups.forEach((members, name) => {
    const items = members.map(s => ({ stock: s, change: stockChange(s, period, barsFor(s)), match: !!matchSet && matchSet.has(s) }));
    const known = items.filter(x => x.change !== null);
    const changes = known.map(x => x.change);
    const matchChanges = known.filter(x => x.match).map(x => x.change);
    const news = [].concat(...members.map(s => newsOf(s, days, now))).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    rows.push({
      name, count: members.length, known: known.length,
      mean: changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null,
      median: changes.length ? median(changes) : null,
      up: changes.filter(c => c > 0).length, down: changes.filter(c => c < 0).length,
      matches: items.filter(x => x.match).length,
      matchMean: matchChanges.length ? matchChanges.reduce((a, b) => a + b, 0) / matchChanges.length : null,
      items: items.sort((a, b) => (b.match ? 1 : 0) - (a.match ? 1 : 0) || (b.change === null ? -Infinity : b.change) - (a.change === null ? -Infinity : a.change)),
      news, pos: news.filter(n => n.s === 'pos').length, neg: news.filter(n => n.s === 'neg').length
    });
  });
  rows.sort((a, b) => (b.mean === null ? -Infinity : b.mean) - (a.mean === null ? -Infinity : a.mean) || a.name.localeCompare(b.name));
  return rows;
}

export { PERIODS, industryTable, needsBars, periodOf };
