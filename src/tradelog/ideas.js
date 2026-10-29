// Buy / Sell ideas panel (Trade Log): pick a strategy and press Process; once the weekly prices of its stocks are read, the two Top 5 lists (Upward trend and
// Downward trend, rules in ideacall.js) are shown. Nothing is worked out until Process is pressed, and the panel says so while it runs.
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
import { BUY_TOP, RESULTS_DAYS, THIN_LAKH, ideaCall, rankIdeas, topBuys, trendOf } from './ideacall.js';
import { CAP_NAME } from '../core/capclass.js';
import { nextWeekRead, rankReads } from './nextweek.js';

const TOP_N = 5;
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

let sid = '';
// What the panel is doing: 'idle' (a strategy is chosen but Process has not been pressed), 'running' (reading weekly prices) or 'done' (results shown for `sid`).
let phase = 'idle';
try { sid = localStorage.getItem('albaDashboard.ideasStrategy.v1') || ''; } catch(e){ /* default */ }
// The two-week reading uses weekly bars, so the bars of the stocks in the chosen strategy (and only those) are loaded, a few at a time, when Process is pressed.
// Every stock is tried again on each press, so a read that failed before gets another chance.
const BARS_PARALLEL = 6;
// stage: 'read' (reading weekly prices, barsDone of barsTotal stocks), then 'rank' (working out the trends and calls).
let barsDone = 0, barsTotal = 0, stage = 'read';
async function runIdeas(){
  if(phase === 'running') return;
  const st = publishedStrategies().find(x => x.id === sid);
  if(!st) return;
  const all = qualifyingStocks(stocks, st.rules), need = all.filter(s => !priceLoaded.has(pcTickerKey(s)));
  phase = 'running'; stage = 'read'; barsTotal = all.length; barsDone = all.length - need.length;
  refreshIdeasBody();
  let next = 0;
  const worker = async () => {
    while(next < need.length){
      const s = need[next++];
      try { await ensurePriceBars(s); } catch(e){ console.error('Price history unavailable', e); }
      barsDone++;
      if(barsDone % 5 === 0 && barsDone < barsTotal) refreshIdeasBody();
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(BARS_PARALLEL, need.length) }, worker)); }
  catch(e){ console.error('Processing the ideas failed', e); }
  stage = 'rank'; refreshIdeasBody();
  await new Promise(r => setTimeout(r, 60));   // lets the bar show the last step before the lists are worked out
  phase = 'done'; refreshIdeasBody();
}
// The progress shown while it runs, in the same form as the Data Refresh screen: a bar with a percentage and the steps with a mark each.
function progressHtml(st){
  const n = barsTotal, reading = stage === 'read';
  const pct = !n ? 100 : reading ? Math.round(90 * barsDone / n) : 95;
  const step = (state, label, detail) => `<li class="fi-step fi-${state}"><span class="fi-mark" aria-hidden="true">${state === 'done' ? '&#10003;' : state === 'running' ? '&#9679;' : '&#9675;'}</span><span>${label}</span><span class="fi-detail">${detail}</span></li>`;
  return `<div class="tl-ideas-progress" role="status"><div class="fi-head"><b>Processing &ldquo;${escapeHtml(st.name)}&rdquo;</b><span class="fi-pct">${pct}%</span></div>
    <div class="fi-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fi-bar-fill" style="width:${pct}%"></div></div>
    <ul class="fi-steps">${step('done', 'Find the stocks that qualify', n + ' stocks')}
    ${step(reading ? 'running' : 'done', 'Read their weekly prices', barsDone + ' of ' + n)}
    ${step(reading ? 'pending' : 'running', 'Work out each trend, rank and apply the checks', reading ? '' : 'almost done')}</ul></div>`;
}
const remember = () => { try { localStorage.setItem('albaDashboard.ideasStrategy.v1', sid); } catch(e){ /* kept for this visit */ } };

// The five best Buy calls of each trend among the stocks you do not hold: Upward trend (positive move) and Downward trend (bounce back).
const TOP_LISTS = [['up', 'Upward trend – positive move', 'Stocks whose weekly and monthly trends are both up, ranked by two-week score.'],
  ['down', 'Downward trend – bounce back', 'Stocks whose weekly and monthly trends are both down: a bet on a rebound, so the hit rate is lower and the risk higher.']];
