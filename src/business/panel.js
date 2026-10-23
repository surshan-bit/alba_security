// The Explorer page (code name "business"): every industry with its average price change over a chosen period, and the news of its stocks.
import { keepScroll } from '../ui/scrollkeep.js';
import { stockIndex, stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { ensureAllPriceBars, pcTickerKey, priceHistoryByTicker } from '../prices/store.js';
import { appSections } from '../ui/navigation.js';
import { openIndustryInline, openStockInline } from '../ui/inlinedetail.js';
import { analysisLbCell, analysisRowContext, columnHeaderHtml, stockGridColumnIds } from '../analysis/columns.js';
import { publishedStrategies } from '../strategies/state.js';
import { strategyStockSet, validStrategyId } from '../strategies/pick.js';
import { getNewsRun, planNews, startNewsCollect, stopNewsCollect } from './news.js';
import { prefSet } from '../identity/prefs.js';
import { browserFullscreen, fullscreenLabel, watchFullscreenExit } from '../ui/fullscreen.js';
import { kit } from '../refresh/kit.js';
import { heatmapHtml } from './heatmap.js';
import { newsItemHtml } from './newsitem.js';
import { sheetFrame, syncSheets } from '../ui/phonesheet.js';
import { PERIODS, industryTable, needsBars, periodOf } from './calc.js';
import { closestEl } from '../core/evt.js';
import { isRebound } from '../list/rebound.js';

const KEY = 'albaDashboard.business.v1';
let bizFull = false;   // the table (or the heat map) fills the whole window
const newsOpen = new Set();   // industries whose News section is open (closed at first)
let bizFiltersOpen = false;   // phones: the view, period, grouping and strategy controls fold into one "Filters" line, closed at first
let period = '1M', by = 'industry', view = 'table', heatSize = 'chg', strategyId = '', showMatched = false, rebound = false, loadState = 'idle';   // loadState: 'idle' | 'loading' | 'failed' (price bars for long periods)
const open = new Set();                                    // industries whose detail is open
try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); if(PERIODS.some(p => p.key === v.period)) period = v.period; if(v.by === 'group') by = 'group'; if(v.view === 'heat') view = 'heat'; if(v.heatSize === 'count') heatSize = 'count'; if(typeof v.strategy === 'string') strategyId = v.strategy; if(v.matched === true) showMatched = true; if(v.rebound === true) rebound = true; } catch(e){ /* storage unavailable: defaults */ }
// Saved to this person's preferences (and mirrored in the browser).
const save = () => { prefSet(KEY, JSON.stringify({ period, by, view, heatSize, strategy: strategyId, matched: showMatched, rebound })); };

const barsFor = (s) => { const d = priceHistoryByTicker[pcTickerKey(s)]; return d ? d['1W'] : undefined; };
const pct = (v) => v === null ? '<span class="biz-na">n/a</span>' : '<span class="' + (v > 0 ? 'chg-up' : v < 0 ? 'chg-down' : '') + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
const bodyEl = () => document.getElementById('businessBody');

// The stocks that qualify for the strategy chosen here (none chosen: no highlighting, no extra columns).
const chosenStrategy = () => validStrategyId(strategyId);
// "Strategy" below also covers the Rebound button (down last week, up this week): the stocks that pass whichever of the two are on.
const strategyOn = () => !!chosenStrategy() || rebound;
const matchSet = () => {
  const set = chosenStrategy() ? strategyStockSet(chosenStrategy()) || new Set() : new Set(stocks);
  return rebound ? new Set(Array.from(set).filter(isRebound)) : set;
};
// "Matched" view: only the industries (and, inside them, only the stocks) that qualify for the chosen strategy. It needs a strategy; without one everything is shown.
const matchedOnly = () => showMatched && strategyOn();
// The industry rows as shown on the page, with the same filter the table uses.
function visibleRows(){
  const rows = industryTable(stocks, { by, period, barsFor, matchSet: strategyOn() ? matchSet() : null });
  return matchedOnly() ? rows.filter(r => r.matches > 0) : rows;
}
const signedPp = (v) => v === null ? '<span class="biz-na">n/a</span>' : '<span class="' + (v > 0 ? 'chg-up' : v < 0 ? 'chg-down' : '') + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + ' pts</span>';

