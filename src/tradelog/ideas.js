// Buy / Sell ideas panel (Trade Log): pick a strategy, see the stocks that qualify today ranked by Buy / Hold / Sell call (rules in ideacall.js).
import { stockByTickerSymbol, stocks } from '../core/stocks.js';
import { allTrades } from '../core/store.js';
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { publishedStrategies } from '../strategies/state.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { ensureAllPriceBars, pcTickerKey, priceHistoryByTicker } from '../prices/store.js';
import { tvIstDate } from '../tv/connector.js';
import { ideaCall, rankIdeas } from './ideacall.js';
import { swingSetup } from './swing.js';

const MAX_ROWS = 50;
function openTradeByStock(){
  const m = new Map();
  for(const t of allTrades()){
    if(t.status === 'closed' && t.sell) continue;
    const s = stockByTickerSymbol.get(t.ticker);
    if(s && !m.has(s)) m.set(s, t);
  }
  return m;
}
function ideasFor(strategyId){
  const st = publishedStrategies().find(x => x.id === strategyId);
  if(!st) return null;
  const held = openTradeByStock();
  const today = tvIstDate();
  return rankIdeas(qualifyingStocks(stocks, st.rules).map(s => {
    const bars = priceHistoryByTicker[pcTickerKey(s)];
    return { s, c: ideaCall(s, held.get(s) || null, swingSetup(s, bars && bars['1W'], today)) };
  }));
}

let sid = '', filter = 'all', barsState = 'idle';   // idle | loading | ready: the weekly bars the timing check reads are loaded once per visit
function loadBars(){
  if(barsState !== 'idle') return;
  barsState = 'loading';
  ensureAllPriceBars().then(ok => { barsState = ok ? 'ready' : 'idle'; if(ok) refreshIdeasBody(); });
}
try { sid = localStorage.getItem('albaDashboard.ideasStrategy.v1') || ''; } catch(e){ /* default */ }
const remember = () => { try { localStorage.setItem('albaDashboard.ideasStrategy.v1', sid); } catch(e){ /* kept for this visit */ } };

function rowHtml(x, rank){
  const { s, c } = x, idx = stocks.indexOf(s), price = s.valuation && s.valuation.currentPrice;
  return `<tr>
    <td class="num">${rank}</td>
    <td><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.held ? ' &middot; held' : ''}</span></td>
    <td><span class="tl-signal-badge tl-idea-${c.call}">${escapeHtml(c.label)}</span></td>
    <td class="num" title="Timing checks passed: near the 52-week high, weekly MACD bullish above zero, enough weekly movement, firm RSI">${c.setup != null ? c.setup + '/' + c.of : '&mdash;'}</td>
    <td class="num" title="${c.chance != null ? 'In past weeks with this setup, the stock closed 5% or more higher two weeks later ' + c.chance + '% of the time, and touched +5% within the two weeks ' + c.touch + '% of the time.' : ''}">${c.chance != null ? '~' + c.chance + '%' : '&mdash;'}</td>
    <td class="num">${price != null ? '&#8377;' + Number(price).toLocaleString('en-IN') : '&mdash;'}</td>
    <td class="num">${price != null && !c.held ? '&#8377;' + (Math.round(price * 105) / 100).toLocaleString('en-IN') : '&mdash;'}</td>
    <td class="num">${c.mos != null ? (c.mos >= 0 ? '+' : '') + c.mos.toFixed(1) + '%' : '&mdash;'}</td>
    <td class="tl-idea-why">${escapeHtml(c.reasons.join('; '))}</td></tr>`;
}
function bodyHtml(){
  if(sid) loadBars();
  const list = sid ? ideasFor(sid) : null;
  if(!sid) return '<p class="upload-hint">Choose a strategy to see the stocks that qualify today, ranked by Buy or Sell call.</p>';
  if(!list) return '<p class="upload-hint">That strategy is no longer available. Choose another.</p>';
  if(!list.length) return '<p class="upload-hint">No stock qualifies for this strategy today.</p>';
  const n = k => list.filter(x => x.c.call === k).length;
  const shown = list.filter(x => filter === 'all' || x.c.call === filter);
  const chip = (k, label) => `<button type="button" class="tl-view-btn${filter === k ? ' active' : ''}" data-idea-filter="${k}">${label}</button>`;
  return `<div class="tl-ideas-bar"><div class="tl-view-toggle" role="group" aria-label="Call filter">${chip('all', 'All ' + list.length)}${chip('buy', 'Buy ' + n('buy'))}${chip('hold', 'Hold ' + n('hold'))}${chip('sell', 'Sell ' + n('sell'))}</div></div>
    <div class="help-table-wrap"><table class="help-table"><thead><tr><th>#</th><th>Stock</th><th>Today's call</th><th>Setup</th><th>Chance +5% in 2 wks</th><th>Price</th><th>Sell at +5%</th><th>MoS</th><th>Why</th></tr></thead>
    <tbody>${shown.slice(0, MAX_ROWS).map((x, i) => rowHtml(x, i + 1)).join('')}</tbody></table></div>
    <p class="upload-hint">${barsState === 'ready' ? '' : 'Loading weekly price history for the timing check&hellip; '}<b>Setup</b> counts four timing checks (0 to 4). <b>Chance</b> is how often, in past weeks with that setup, a stock closed 5% or more higher two weeks later (about 7,200 stock-weeks from 43 stocks); an average stock does this about 25% of the time, so treat it as a guide, not a promise. Buy needs a stock worth owning and a setup of 2 or more.</p>
    ${shown.length > MAX_ROWS ? '<p class="upload-hint">Showing the top ' + MAX_ROWS + ' of ' + shown.length + '.</p>' : ''}`;
}
// Only the table: used when trades or prices change, so the strategy list is not rebuilt under an open dropdown.
function refreshIdeasBody(){
  const host = document.getElementById('tradeIdeasBody');
  if(host) host.innerHTML = bodyHtml();
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
  host.innerHTML = bodyHtml();
}
function init_ideas(){
  const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('tradeIdeasStrategy')), host = document.getElementById('tradeIdeasBody');
  if(sel) sel.addEventListener('change', () => { sid = sel.value; filter = 'all'; remember(); renderIdeas(); });
  if(host) host.addEventListener('click', (e) => {
    const el = /** @type {Element} */ (e.target);
    const f = el.closest('[data-idea-filter]');
    if(f){ filter = f.getAttribute('data-idea-filter') || 'all'; renderIdeas(); return; }
    const a = el.closest('a[data-idea-open]');
    if(a){ e.preventDefault(); const idx = Number(a.getAttribute('data-idea-open')); openStockInline(appSections.trackrecord, "Trade Log", idx); }
  });
}
export { init_ideas, refreshIdeasBody, renderIdeas };
