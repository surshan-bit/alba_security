// The Explorer page (code name "business"): every industry with its average price change over a chosen period, and the news of its stocks.
import { stockIndex, stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { ensureAllPriceBars, pcTickerKey, priceHistoryByTicker } from '../prices/store.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { analysisLbCell, analysisRowContext, columnHeaderHtml, stockGridColumnIds } from '../analysis/columns.js';
import { publishedStrategies } from '../strategies/state.js';
import { strategyStockSet, validStrategyId } from '../strategies/pick.js';
import { getNewsRun, planNews, startNewsCollect, stopNewsCollect } from './news.js';
import { prefSet } from '../identity/prefs.js';
import { ldBatchStart, ldBatchStop } from '../livedata/batch.js';
import { browserFullscreen, fullscreenLabel, watchFullscreenExit } from '../ui/fullscreen.js';
import { ldOpenPermissions } from '../livedata/bar.js';
import { createBatchRounds, liveCardsHtml, paintBatchCards } from '../livedata/panel.js';
import { heatmapHtml } from './heatmap.js';
import { PERIODS, industryTable, needsBars, periodOf } from './calc.js';

const KEY = 'albaDashboard.business.v1';
let bizFull = false;   // the table fills the whole window
const newsOpen = new Set();   // industries whose News section is unfolded (folded at first)
let bizFiltersOpen = false;   // phones: the view, period, grouping and strategy controls fold into one "Filters" line, closed at first
let period = '1M', by = 'industry', view = 'table', strategyId = '', showMatched = false, loadState = 'idle';   // loadState: 'idle' | 'loading' | 'failed' (price bars for long periods)
const open = new Set();                                    // industries whose detail is open
try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); if(PERIODS.some(p => p.key === v.period)) period = v.period; if(v.by === 'group') by = 'group'; if(v.view === 'heat') view = 'heat'; if(typeof v.strategy === 'string') strategyId = v.strategy; if(v.matched === true) showMatched = true; } catch(e){ /* storage unavailable: defaults */ }
// Saved to this person's preferences (and mirrored in the browser).
const save = () => { prefSet(KEY, JSON.stringify({ period, by, view, strategy: strategyId, matched: showMatched })); };

const barsFor = (s) => { const d = priceHistoryByTicker[pcTickerKey(s)]; return d ? d['1W'] : undefined; };
const pct = (v) => v === null ? '<span class="biz-na">n/a</span>' : '<span class="' + (v > 0 ? 'chg-up' : v < 0 ? 'chg-down' : '') + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
const bodyEl = () => document.getElementById('businessBody');

// The stocks that qualify for the strategy chosen here (none chosen: no highlighting, no extra columns).
const chosenStrategy = () => validStrategyId(strategyId);
const strategyOn = () => !!chosenStrategy();
const matchSet = () => strategyStockSet(chosenStrategy()) || new Set();
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
// One button for all of the stocks and, when the Analysis filters are on and only some of them match, one for just the matching ones.
function newsButtons(members, matched, key){
  const r = getNewsRun(), busy = !!r && r.state === 'running';
  const one = (list, mode, text) => {
    const plan = planNews(list), n = plan.stocks.length;
    return '<button type="button" class="biz-expand biz-newsbtn" data-biz-news="' + escapeHtml(key) + '|' + mode + '"' + (busy || !list.length ? ' disabled' : '') + ' title="Reads the latest headlines from TradingView for these stocks and saves them">' + (plan.again ? 'Refresh news' : 'Collect latest news') + ' · ' + text + ' (' + n + (plan.left ? ', then ' + plan.left + ' more' : '') + ')</button>';
  };
  const hit = strategyOn() ? matched : [];
  return one(members, 'all', members.length === 1 ? 'the stock' : 'all ' + members.length + ' stocks') + (hit.length && hit.length < members.length ? ' ' + one(hit, 'match', 'matching ' + hit.length) : '');
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
  document.querySelectorAll('.biz-newsbtn').forEach(b => { b.disabled = true; });
}

