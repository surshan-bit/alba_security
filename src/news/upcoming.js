// Upcoming events of one stock, read from the saved news/events list (see store.js): the small calendar mark beside a stock's name
// in the grids, and the list on the stock page.
import { tickerSymbol } from '../core/util.js';
import { news } from './store.js';
import { shortDate, typeTag, upcomingItems } from './model.js';

const IST_MS = 19800000;
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const MARK_DAYS = 30;   // a stock is marked when something happens within this many days

let cacheFor = null, cacheDay = '', byTicker = new Map();
// ticker -> its upcoming items (soonest first); rebuilt only when the saved list or the day changes.
function index(){
  const today = todayIst(), ev = news.events;
  if(cacheFor !== ev || cacheDay !== today){
    byTicker = new Map();
    upcomingItems(ev && Array.isArray(ev.items) ? ev.items : [], today).forEach(x => { if(!byTicker.has(x.ticker)) byTicker.set(x.ticker, []); byTicker.get(x.ticker).push(x); });
    cacheFor = ev; cacheDay = today;
  }
  return byTicker;
}
const upcomingFor = (s) => index().get(tickerSymbol(s)) || [];
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const CAL = '<svg class="ev-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path></svg>';
const esc = (v) => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The mark for a grid row: a small calendar whose tooltip lists the events in the next 30 days; '' when there are none.
function eventMark(s){
  const limit = addDays(todayIst(), MARK_DAYS), soon = upcomingFor(s).filter(x => x.date <= limit);
  if(!soon.length) return '';
  const tip = soon.slice(0, 4).map(x => shortDate(x.date) + ' ' + typeTag(x.type).toLowerCase()).join(', ');
  return `<span class="ev-mark" title="Coming up: ${esc(tip)}" aria-label="Coming up: ${esc(tip)}">${CAL}</span>`;
}

export { eventMark, upcomingFor };
