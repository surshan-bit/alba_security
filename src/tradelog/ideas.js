// Buy / Sell ideas panel (Trade Log): pick a strategy, see the stocks that qualify today ranked by Buy / Hold / Sell call (rules in ideacall.js).
import { keepScroll } from '../ui/scrollkeep.js';
import { stockByTickerSymbolAny, stocks } from '../core/stocks.js';
import { allTrades } from '../core/store.js';
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { publishedStrategies } from '../strategies/state.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { ensurePriceBars, pcTickerKey, priceHistoryByTicker, priceLoaded } from '../prices/store.js';
import { tvIstDate } from '../tv/connector.js';
import { AVOID_BOTTOM, BUY_TOP, RESULTS_DAYS, THIN_LAKH, ideaCall, rankIdeas, topBuys } from './ideacall.js';
import { CAP_NAME } from '../core/capclass.js';
import { BASE_UP, nextWeekRead, rankReads } from './nextweek.js';
import { compareBy, nextSort, sortHeaderHtml } from '../analysis/columns.js';

const MAX_ROWS = 50, TOP_N = 5;
function openTradeByStock(){
  const m = new Map();
  for(const t of allTrades()){
    if(t.status === 'closed' && t.sell) continue;
    const s = stockByTickerSymbolAny.get(t.ticker);
    if(s && !m.has(s)) m.set(s, t);
  }
  return m;
}
function ideasFor(strategyId){
  const st = publishedStrategies().find(x => x.id === strategyId);
  if(!st) return null;
  const held = openTradeByStock();
  const today = tvIstDate();
  const list = qualifyingStocks(stocks, st.rules);
  const reads = rankReads(list.map(s => { const bars = priceHistoryByTicker[pcTickerKey(s)]; return bars && bars['1W'] ? nextWeekRead(bars['1W'], today) : null; }));
  return rankIdeas(list.map((s, i) => ({ s, c: ideaCall(s, held.get(s) || null, reads[i], today) })));
}

let sid = '', filter = 'all';
// The ideas come ranked by call (Buy first); a click on a column header sorts by that column instead, and a click on the same header again reverses it.
let ideasSort = { col: '', dir: 'desc' };
const CALL_ORDER = { buy: 3, hold: 2, sell: 1 };
const IDEA_SORT = {
  name: (x) => String(x.s.name || tickerSymbol(x.s)).toLowerCase(),
  call: (x) => CALL_ORDER[x.c.call] || 0,
  score: (x) => x.c.p == null ? null : x.c.p,
  chance: (x) => x.c.up == null ? null : x.c.up,
  price: (x) => { const p = x.s.valuation && x.s.valuation.currentPrice; return p == null ? null : p; },
  mos: (x) => x.c.mos == null ? null : x.c.mos
};
try { sid = localStorage.getItem('albaDashboard.ideasStrategy.v1') || ''; } catch(e){ /* default */ }
// The timing check reads weekly bars, so the bars of the stocks in the chosen strategy (and only those) are loaded, a few at a
// time. A stock is tried once per visit, so a failed read does not retry on every redraw.
const BARS_PARALLEL = 6;
const barsTried = new Set();
let barsBusy = false, barsDone = 0, barsTotal = 0;
function loadBars(){
  if(barsBusy) return;
  const st = publishedStrategies().find(x => x.id === sid);
  if(!st) return;
  const need = qualifyingStocks(stocks, st.rules).filter(s => !priceLoaded.has(pcTickerKey(s)) && !barsTried.has(pcTickerKey(s)));
  if(!need.length) return;
  barsBusy = true; barsDone = 0; barsTotal = need.length;
  let next = 0;
  const worker = async () => {
    while(next < need.length){
      const s = need[next++]; barsTried.add(pcTickerKey(s));
      try { await ensurePriceBars(s); } catch(e){ console.error('Price history unavailable', e); }
      barsDone++;
      if(barsDone % 10 === 0 && barsDone < barsTotal) refreshIdeasBody();
    }
  };
  Promise.all(Array.from({ length: Math.min(BARS_PARALLEL, need.length) }, worker)).then(() => { barsBusy = false; refreshIdeasBody(); });
}
const remember = () => { try { localStorage.setItem('albaDashboard.ideasStrategy.v1', sid); } catch(e){ /* kept for this visit */ } };