function topHtml(list){
  const item = (x, i) => {
    const { s, c } = x, idx = stocks.indexOf(s), price = s.valuation && s.valuation.currentPrice;
    return `<li><span class="tl-top5-rank">${i + 1}</span><div class="tl-top5-body"><div class="tl-top5-head"><span><a href="#" class="tl-name-link" data-idea-open="${idx}">${escapeHtml(s.name || tickerSymbol(s))}</a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}${c.cap ? ' &middot; ' + CAP_NAME[c.cap] : ''}</span></span>${price != null ? '<span class="tl-top5-price">&#8377;' + Number(price).toLocaleString('en-IN') + '</span>' : ''}</div>
      <ul class="tl-top5-why">${c.reasons.map(r => '<li>' + escapeHtml(r) + '</li>').join('')}</ul></div></li>`;
  };
  return TOP_LISTS.map(([t, title, hint]) => {
    const top = topBuys(list, t, TOP_N);
    return `<div class="tl-top5"><div class="tl-top5-title">${title} &middot; top ${TOP_N}</div><p class="upload-hint">${hint}</p>${top.length ? '<ol>' + top.map(item).join('') + '</ol>' : '<p class="upload-hint">No stock in this list is a Buy today.</p>'}</div>`;
  }).join('');
}
function bodyHtml(){
  if(!sid) return '<p class="upload-hint">Choose a strategy, then press Process to rank its stocks.</p>';
  const st = publishedStrategies().find(x => x.id === sid);
  if(!st) return '<p class="upload-hint">That strategy is no longer available. Choose another.</p>';
  if(phase === 'running') return progressHtml(st);
  if(phase !== 'done') return '<p class="upload-hint">Press <b>Process</b> to read the weekly prices of this strategy&rsquo;s stocks and rank them. Nothing is worked out until you do.</p>';
  const list = ideasFor(sid);
  if(!list) return '<p class="upload-hint">That strategy is no longer available. Choose another.</p>';
  if(!list.length) return '<p class="upload-hint">No stock qualifies for this strategy today.</p>';
  const nshort = list.filter(x => x.c.short).length, nt = k => list.filter(x => x.c.trend === k).length, other = list.length - nt('up') - nt('down') - nt('mixed');
  return `<p class="upload-hint tl-ideas-done">Processed ${list.length} stocks: ${nt('up')} in an upward trend, ${nt('down')} downward, ${nt('mixed')} mixed (in neither list)${other ? ', ' + other + ' without a trend or enough price history' : ''}${nshort ? '; ' + nshort + ' recent listing' + (nshort === 1 ? '' : 's') + ' (under 80 weeks of prices) included' : ''}. As of today&rsquo;s prices (${tvIstDate()}), counting this week so far.</p>${topHtml(list)}
    <p class="upload-hint">The two-week score comes from a model trained and tested week by week on five years of weekly prices (about 294,000 stock-weeks, return two weeks later): it rates how likely a stock is to beat the median stock over the next two weeks. Stocks are split by trend (weekly and monthly MACD both above their signal lines is Upward, both below is Downward; a mix is neither list) and ranked within their own trend, because the two behave differently: in the tests the best five Upward stocks each week were higher after two weeks about 54% of the time (all Upward stocks 51%), the best five Downward ones about 51% (all Downward 45%), so a bounce-back is the weaker bet. <b>Higher after 2 weeks</b> is how often stocks of that trend that ranked like this each week were higher two weeks later in those tests. A stock needs at least 53 weeks of prices. Recent listings (53 to 79 weeks) carry a <b>Short history</b> note and their own, lower tested hit rates, because new listings fall more often than older stocks and the sample is small; they have no monthly MACD yet, so their trend uses the weekly MACD only (noted on the card). A stock is a Buy when it is in the top ${BUY_TOP}% of its trend, and is held back when its margin of safety is zero or below, its Fundamental verdict is Avoid, results are due within ${RESULTS_DAYS} days, trading is very thin (under &#8377;${THIN_LAKH} lakh a day) or recent news clearly leans negative. The edge is real but modest (so expect nearly half to lose), and it cannot see the market: when most stocks fall, the best of them usually falls too. It always uses today&rsquo;s prices, counting this week so far; the model was trained on whole weeks, so a Friday-after-the-close run is the cleanest reading and an early-week run rests on fewer days of this week&rsquo;s move. Positions you hold are in the Trade Log above. The results-date and news checks need the latest Refresh all stocks.</p>`;
}
// The Process button and the strategy picker: both wait while the weekly prices are being read.
function syncControls(){
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('tradeIdeasRun')), sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('tradeIdeasStrategy'));
  if(btn){ btn.disabled = !sid || phase === 'running'; btn.textContent = phase === 'running' ? 'Processing…' : phase === 'done' ? 'Process again' : 'Process'; }
  if(sel) sel.disabled = phase === 'running';
}
// Only the body: used when trades or prices change, so the strategy list is not rebuilt under an open dropdown.
function refreshIdeasBody(){
  const host = document.getElementById('tradeIdeasBody');
  if(host) keepScroll(host, () => { host.innerHTML = bodyHtml(); host.setAttribute('aria-busy', phase === 'running' ? 'true' : 'false'); });
  syncControls();
}
function renderIdeas(){
  const host = document.getElementById('tradeIdeasBody');
  if(!host) return;
  const strategies = publishedStrategies();
  if(sid && !strategies.some(x => x.id === sid)){ sid = ''; phase = 'idle'; }
  const sel = document.getElementById('tradeIdeasStrategy');
  if(sel){
    sel.innerHTML = '<option value="">Choose a strategy&hellip;</option>' + strategies.map(x => `<option value="${escapeHtml(x.id)}"${x.id === sid ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('');
  }
  refreshIdeasBody();
}
function init_ideas(){
  const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById('tradeIdeasStrategy')), host = document.getElementById('tradeIdeasBody'), run = document.getElementById('tradeIdeasRun');
  if(sel) sel.addEventListener('change', () => { sid = sel.value; phase = 'idle'; remember(); renderIdeas(); });
  if(run) run.addEventListener('click', runIdeas);
  if(host) host.addEventListener('click', (e) => {
    const a = /** @type {Element} */ (e.target).closest('a[data-idea-open]');
    if(a){ e.preventDefault(); const idx = Number(a.getAttribute('data-idea-open')); openStockInline(appSections.trackrecord, "Trade Log", idx); }
  });
}
export { init_ideas, refreshIdeasBody, renderIdeas };