function newsHtml(r){
  if(!r.news.length) return '<p class="upload-hint">No news saved for these stocks in this period. Headlines come from Refresh Fundamental Info, so stocks that have not been refreshed recently have none.</p>';
  return '<ul class="biz-news">' + r.news.slice(0, 15).map(n => {
    const tag = n.s === 'pos' ? '<span class="news-pos">positive</span>' : n.s === 'neg' ? '<span class="news-neg">negative</span>' : '';
    const title = /^https?:\/\//i.test(n.url) ? '<a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(n.t) + '</a>' : escapeHtml(n.t);
    return '<li><span class="biz-news-date">' + escapeHtml(n.d) + '</span> ' + tag + ' ' + title + '<span class="biz-news-meta"> · ' + escapeHtml(n.stock) + (n.src ? ' · ' + escapeHtml(n.src) : '') + '</span></li>';
  }).join('') + '</ul>' + (r.news.length > 15 ? '<p class="upload-hint">Showing the newest 15 of ' + r.news.length + '.</p>' : '');
}
// Technical and Fundamental refresh for the stocks of one industry (the same refreshes as the other screens). Each open industry has its own panel id ("biz-N") so several can be open at once.
const panelIds = new Map();
const panelId = (name) => { if(!panelIds.has(name)) panelIds.set(name, 'biz-' + panelIds.size); return panelIds.get(name); };
// Each press does the next batch of the industry's stocks (ranks 1-50, then 51-100 and so on), like the Analysis screen. One cursor per industry.
const roundsOf = new Map();
const roundsFor = (name) => { if(!roundsOf.has(name)) roundsOf.set(name, createBatchRounds()); return roundsOf.get(name); };
const refreshStocks = (r) => r.items.map(x => x.stock);
const refreshKey = (r) => r.name + ':' + r.items.length;
function refreshHtml(r){
  const P = panelId(r.name);
  return '<div class="biz-refresh" data-live-panel="' + P + '">' + liveCardsHtml(P, { fund: 'bizRefFund-' + P, tech: 'bizRefTech-' + P }) + '</div>';
}
function paintRefreshCards(rows){
  rows.filter(r => open.has(r.name)).forEach(r => paintBatchCards(panelId(r.name), roundsFor(r.name), refreshStocks(r), refreshKey(r), 'stocks'));
}
// The industry's stocks in the same grid as the Analysis leaderboard and the Strategies results (best change first),
// with the period's own change as the last column.
function detailHtml(r, cols){
  const p = periodOf(period), colIds = stockGridColumnIds();   // the column order set in Analysis
  const rows = r.items.filter(x => !matchedOnly() || x.match).map((x, i) => {
    const idx = stockIndex.get(x.stock), ctx = analysisRowContext(x.stock, i, idx);
    return '<tr class="strat-row' + (x.match ? ' biz-match' : '') + '" data-idx="' + idx + '" tabindex="0">' + colIds.map(id => analysisLbCell(id, ctx)).join('') + '<td class="num">' + pct(x.change) + '</td></tr>';
  }).join('');
  const grid = '<div class="strat-table-wrap"><table class="strat-table"><thead><tr>' + colIds.map(columnHeaderHtml).join('') + '<th class="num">' + p.key + ' chg</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  return '<tr class="biz-detail"><td colspan="' + cols + '"><div class="biz-detail-box"><div class="biz-stocks-head"><h3>Stocks</h3>' + (strategyOn() ? '<span class="upload-hint">' + r.matches + ' of ' + r.count + ' match the strategy</span>' : '') + '</div>' + grid + refreshHtml(r) + '<div class="biz-stocks-head biz-news-bar"><h3 class="biz-news-head"><button type="button" class="biz-news-toggle" data-biz-newstoggle="' + escapeHtml(r.name) + '" aria-expanded="' + newsOpen.has(r.name) + '">' + (newsOpen.has(r.name) ? '\u25be' : '\u25b8') + ' News' + (r.news.length ? ' (' + r.news.length + ')' : '') + '</button></h3>' + (newsOpen.has(r.name) ? newsButtons(r.items.map(x => x.stock), r.items.filter(x => x.match).map(x => x.stock), r.name) : '') + newsStatusFor(r.name) + '</div>' + (newsOpen.has(r.name) ? newsHtml(r) : '') + '</div></td></tr>';
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
  return '<div class="filters analysis-filters-panel biz-strategy-panel"><div class="filter-group"><h2>Strategy</h2><div class="filter-group-row">' + list.join('') + '</div></div></div>';
}
// The view, period, grouping and strategy controls sit in a column beside the content, like the Analysis filters.
// The "Filters" line (phones only; wide screens show the controls beside the table): what is chosen, and a click opens the controls.
function filtersToggleHtml(){
  const x = publishedStrategies().find(y => y.id === chosenStrategy());
  const summary = [view === 'heat' ? 'Heat map' : 'Table', periodOf(period).key, by === 'group' ? 'Industry group' : 'Industry', x ? x.name : 'All'].join(' \u00b7 ');
  return '<button type="button" class="biz-filters-toggle" data-biz-filters="1" aria-expanded="' + bizFiltersOpen + '"><span class="ft-label">Filters</span><span class="ft-summary">' + escapeHtml(summary) + '</span><span class="ft-caret" aria-hidden="true">\u25be</span></button>';
}
const layoutHtml = (controls, main) => '<div class="biz-layout"><aside class="biz-side' + (bizFiltersOpen ? '' : ' filters-collapsed') + '">' + filtersToggleHtml() + controls + '</aside><div class="biz-main' + (bizFull ? ' biz-full' : '') + '">' + main + '</div></div>';