// ---- Collect latest news (on demand) ----
const newsStatusHtml = () => {
  const r = getNewsRun();
  if(!r) return '';
  const left = r.total - r.done;
  const bits = [];
  if(r.state === 'running') bits.push('Collecting news for ' + escapeHtml(r.label) + ': ' + r.done + ' of ' + r.total + ' stocks, ' + r.added + ' new headline' + (r.added === 1 ? '' : 's') + '… <button type="button" class="refresh-btn" data-biz-newsstop="1">Stop</button>');
  else {
    bits.push((r.state === 'stopped' ? 'Stopped. ' : r.state === 'failed' ? 'Could not collect news. ' : 'Done. ') + 'Looked at ' + r.done + ' of ' + r.total + ' stocks for ' + escapeHtml(r.label) + ': ' + r.added + ' new headline' + (r.added === 1 ? '' : 's') + (r.noFeed ? ', ' + r.noFeed + ' with no TradingView news feed' : '') + (r.failed.length ? ', ' + r.failed.length + ' failed' : '') + '.' + (left > 0 && r.state === 'stopped' ? ' ' + left + ' not done.' : '') + (r.note ? ' ' + escapeHtml(r.note) : ''));
    if(r.failed.length) bits.push('<span class="biz-warn">' + escapeHtml(r.failed.slice(0, 3).join('; ')) + (r.failed.length > 3 ? '; …' : '') + '</span>');
  }
  return '<p class="upload-hint biz-newsstatus' + (r.state === 'failed' ? ' biz-warn' : '') + '" id="bizNewsStatus">' + bits.join(' ') + '</p>';
};
// The news run's status is shown on the News line of the industry it is collecting for.
function newsStatusFor(name){
  const run = getNewsRun();
  return run && (run.label === name || run.label === name + ' (matching stocks)') ? newsStatusHtml() : '';
}
// One Refresh-news button for the industry. Its menu offers all of the stocks and, when the Analysis filters are on and only some of
// them match, just the matching ones.
function newsRefreshBtn(members, matched, key){
  const r = getNewsRun(), busy = !!r && r.state === 'running';
  const hit = strategyOn() ? matched : [];
  const opt = (list, mode, text) => {
    const plan = planNews(list), n = plan.stocks.length;
    return { label: (plan.again ? 'Refresh news' : 'Collect latest news') + ' · ' + text, small: n + ' stock' + (n === 1 ? '' : 's') + (plan.left ? ', then ' + plan.left + ' more' : ''), off: busy || !list.length, run: () => runNews(key + '|' + mode) };
  };
  kit.defineChoices('news:' + key, () => {
    const items = [opt(members, 'all', members.length === 1 ? 'the stock' : 'all ' + members.length + ' stocks')];
    if(hit.length && hit.length < members.length) items.push(opt(hit, 'match', 'matching ' + hit.length));
    return { head: key + ' · news', items };
  });
  return kit.choiceBtn('news:' + key, busy || !members.length, 'Reads the latest headlines from TradingView for these stocks and saves them');
}
function runNews(spec){
  const [key, mode] = spec.split('|'), matched = matchSet();
  let all, label;
  const row = industryTable(stocks, { by, period, barsFor, matchSet: strategyOn() ? matched : null }).find(x => x.name === key);
  if(!row) return;
  all = row.items.map(x => x.stock); label = key;
  let members = all;
  if(mode === 'match'){ members = all.filter(s => matched.has(s)); label += ' (matching stocks)'; }
  startNewsCollect(members, label, (r) => { if(r.state === 'running') paintNewsStatus(); else render(); });
}
function paintNewsStatus(){
  const el = document.getElementById('bizNewsStatus'), html = newsStatusHtml();
  if(el && html){ const t = document.createElement('div'); t.innerHTML = html; el.replaceWith(t.firstChild); } else render();
  document.querySelectorAll('.biz-newsbtn').forEach(b => { /** @type {HTMLButtonElement} */ (b).disabled = true; });
}

