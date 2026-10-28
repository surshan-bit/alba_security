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
import { AVOID_BOTTOM, BUY_TOP, RESULTS_DAYS, THIN_LAKH, TREND_NAME, ideaCall, rankIdeas, topBuys, trendOf } from './ideacall.js';
import { CAP_NAME } from '../core/capclass.js';
import { nextWeekRead, rankReads } from './nextweek.js';
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
  const reads = rankReads(list.map(s => { const bars = priceHistoryByTicker[pcTickerKey(s)]; return bars && bars['1W'] ? nextWeekRead(bars['1W'], today) : null; }), list.map(trendOf));
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
    <td><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.cap ? ' &middot; ' + CAP_NAME[c.cap] : ''}${c.trend ? ' &middot; ' + TREND_NAME[c.trend] : ''}${c.held ? ' &middot; held' : ''}</span></td>
    <td><span class="tl-signal-badge tl-idea-${c.call}">${escapeHtml(c.label)}</span></td>
    <td class="num" title="Where its two-week score ranks among the stocks of this strategy with the same trend today">${c.topPct != null ? 'Top ' + c.topPct + '%' : '&mdash;'}</td>
    <td class="num" title="${c.up != null ? 'In the five-year tests, stocks that ranked like this each week were higher two weeks later ' + c.up + '% of the time, and beat the median stock ' + c.beat + '% of the time. All stocks of this trend were higher ' + c.base + '% of the time.' : ''}">${c.up != null ? '~' + Math.round(c.up) + '%' : '&mdash;'}</td>
    <td class="num">${price != null ? '&#8377;' + Number(price).toLocaleString('en-IN') : '&mdash;'}</td>
    <td class="num">${c.mos != null ? (c.mos >= 0 ? '+' : '') + c.mos.toFixed(1) + '%' : '&mdash;'}</td>
    <td class="tl-idea-why">${escapeHtml(c.reasons.join('; '))}</td></tr>`;
}
// The five best Buy calls of each trend among the stocks you do not hold, above the full list: Upward trend (positive move) and Downward trend (bounce back).
const TOP_LISTS = [['up', 'Upward trend \u2013 positive move', 'Stocks whose weekly and monthly trends are both up, ranked by two-week score.'],
  ['down', 'Downward trend \u2013 bounce back', 'Stocks whose weekly and monthly trends are both down: a bet on a rebound, so the hit rate is lower and the risk higher.']];
function topHtml(list){
  const item = (x, i) => {
    const { s, c } = x, idx = stocks.indexOf(s), price = s.valuation && s.valuation.currentPrice;
    return `<li><span class="tl-top5-rank">${i + 1}</span><div><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.cap ? ' &middot; ' + CAP_NAME[c.cap] : ''}</span>
      <div class="tl-top5-meta">Top ${c.topPct}% in its trend &middot; higher after 2 weeks ~${Math.round(c.up)}% of the time in tests (all ${Math.round(c.base)}%)${c.mos != null ? ' &middot; MoS ' + (c.mos >= 0 ? '+' : '') + c.mos.toFixed(1) + '%' : ''}${price != null ? ' &middot; &#8377;' + Number(price).toLocaleString('en-IN') : ''}</div>
      <div class="tl-idea-why">${escapeHtml(c.reasons.join('; '))}</div></div></li>`;
  };
  return TOP_LISTS.map(([t, title, hint]) => {
    const top = topBuys(list, t, TOP_N);
    return `<div class="tl-top5"><div class="tl-top5-title">${title} &middot; top ${TOP_N}</div><p class="upload-hint">${hint}</p>${top.length ? '<ol>' + top.map(item).join('') + '</ol>' : '<p class="upload-hint">No stock in this list is a Buy today.</p>'}</div>`;
  }).join('');
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
    <div class="help-table-wrap"><table class="help-table"><thead><tr><th>#</th>${th('name', 'Stock')}${th('call', "Today's call")}${th('score', 'Two-week score')}${th('chance', 'Higher after 2 wks (tests)')}${th('price', 'Price')}${th('mos', 'MoS')}<th>Why</th></tr></thead>
    <tbody>${shown.slice(0, MAX_ROWS).map((x, i) => rowHtml(x, i + 1)).join('')}</tbody></table></div>
    <p class="upload-hint">${barsBusy ? 'Loading weekly price history for the timing check (' + barsDone + ' of ' + barsTotal + ')&hellip; ' : ''}The two-week score comes from a model trained and tested week by week on five years of weekly prices (about 294,000 stock-weeks, return two weeks later): it rates how likely a stock is to beat the median stock over the next two weeks. It shows where a stock ranks among this strategy&rsquo;s stocks today (the raw score moves with the whole market, the ranking does not). <b>Higher after 2 wks</b> is how often stocks of that trend that ranked like this each week were higher two weeks later in those tests. Stocks are split by trend (weekly and monthly MACD both above their signal lines is Upward, both below is Downward; a mix is neither list) and ranked within their own trend, because the two behave differently: in the tests the best five Upward stocks each week were higher after two weeks about 54% of the time (all Upward stocks 51%), the best five Downward ones about 51% (all Downward 45%), so a bounce-back is the weaker bet. Buy is a stock in the top ${BUY_TOP}% of its trend; Avoid is the bottom ${AVOID_BOTTOM}%. A Buy is held back (Wait) when its margin of safety is zero or below, its Fundamental verdict is Avoid, results are due within ${RESULTS_DAYS} days, trading is very thin (under &#8377;${THIN_LAKH} lakh a day) or recent news clearly leans negative. The edge is real but modest (so expect nearly half to lose), and it cannot see the market: when most stocks fall, the best of them usually falls too. Run it on Friday after the close for the cleanest reading; on Thursday or Friday before the close it uses the week so far. Held positions keep their Trade Log call. The results-date and news checks need the latest Refresh all stocks.</p>
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