function rowHtml(x, rank){
  const { s, c } = x, idx = stocks.indexOf(s), price = s.valuation && s.valuation.currentPrice;
  return `<tr>
    <td class="num">${rank}</td>
    <td><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.cap ? ' &middot; ' + CAP_NAME[c.cap] : ''}${c.held ? ' &middot; held' : ''}</span></td>
    <td><span class="tl-signal-badge tl-idea-${c.call}">${escapeHtml(c.label)}</span></td>
    <td class="num" title="Where its next-week score ranks among the stocks of this strategy today">${c.topPct != null ? 'Top ' + c.topPct + '%' : '&mdash;'}</td>
    <td class="num" title="${c.up != null ? 'In the five-year tests, stocks that ranked like this each week closed higher in ' + c.up + '% of weeks, and beat the median stock in ' + c.beat + '% of weeks. All stocks closed higher in ' + BASE_UP + '% of weeks.' : ''}">${c.up != null ? '~' + Math.round(c.up) + '%' : '&mdash;'}</td>
    <td class="num">${price != null ? '&#8377;' + Number(price).toLocaleString('en-IN') : '&mdash;'}</td>
    <td class="num">${c.mos != null ? (c.mos >= 0 ? '+' : '') + c.mos.toFixed(1) + '%' : '&mdash;'}</td>
    <td class="tl-idea-why">${escapeHtml(c.reasons.join('; '))}</td></tr>`;
}
// The five best Buy calls among the stocks you do not hold, above the full list. A Buy that rests on a Hold verdict plus a strong chart is labelled as such.
function topHtml(list){
  const top = topBuys(list, TOP_N);
  if(!top.length) return '<div class="tl-top5"><div class="tl-top5-title">Top ' + TOP_N + ' likely to rise next week</div><p class="upload-hint">No stock in this strategy is a Buy today.</p></div>';
  const item = (x, i) => {
    const { s, c } = x, idx = stocks.indexOf(s), price = s.valuation && s.valuation.currentPrice;
    return `<li><span class="tl-top5-rank">${i + 1}</span><div><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.cap ? ' &middot; ' + CAP_NAME[c.cap] : ''}</span>
      <div class="tl-top5-meta">Top ${c.topPct}% next-week score &middot; rose ~${Math.round(c.up)}% of weeks in tests${c.mos != null ? ' &middot; MoS ' + (c.mos >= 0 ? '+' : '') + c.mos.toFixed(1) + '%' : ''}${price != null ? ' &middot; &#8377;' + Number(price).toLocaleString('en-IN') : ''}</div>
      <div class="tl-idea-why">${escapeHtml(c.reasons.join('; '))}</div></div></li>`;
  };
  return `<div class="tl-top5"><div class="tl-top5-title">Top ${TOP_N} likely to rise next week</div><ol>${top.map(item).join('')}</ol></div>`;
}
function bodyHtml(){
  if(sid) loadBars();
  const list = sid ? ideasFor(sid) : null;
  if(!sid) return '<p class="upload-hint">Choose a strategy to see the stocks that qualify today, ranked by Buy or Sell call.</p>';
  if(!list) return '<p class="upload-hint">That strategy is no longer available. Choose another.</p>';
  if(!list.length) return '<p class="upload-hint">No stock qualifies for this strategy today.</p>';
  const n = k => list.filter(x => x.c.call === k).length;
  const th = (id, label) => sortHeaderHtml(id, label, ideasSort);
  const filtered = list.filter(x => filter === 'all' || x.c.call === filter);
  const shown = ideasSort.col ? filtered.slice().sort(compareBy(IDEA_SORT[ideasSort.col], ideasSort.dir)) : filtered;
  const chip = (k, label) => `<button type="button" class="tl-view-btn${filter === k ? ' active' : ''}" data-idea-filter="${k}">${label}</button>`;
  return `${topHtml(list)}<div class="tl-ideas-bar"><div class="tl-view-toggle" role="group" aria-label="Call filter">${chip('all', 'All ' + list.length)}${chip('buy', 'Buy ' + n('buy'))}${chip('hold', 'Hold ' + n('hold'))}${chip('sell', 'Sell ' + n('sell'))}</div></div>
    <div class="help-table-wrap"><table class="help-table"><thead><tr><th>#</th>${th('name', 'Stock')}${th('call', "Today's call")}${th('score', 'Next-week score')}${th('chance', 'Rose in tests')}${th('price', 'Price')}${th('mos', 'MoS')}<th>Why</th></tr></thead>
    <tbody>${shown.slice(0, MAX_ROWS).map((x, i) => rowHtml(x, i + 1)).join('')}</tbody></table></div>
    <p class="upload-hint">${barsBusy ? 'Loading weekly price history for the timing check (' + barsDone + ' of ' + barsTotal + ')&hellip; ' : ''}The score comes from a model trained and tested week by week on five years of weekly prices (about 297,000 stock-weeks): it rates how likely a stock is to beat the median stock next week. <b>Next-week score</b> shows where a stock ranks among this strategy&rsquo;s stocks today (the raw score moves with the whole market, the ranking does not). <b>Rose in tests</b> is how often stocks that ranked like this each week closed higher in a week in those tests; all stocks did so ${BASE_UP}% of the time. Buy is a stock in the top ${BUY_TOP}% of scores; Avoid is the bottom ${AVOID_BOTTOM}%. A Buy is held back (Wait) when results are due within ${RESULTS_DAYS} days, when trading is very thin (under &#8377;${THIN_LAKH} lakh a day) or when recent news clearly leans negative. The edge is real but modest (the best five each week rose about 55% of the time in the tests, against 48% for all), and it cannot see the market: in a week when most stocks fall, the best of them usually falls too. A guide, not a promise. Held positions keep their Trade Log call. The results-date and news checks need the latest Refresh all stocks.</p>
    ${shown.length > MAX_ROWS ? '<p class="upload-hint">Showing the top ' + MAX_ROWS + ' of ' + shown.length + '.</p>' : ''}`;
}
// Only the table: used when trades or prices change, so the strategy list is not rebuilt under an open dropdown.
function refreshIdeasBody(){
  const host = document.getElementById('tradeIdeasBody');
  if(host) keepScroll(host, () => { host.innerHTML = bodyHtml(); });
}
function renderIdeas(){
  const host = document.getElementById('tradeIdeasBody');
  if(!host) return;
  const strategies = publishedStrategies();
  if(sid && !strategies.some(x => x.id === sid)) sid = '';
  const sel = document.getElementById('tradeIdeasStrategy');
  if(sel){
    sel.innerHTML = '<option value="">Choose a strategy&hellip;</option>' + strategies.map(x => `<option value="${escapeHtml(x.id)}"${x.id === sid ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
  }
  keepScroll(host, () => { host.innerHTML = bodyHtml(); });
}
function init_ideas(){
  const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('tradeIdeasStrategy')), host = document.getElementById('tradeIdeasBody');
  if(sel) sel.addEventListener('change', () => { sid = sel.value; filter = 'all'; remember(); renderIdeas(); });
  if(host) host.addEventListener('click', (e) => {
    const el = /** @type {Element} */ (e.target);
    const f = el.closest('[data-idea-filter]');
    if(f){ filter = f.getAttribute('data-idea-filter') || 'all'; renderIdeas(); return; }
    const sh = /** @type {HTMLElement | null} */ (el.closest('[data-sort-col]'));
    if(sh){ ideasSort = nextSort(ideasSort, sh.dataset.sortCol || ''); renderIdeas(); return; }
    const a = el.closest('a[data-idea-open]');
    if(a){ e.preventDefault(); const idx = Number(a.getAttribute('data-idea-open')); openStockInline(appSections.trackrecord, "Trade Log", idx); }
  });
}
export { init_ideas, refreshIdeasBody, renderIdeas };