function newsHtml(r){
  if(!r.news.length) return '<p class="upload-hint">No news saved for these stocks in this period. Headlines come from Refresh Fundamental Info, so stocks that have not been refreshed recently have none.</p>';
  return '<ul class="biz-news">' + r.news.slice(0, 15).map(n => newsItemHtml(n)).join('') + '</ul>' + (r.news.length > 15 ? '<p class="upload-hint">Showing the newest 15 of ' + r.news.length + '.</p>' : '');
}
// The industry's stocks in the same grid as the Analysis leaderboard and the Strategies results (best change first),
// with the period's own change as the last column.
function detailHtml(r, cols){
  const vis = r.items.filter(x => !matchedOnly() || x.match).map(x => x.stock);
  kit.defineScope('biz:' + r.name, { label: r.name, source: 'biz-kit', selName: 'biz', stocks: () => vis });   // what this table's Refresh button works on
  const p = periodOf(period), colIds = stockGridColumnIds();   // the column order set in Analysis
  const rows = r.items.filter(x => !matchedOnly() || x.match).map((x, i) => {
    const idx = stockIndex.get(x.stock), ctx = analysisRowContext(x.stock, i, idx);
    return '<tr class="strat-row' + (x.match ? ' biz-match' : '') + '" data-idx="' + idx + '" tabindex="0">' + kit.rowCell() + colIds.map(id => analysisLbCell(id, ctx)).join('') + '<td class="num">' + pct(x.change) + '</td></tr>';
  }).join('');
  const grid = '<div class="strat-table-wrap" style="--biz-rows:' + (rows.split('</tr>').length - 1) + '"><table class="strat-table"><thead><tr>' + kit.headCell() + colIds.map(columnHeaderHtml).join('') + '<th class="num">' + p.key + ' chg</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  return '<tr class="biz-detail"><td colspan="' + cols + '"><div class="biz-detail-box"><div class="biz-stocks-head"><h3>Stocks</h3>' + (strategyOn() ? '<span class="upload-hint">' + r.matches + ' of ' + r.count + ' match the strategy</span>' : '') + kit.barHtml('biz:' + r.name) + '</div>' + grid + '<div class="biz-stocks-head biz-news-bar"><h3 class="biz-news-head"><button type="button" class="biz-news-toggle" data-biz-newstoggle="' + escapeHtml(r.name) + '" aria-expanded="' + newsOpen.has(r.name) + '">' + (newsOpen.has(r.name) ? '▾' : '▸') + ' News' + (r.news.length ? ' (' + r.news.length + ')' : '') + '</button></h3>' + (newsOpen.has(r.name) ? newsRefreshBtn(r.items.map(x => x.stock), r.items.filter(x => x.match).map(x => x.stock), r.name) : '') + newsStatusFor(r.name) + '</div>' + (newsOpen.has(r.name) ? newsHtml(r) : '') + '</div></td></tr>';
}
function openStockFromBusiness(idx){
  openStockInline(appSections.business, 'Explorer', idx);
}
function breadth(r){
  if(!r.known) return '';
  const u = r.up / r.known * 100, d = r.down / r.known * 100;
  return '<span class="biz-breadth" title="' + r.up + ' up, ' + r.down + ' down, ' + (r.known - r.up - r.down) + ' unchanged"><i class="up" style="width:' + u + '%"></i><i class="down" style="width:' + d + '%"></i></span> ' + r.up + '↑ ' + r.down + '↓';
}

// Strategy choice as buttons, like the Analysis filter: "All" (no strategy) or one of your strategies, each with how many stocks qualify today.
function strategyGroupHtml(){
  const chosen = chosenStrategy();
  const btn = (value, label, n, active, dot, title) => '<button type="button" class="filter-btn' + (active ? ' active' : '') + '" data-biz-strat="' + escapeHtml(value) + '" title="' + title + '"><span class="filter-dot" style="background:' + dot + '"></span>' + label + '<span class="filter-n">' + n + '</span></button>';
  const list = [btn('', 'All', stocks.length, !chosen, 'var(--text)', 'Do not highlight by a strategy')].concat(publishedStrategies().map(x => {
    const set = strategyStockSet(x.id);
    return btn(x.id, '<span class="filter-label">' + escapeHtml(x.name) + '</span>', set ? set.size : 0, x.id === chosen, 'var(--accent)', 'Highlight the stocks that qualify for this strategy today');
  }));
  const rb = '<div class="filter-group"><h2>Weekly Move</h2><div class="filter-group-row"><button type="button" class="filter-btn' + (rebound ? ' active' : '') + '" data-biz-rebound="1" aria-pressed="' + rebound + '" title="Down last week, up this week"><span class="filter-dot" style="background:var(--buy)"></span>Rebound<span class="filter-n">' + stocks.filter(isRebound).length + '</span></button></div></div>';
  return '<div class="filters analysis-filters-panel biz-strategy-panel"><div class="filter-group"><h2>Strategy</h2><div class="filter-group-row">' + list.join('') + '</div></div>' + rb + '</div>';
}
// The view, period, grouping and strategy controls sit in a column beside the content, like the Analysis filters.
// The "Filters" line (phones only; wide screens show the controls beside the table): what is chosen, and a click opens the controls.
function filtersToggleHtml(){
  const x = publishedStrategies().find(y => y.id === chosenStrategy());
  const summary = [view === 'heat' ? 'Heat map' : 'Table', periodOf(period).key, by === 'group' ? 'Industry group' : 'Industry', (x ? x.name : 'All') + (rebound ? ' + Rebound' : '')].join(' \u00b7 ');
  return '<button type="button" class="biz-filters-toggle" data-biz-filters="1" aria-expanded="' + bizFiltersOpen + '"><span class="ft-label" aria-label="Filters"></span><span class="ft-summary">' + escapeHtml(summary) + '</span><span class="ft-caret" aria-hidden="true">\u25be</span></button>';
}
const layoutHtml = (controls, main) => '<div class="biz-layout"><aside class="biz-side' + (bizFiltersOpen ? '' : ' filters-collapsed') + '">' + filtersToggleHtml() + sheetFrame(controls) + '</aside><div class="biz-main' + (bizFull ? ' biz-full' : '') + '">' + main + '</div></div>';