// Redraws the page but keeps the sideways scroll of each stocks grid, so a redraw during a refresh does not jump the view.
function render(){
  const el = bodyEl(); if(!el) return;
  const lefts = Array.from(el.querySelectorAll('.strat-table-wrap, .biz-scroll')).map(w => w.scrollLeft);
  draw(el);
  el.querySelectorAll('.strat-table-wrap, .biz-scroll').forEach((w, i) => { if(lefts[i]) w.scrollLeft = lefts[i]; });
}
function draw(el){
  if(view === 'heat') bizFull = false;   // full screen is for the table
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
    + '<button type="button" class="tl-view-btn' + (matchedOnly() ? ' active' : '') + '" data-biz-show="matched"' + (strategyOn() ? ' title="Show only the industries and stocks that match the chosen strategy"' : ' disabled title="Choose a strategy first"') + '>Matched</button></div>';
  const expandBtn = viewToggle + '<button type="button" class="biz-expand" data-biz-all="' + (allOpen ? 'collapse' : 'expand') + '">' + (allOpen ? 'Collapse all' : 'Expand all') + '</button>'
    + '<button type="button" class="biz-expand" data-biz-full="1" aria-pressed="' + bizFull + '" title="Show the table across the whole window (Esc to leave)">' + fullscreenLabel(bizFull) + '</button>';
  let status = '';
  if(needsBars(period)){
    if(loadState === 'loading') status = '<p class="upload-hint">Loading price history…</p>';
    else if(loadState === 'failed') status = '<p class="upload-hint biz-warn">Could not load the price history, so ' + p.label + ' figures are missing. <button type="button" class="refresh-btn" data-biz-retry="1">Retry</button></p>';
  }
  const total = rows.reduce((a, r) => a + r.matches, 0);
  const filterNote = strategyOn() ? '<p class="upload-hint biz-showing">Mapped ' + total + ' of ' + stocks.length + ' stocks</p>' : '';
  const note = '';
  const head = '<tr><th>' + (by === 'group' ? 'Industry group' : 'Industry') + '</th><th class="num">Stocks</th><th class="num">Average ' + p.key + '</th><th class="num">Median</th><th>Up / down</th><th class="num">News</th>' + (strategyOn() ? '<th class="num">Matching</th><th class="num">Match avg ' + p.key + '</th><th class="num">vs industry</th>' : '') + '</tr>';
  const cols = strategyOn() ? 9 : 6;
  const body = rows.map(r => {
    const isOpen = open.has(r.name);
    return '<tr class="biz-row' + (isOpen ? ' open' : '') + '" data-biz-name="' + escapeHtml(r.name) + '" tabindex="0" role="button" aria-expanded="' + isOpen + '"><td class="biz-name">' + escapeHtml(r.name) + '</td><td class="num">' + r.count + '</td><td class="num">' + pct(r.mean) + '</td><td class="num">' + pct(r.median) + '</td><td>' + breadth(r) + '</td><td class="num">' + (r.news.length ? r.news.length + (r.pos || r.neg ? ' <span class="news-pos">+' + r.pos + '</span> <span class="news-neg">&minus;' + r.neg + '</span>' : '') : '') + '</td>' + (strategyOn() ? '<td class="num">' + (r.matches ? '<b class="biz-matchcount">' + r.matches + '</b> of ' + r.count : '') + '</td><td class="num">' + (r.matches && r.matchMean !== null ? pct(r.matchMean) : '') + '</td><td class="num">' + (r.matches && r.matchMean !== null && r.mean !== null ? signedPp(r.matchMean - r.mean) : '') + '</td>' : '') + '</tr>' + (isOpen ? detailHtml(r, cols) : '');
  }).join('');
  if(view === 'heat'){ el.innerHTML = layoutHtml(controls, status + heatmapHtml(rows, period, Math.max(300, el.clientWidth - 280)) + note); return; }
  el.innerHTML = layoutHtml(controls, status + '<div class="biz-toolbar">' + filterNote + expandBtn + '</div>' + '<div class="biz-scroll"><table class="biz-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + note);
  paintRefreshCards(rows);
}

function ensureData(){
  if(!needsBars(period) || loadState === 'loading') return;
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
    const nt = e.target.closest('[data-biz-newstoggle]');
    if(nt){ const n = nt.dataset.bizNewstoggle; if(newsOpen.has(n)) newsOpen.delete(n); else newsOpen.add(n); render(); return; }
    if(e.target.closest('[data-biz-filters]')){ bizFiltersOpen = !bizFiltersOpen; render(); return; }
    if(e.target.closest('[data-biz-full]')){ bizFull = !bizFull; browserFullscreen(bizFull); render(); return; }
    const sb = e.target.closest('[data-biz-strat]');
    if(sb){ strategyId = sb.dataset.bizStrat; save(); render(); return; }
    const shw = e.target.closest('[data-biz-show]');
    if(shw){ if(shw.disabled) return; showMatched = shw.dataset.bizShow === 'matched'; save(); render(); return; }
    const vb = e.target.closest('[data-biz-view]'), ht = e.target.closest('[data-biz-heat]');
    if(vb){ view = vb.dataset.bizView; save(); render(); return; }
    if(ht){   // a heat-map tile: back to the table with that industry opened
      view = 'table'; save(); open.add(ht.dataset.bizHeat); render();
      const row = Array.from(el.querySelectorAll('.biz-row')).find(r => r.dataset.bizName === ht.dataset.bizHeat);
      if(row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
      return;
    }
    const pb = e.target.closest('[data-biz-period]'), gb = e.target.closest('[data-biz-by]');
    if(pb){ period = pb.dataset.bizPeriod; save(); open.clear(); render(); ensureData(); return; }
    if(gb){ by = gb.dataset.bizBy; save(); open.clear(); render(); return; }
    const rb = e.target.closest('.biz-refresh .refresh-btn'), rs = e.target.closest('.biz-refresh .live-stop');
    if(rs){ if(/Perm$/.test(rs.id)) ldOpenPermissions(); else ldBatchStop(); return; }
    if(rb){
      const P = rb.closest('.biz-refresh').dataset.livePanel, kind = /^bizRefFund-/.test(rb.id) ? 'fund' : 'tech', name = Array.from(panelIds).find(x => x[1] === P)[0];
      const r = industryTable(stocks, { by, period, barsFor }).find(x => x.name === name);
      if(r){ const list = roundsFor(name).take(kind, refreshStocks(r), refreshKey(r)); if(list.length) ldBatchStart(kind, list, P); }
      return;
    }
    const nb = e.target.closest('[data-biz-news]');
    if(nb){ runNews(nb.dataset.bizNews); return; }
    if(e.target.closest('[data-biz-newsstop]')){ stopNewsCollect(); return; }
        const all = e.target.closest('[data-biz-all]');
    if(all){
      if(all.dataset.bizAll === 'collapse') open.clear();
      else visibleRows().forEach(r => open.add(r.name));
      render(); return;
    }
    if(e.target.closest('[data-biz-retry]')){ loadState = 'idle'; ensureData(); return; }
    if(e.target.closest('a:not(.stock-link)')) return;
    const sr = e.target.closest('.strat-row');
    if(sr){ openStockFromBusiness(Number(sr.dataset.idx)); return; }
    const row = e.target.closest('.biz-row'); if(row) toggleRow(row);
  });
  el.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ const sr = e.target.closest('.strat-row'); if(sr){ openStockFromBusiness(Number(sr.dataset.idx)); return; } }
    if(e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.biz-row'); if(row){ e.preventDefault(); toggleRow(row); }
  });
}

// After a refresh started here has saved its stocks, redraw so the grid shows the new numbers.
document.addEventListener('alba-batch-done', (e) => { const sec = appSections.business; if(e.detail && /^biz-/.test(e.detail.source) && sec && sec.classList.contains('active')) render(); });
function show(){ render(); ensureData(); }
// The tiles' text depends on the width, so redraw the heat map when the window is resized.
let resizeT = null;
window.addEventListener('resize', () => { if(view !== 'heat') return; clearTimeout(resizeT); resizeT = setTimeout(() => { const s = appSections.business; if(s && s.classList.contains('active')) render(); }, 200); });

export { init, show };