// Redraws the page but keeps the scroll of each stocks grid, so a redraw during a refresh does not jump the view.
function render(){
  const el = bodyEl(); if(!el) return;
  keepScroll(el, () => draw(el));
}
// The heat map: beside the filters it is as wide as the page leaves room for; in full screen it takes the whole window, with a height that fits it.
function heatMap(rows, p, el){
  if(!bizFull) return heatmapHtml(rows, period, Math.max(300, el.clientWidth - 280), heatSize);
  const w = Math.max(300, window.innerWidth - 40), ratio = Math.min(.95, Math.max(.45, (window.innerHeight - 140) / w));
  return heatmapHtml(rows, period, w, heatSize, ratio);
}
function draw(el){
  document.body.classList.toggle('biz-full-open', bizFull);
  const p = periodOf(period);
  const rows = visibleRows();
  const allOpen = rows.length > 0 && rows.every(r => open.has(r.name));
  const controls = '<div class="biz-controls"><div class="tl-view-toggle" role="group" aria-label="View"><button type="button" class="tl-view-btn' + (view === 'table' ? ' active' : '') + '" data-biz-view="table">Table</button><button type="button" class="tl-view-btn' + (view === 'heat' ? ' active' : '') + '" data-biz-view="heat">Heat map</button></div><div class="tl-view-toggle" role="group" aria-label="Period">' + PERIODS.map(x => '<button type="button" class="tl-view-btn' + (x.key === period ? ' active' : '') + '" data-biz-period="' + x.key + '">' + x.key + '</button>').join('') + '</div>'
    + '<div class="tl-view-toggle" role="group" aria-label="Grouping"><button type="button" class="tl-view-btn' + (by === 'industry' ? ' active' : '') + '" data-biz-by="industry">Industry</button><button type="button" class="tl-view-btn' + (by === 'group' ? ' active' : '') + '" data-biz-by="group">Industry group</button></div>'
    + strategyGroupHtml()
    + '</div>';
  const viewToggle = '<div class="tl-view-toggle biz-match-toggle" role="group" aria-label="Show">'
    + '<button type="button" class="tl-view-btn' + (!matchedOnly() ? ' active' : '') + '" data-biz-show="all" title="Show every industry and stock">All</button>'
    + '<button type="button" class="tl-view-btn' + (matchedOnly() ? ' active' : '') + '" data-biz-show="matched"' + (strategyOn() ? ' title="Show only the industries and stocks that match the chosen strategy"' : ' disabled title="Choose a strategy or Rebound first"') + '>Matched</button></div>';
  const sizeToggle = '<div class="tl-view-toggle biz-match-toggle biz-size-toggle" role="group" aria-label="Size the tiles by"><button type="button" class="tl-view-btn' + (heatSize === 'chg' ? ' active' : '') + '" data-biz-size="chg" title="Bigger tiles = bigger average change">% Change</button><button type="button" class="tl-view-btn' + (heatSize === 'count' ? ' active' : '') + '" data-biz-size="count" title="Bigger tiles = more stocks">No. of stocks</button></div>';
  const fullBtn = '<button type="button" class="biz-expand" data-biz-full="1" aria-pressed="' + bizFull + '" title="Show the ' + (view === 'heat' ? 'heat map' : 'table') + ' across the whole window (Esc to leave)">' + fullscreenLabel(bizFull) + '</button>';
  const expandBtn = viewToggle + '<button type="button" class="biz-expand" data-biz-all="' + (allOpen ? 'collapse' : 'expand') + '">' + (allOpen ? 'Collapse all' : 'Expand all') + '</button>' + fullBtn;
  let status = '';
  if(needsBars(period)){
    if(loadState === 'loading') status = '<p class="upload-hint">Loading price history…</p>';
    else if(loadState === 'failed') status = '<p class="upload-hint biz-warn">Could not load the price history, so ' + p.label + ' figures are missing. <button type="button" class="refresh-btn" data-biz-retry="1">Retry</button></p>';
  }
  const total = rows.reduce((a, r) => a + r.matches, 0);
  const filterNote = strategyOn() ? '<p class="upload-hint biz-showing">Matched ' + total + ' of ' + stocks.length + ' stocks</p>' : '';
  const head = '<tr><th>' + (by === 'group' ? 'Industry group' : 'Industry') + '</th><th class="num">Stocks</th><th class="num">Average ' + p.key + '</th><th class="num">Median</th><th>Up / down</th><th class="num">News</th>' + (strategyOn() ? '<th class="num">Matching</th><th class="num">Match avg ' + p.key + '</th><th class="num">vs industry</th>' : '') + '</tr>';
  const cols = strategyOn() ? 9 : 6;
  const body = rows.map(r => {
    const isOpen = open.has(r.name);
    return '<tr class="biz-row' + (isOpen ? ' open' : '') + '" data-biz-name="' + escapeHtml(r.name) + '" tabindex="0" role="button" aria-expanded="' + isOpen + '"><td class="biz-name">' + '<button type="button" class="biz-open" data-biz-open="' + escapeHtml(r.name) + '" title="Open the industry page: factors, news and charts">' + escapeHtml(r.name) + '</button></td><td class="num">' + r.count + '</td><td class="num">' + pct(r.mean) + '</td><td class="num">' + pct(r.median) + '</td><td>' + breadth(r) + '</td><td class="num">' + (r.news.length ? r.news.length + (r.pos || r.neg ? ' <span class="news-pos">+' + r.pos + '</span> <span class="news-neg">&minus;' + r.neg + '</span>' : '') : '') + '</td>' + (strategyOn() ? '<td class="num">' + (r.matches ? '<b class="biz-matchcount">' + r.matches + '</b> of ' + r.count : '') + '</td><td class="num">' + (r.matches && r.matchMean !== null ? pct(r.matchMean) : '') + '</td><td class="num">' + (r.matches && r.matchMean !== null && r.mean !== null ? signedPp(r.matchMean - r.mean) : '') + '</td>' : '') + '</tr>' + (isOpen ? detailHtml(r, cols) : '');
  }).join('');
  if(view === 'heat'){ el.innerHTML = layoutHtml(controls, status + '<div class="biz-toolbar">' + filterNote + '<div class="biz-actions">' + viewToggle + sizeToggle + fullBtn + '</div></div>' + heatMap(rows, p, el)); syncSheets(); return; }
  kit.defineToolbar('biz', () => {
    const st = r => r.items.filter(x => !matchedOnly() || x.match).map(x => x.stock), out = [];
    if(strategyOn()) out.push({ id: 'matched', label: 'Matched stocks', stocks: () => rows.flatMap(r => r.items.filter(x => x.match).map(x => x.stock)) });
    const o = rows.filter(r => open.has(r.name));
    if(o.length) out.push({ id: 'open', label: 'Expanded industries (' + o.length + ')', stocks: () => o.flatMap(st) });
    out.push({ id: 'all', label: 'Every stock in the table', stocks: () => rows.flatMap(st) });
    return out;
  });
  el.innerHTML = layoutHtml(controls, status + '<div class="biz-toolbar">' + filterNote + '<div class="biz-actions">' + expandBtn + kit.toolbarButton('biz') + '</div></div>' + '<div class="biz-scroll"><table class="biz-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + kit.selbarSlot('biz'));
  syncSheets();
}

function ensureData(){
  if(!(needsBars(period) || rebound) || loadState === 'loading') return;
  loadState = 'loading'; render();
  ensureAllPriceBars().then(ok => { loadState = ok ? 'idle' : 'failed'; render(); });
}
function toggleRow(row){
  const name = row.dataset.bizName;
  if(open.has(name)) open.delete(name); else open.add(name);
  render();
}

function init(){
  const el = bodyEl(); if(!el) return;
  watchFullscreenExit(() => bizFull, () => { bizFull = false; render(); });
  el.addEventListener('click', (e) => {
    const io = closestEl(e, '[data-biz-open]');
    if(io){ openIndustryInline(appSections.business, 'Explorer', by, io.dataset.bizOpen); return; }
    const nt = closestEl(e, '[data-biz-newstoggle]');
    if(nt){ const n = nt.dataset.bizNewstoggle; if(newsOpen.has(n)) newsOpen.delete(n); else newsOpen.add(n); render(); return; }
    if(closestEl(e, '[data-biz-filters]')){ bizFiltersOpen = !bizFiltersOpen; render(); return; }
    if(closestEl(e, '[data-biz-full]')){ bizFull = !bizFull; browserFullscreen(bizFull); render(); return; }
    const sb = closestEl(e, '[data-biz-strat]');
    if(sb){ strategyId = sb.dataset.bizStrat; save(); render(); return; }
    if(closestEl(e, '[data-biz-rebound]')){ rebound = !rebound; save(); render(); ensureData(); return; }
    const shw = closestEl(e, '[data-biz-show]');
    if(shw){ if(/** @type {HTMLButtonElement} */ (shw).disabled) return; showMatched = shw.dataset.bizShow === 'matched'; save(); render(); return; }
    const sz = closestEl(e, '[data-biz-size]');
    if(sz){ heatSize = sz.dataset.bizSize === 'count' ? 'count' : 'chg'; save(); render(); return; }
    const vb = closestEl(e, '[data-biz-view]'), ht = closestEl(e, '[data-biz-heat]');
    if(vb){ view = vb.dataset.bizView; save(); render(); return; }
    if(ht){   // a heat-map tile: back to the table with that industry opened
      view = 'table'; save(); open.add(ht.dataset.bizHeat); render();
      const row = Array.from(el.querySelectorAll('.biz-row')).find(r => /** @type {HTMLElement} */ (r).dataset.bizName === ht.dataset.bizHeat);
      if(row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
      return;
    }
    const pb = closestEl(e, '[data-biz-period]'), gb = closestEl(e, '[data-biz-by]');
    if(pb){ period = pb.dataset.bizPeriod; save(); open.clear(); render(); ensureData(); return; }
    if(gb){ by = gb.dataset.bizBy; save(); open.clear(); render(); return; }
    if(closestEl(e, '[data-biz-newsstop]')){ stopNewsCollect(); return; }
    const all = closestEl(e, '[data-biz-all]');
    if(all){
      if(all.dataset.bizAll === 'collapse') open.clear();
      else visibleRows().forEach(r => open.add(r.name));
      render(); return;
    }
    if(closestEl(e, '[data-biz-retry]')){ loadState = 'idle'; ensureData(); return; }
    if(closestEl(e, 'a:not(.stock-link)')) return;
    const sr = closestEl(e, '.strat-row');
    if(sr){ openStockFromBusiness(Number(sr.dataset.idx)); return; }
    const row = closestEl(e, '.biz-row'); if(row) toggleRow(row);
  });
  el.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ const sr = closestEl(e, '.strat-row'); if(sr){ openStockFromBusiness(Number(sr.dataset.idx)); return; } }
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const row = closestEl(e, '.biz-row'); if(row){ e.preventDefault(); toggleRow(row); }
  });
}

// After a refresh started here has saved its stocks, redraw so the grid shows the new numbers.
document.addEventListener('alba-batch-done', (e) => { const sec = appSections.business; if(/** @type {CustomEvent} */ (e).detail && /^biz-/.test(/** @type {CustomEvent} */ (e).detail.source) && sec && sec.classList.contains('active')) render(); });
function show(){ render(); ensureData(); }
// The tiles' text depends on the width, so redraw the heat map when the window is resized.
let resizeT = null;
window.addEventListener('resize', () => { if(view !== 'heat') return; clearTimeout(resizeT); resizeT = setTimeout(() => { const s = appSections.business; if(s && s.classList.contains('active')) render(); }, 200); });

export { init, show };
