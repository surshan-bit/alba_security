// Analysis leaderboard column definitions, cells and the reorder-columns panel.
import { stockShareLink } from '../ui/deeplink.js';
import { industryMedianW } from '../core/industrystats.js';
import { daysSinceDate, escapeHtml, pctChangeSpan, screenerUrl, tickerIndustry, tickerSymbol } from '../core/util.js';
import { analysisQueuePriceLoad, researchTriggerDone, getResearchTriggerKinds, getResearchTriggers, stockResearchAgeDays, stockResearchAsof } from '../research/status.js';
import { getAnalysisColumnsPanelOpen, analysisFilters } from './state.js';
import { tvUrlFor } from '../tv/links.js';
import { pcTickerKey, priceLoaded } from '../prices/store.js';
import { isPinned } from '../core/pins.js';
import { mosPct, mosRatingAny, scoreBand } from '../list/metrics.js';
import { techRatingInfo } from '../detail/technical.js';
import { newsCellHtml, newsCounts } from '../strategies/news.js';
import { ideaRankOf, ideasWhen } from './ideasfilter.js';

// Analysis leaderboard column registry (added 2026-10-06) — the table's columns used to be
// hardcoded in both the <thead> markup and the per-row <td> template, in a fixed order. Both
// are now driven off this single list plus a persisted order (analysisFilters.columnOrder), so
// the "Columns" panel can reorder them by just reordering ids, not touching markup twice.
const ANALYSIS_LB_COLUMNS = [
  { id: 'pin', label: '' },
  { id: 'rank', label: '#', num: true },
  { id: 'score', label: 'Fund', num: true, title: 'Fundamental score (0-10)', sortName: 'Fundamental Score' },
  { id: 'techScore', label: 'Tech', num: true, title: 'Technical score (0-10): momentum from price trend and RSI' },
  // Tech 2 and Tech 3 are not shown in this grid (hidden in v1.261). They are still computed and stay available in Strategies (fields) and on each stock's page.
  { id: 'mos', label: 'MoS', num: true, sortName: 'Margin of Safety' },
  { id: 'stock', label: 'Stock', sortName: 'Name' },
  { id: 'weekChg', label: 'W % chg', num: true, sortName: 'Weekly % change' },
  { id: 'monthChg', label: 'M % chg', num: true, sortName: 'Monthly % change' },
  { id: 'weekRsi', label: 'W RSI', num: true },
  { id: 'monthRsi', label: 'M RSI', num: true },
  { id: 'techW', label: 'W Tech Rating' },
  { id: 'techM', label: 'M Tech Rating' },
  { id: 'idea', label: 'Buy / Sell', sortName: 'Buy / Sell rank', title: 'Call and rank (1 is best) from the last Process in the Trade Log: the strategy chosen in Analysis, else the newest result' },
  { id: 'news', label: 'News 14d', num: true, title: 'Positive and negative news items in the last 14 days' },
  { id: 'industry', label: 'Industry' },
  { id: 'triggered', label: 'Research done' },
  { id: 'price', label: 'Price', num: true },
  { id: 'screener', label: 'Screener.in' },
  { id: 'tv', label: 'TradingView' },
];
const ANALYSIS_LB_COLUMN_IDS = ANALYSIS_LB_COLUMNS.map(c => c.id);
const ANALYSIS_LB_COLUMN_MAP = new Map(ANALYSIS_LB_COLUMNS.map(c => [c.id, c]));
// Guards against a stale/corrupt persisted order (an unknown id, or a column added to the app
// after the order was saved) by filtering to known ids and appending anything missing, rather
// than silently dropping a column or crashing on an unrecognized one.
function analysisColumnOrder(){
  const saved = Array.isArray(analysisFilters.columnOrder)
    ? analysisFilters.columnOrder.filter(id => ANALYSIS_LB_COLUMN_MAP.has(id))
    : [];
  // A column added after the order was saved (e.g. "Researched") is slotted in right after the
  // column that precedes it in the default list, so it shows up next to its neighbours instead of
  // being appended past the far-right TradingView link where it is easy to miss.
  const out = saved.slice();
  ANALYSIS_LB_COLUMN_IDS.forEach((id, k) => {
    if(out.includes(id)) return;
    let at = 0;
    for(let j = k - 1; j >= 0; j--){ const p = out.indexOf(ANALYSIS_LB_COLUMN_IDS[j]); if(p >= 0){ at = p + 1; break; } }
    out.splice(at, 0, id);
  });
  return out;
}
const rsiText = (v) => typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '';
// Numeric columns are right-aligned like the Strategies table (the `num` class).
function analysisLbCell(colId, ctx){
  const html = analysisLbCellRaw(colId, ctx);
  const col = ANALYSIS_LB_COLUMN_MAP.get(colId);
  if(!col || !col.num) return html;
  return /^<td class="/.test(html) ? html.replace('<td class="', '<td class="num ') : html.replace('<td', '<td class="num"');
}
function analysisLbCellRaw(colId, ctx){
  const { s, i, idx, r, mosLabel, mosClass, price, pinned, scoreLabel, techWCell, techMCell } = ctx;
  switch(colId){
    case 'score': return !scoreLabel ? '<td class="analysis-lb-score"></td>' : `<td class="analysis-lb-score"><span class="badge b-${s.verdict}" style="padding:1px 8px;font-size:.68rem;">${scoreLabel}</span></td>`;
    case 'techScore': {
      const ts = s.technical && typeof s.technical.score === 'number' ? s.technical.score : null;
      return ts === null ? '<td class="analysis-lb-score"></td>' : `<td class="analysis-lb-score"><span class="badge b-${scoreBand(ts).replace('fs-', '')}" style="padding:1px 8px;font-size:.68rem;">${ts.toFixed(1)}</span></td>`;
    }
    case 'pin': return `<td><button type="button" class="pin-btn${pinned ? ' pinned' : ''}" data-ticker="${escapeHtml(s.ticker)}" title="${pinned ? 'Unpin' : 'Pin to top'}">${pinned ? '★' : '☆'}</button></td>`;
    case 'rank': return `<td class="analysis-lb-rank">${i + 1}</td>`;
    case 'stock': return `<td><a class="stock-link" href="${escapeHtml(stockShareLink(s))}"><span class="analysis-lb-name">${escapeHtml(s.name)}</span></a><span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}</span></td>`;
    case 'industry': {
      const m = industryMedianW(s);
      const chg = m === null ? '' : `<span class="ind-w ${m > 0 ? 'chg-up' : m < 0 ? 'chg-down' : ''}" title="Median weekly change of this industry">${m > 0 ? '+' : ''}${m.toFixed(1)}% W</span> `;
      return `<td class="analysis-lb-industry">${chg}${escapeHtml(tickerIndustry(s))}</td>`;
    }
    case 'mos': return `<td class="analysis-lb-mos ${mosClass}" data-live="mos">${mosLabel}</td>`;
    case 'researched': {
      const d = stockResearchAgeDays(s);
      if(d === null) return '<td class="analysis-lb-researched rs-none" title="Not researched yet">Never</td>';
      const cls = d <= 30 ? 'rs-fresh' : (d <= 90 ? 'rs-aging' : 'rs-old');
      const label = d === 0 ? 'Today' : (d === 1 ? '1 day ago' : `${d} days ago`);
      return `<td class="analysis-lb-researched ${cls}" title="Research saved ${escapeHtml(String(stockResearchAsof(s)))}">${label}</td>`;
    }
    case 'triggered': {
      const sym = tickerSymbol(s);
      const t = getResearchTriggers().get(sym);
      const d = daysSinceDate(t);
      // Research saved more recently than the last trigger (for example by Live Data Refresh, which does not stamp a trigger) counts as done then.
      const savedDays = stockResearchAgeDays(s);
      if(savedDays !== null && (d === null || savedDays < d)){
        const savedLabel = savedDays === 0 ? 'Today' : (savedDays === 1 ? '1 day ago' : `${savedDays} days ago`);
        return `<td class="analysis-lb-researched rs-fresh" title="Research saved ${escapeHtml(String(stockResearchAsof(s)))}">${savedLabel}</td>`;
      }
      if(d === null) return '<td class="analysis-lb-researched rs-none" title="Research has not been triggered from this page yet"></td>';
      const kind = getResearchTriggerKinds().get(sym) || '';
      if(kind !== 'full' && !priceLoaded.has(pcTickerKey(s))) analysisQueuePriceLoad(s);   // fetch time comes from priceHistory (lazy)
      // Triggered, but the work it asked for has not been saved since: probably still pending.
      const pending = (kind !== 'full' && !priceLoaded.has(pcTickerKey(s))) ? false : !researchTriggerDone(s, t, kind);
      const label = d === 0 ? 'Today' : (d === 1 ? '1 day ago' : `${d} days ago`);
      const when = new Date(t); const whenTxt = isNaN(when.getTime()) ? String(t) : when.toLocaleString();
      const what = kind === 'price' ? 'price history only' : 'research';
      return `<td class="analysis-lb-researched ${pending ? 'rs-aging' : 'rs-fresh'}" title="${escapeHtml(what)} triggered ${escapeHtml(whenTxt)}${pending ? ' - nothing saved since' : ' - saved afterwards'}">${label}${kind === 'price' ? ' &middot; price only' : ''}${pending ? ' &middot; awaiting save' : ''}</td>`;
    }
    case 'idea': return ideaCellHtml(s);
    case 'news': return newsCellHtml(s);
    case 'weekRsi': return `<td>${rsiText(r.weekRsi)}</td>`;
    case 'monthRsi': return `<td>${rsiText(r.monthRsi)}</td>`;
    case 'techW': return `<td>${techWCell}</td>`;
    case 'techM': return `<td>${techMCell}</td>`;
    case 'weekChg': return `<td data-live="weekChg">${pctChangeSpan(r.weekPctChange)}</td>`;
    case 'monthChg': return `<td data-live="monthChg">${pctChangeSpan(r.monthPctChange)}</td>`;
    case 'price': return `<td data-live="price">${price}</td>`;
    case 'screener': return `<td><a href="${screenerUrl(s)}" target="_blank" rel="noopener noreferrer" class="analysis-lb-link" onclick="event.stopPropagation()">Screener ↗</a></td>`;
    case 'tv': return `<td><a href="${tvUrlFor(s)}" target="_blank" rel="noopener noreferrer" class="analysis-lb-link" onclick="event.stopPropagation()">TV ↗</a></td>`;
    default: return '<td></td>';
  }
}
// v1.321: the Buy / Sell column: the call as a tag (a stock you hold shows its Trade Log call) and the rank in the strategy, from the saved Process result.
const IDEA_BADGE = { 'Buy': 'b-buy', 'Add more': 'b-buy', 'Wait': 'b-hold', 'Hold': 'b-hold', 'Review': 'b-mbuy', 'Trim': 'b-avoid', 'Avoid': 'b-avoid' };
function ideaCellHtml(s){
  const r = ideaRankOf(s, analysisFilters.strategyId);
  if(!r) return '<td class="analysis-lb-idea"></td>';
  const title = `${r.label}${r.held ? ' (you hold it)' : ''}: rank ${r.rank} of ${r.n} in this strategy, processed ${ideasWhen(r.snap)}`;
  return `<td class="analysis-lb-idea" title="${escapeHtml(title)}"><span class="badge ${IDEA_BADGE[r.label] || 'b-hold'}" style="padding:1px 8px;font-size:.68rem;">${escapeHtml(r.label)}</span> ${r.rank}</td>`;
}
// Everything a row's cells need, shared by the Analysis leaderboard and the Strategies table so both show the same cells.
function techCell(s, key){
  const t = techRatingInfo(s.technical && s.technical.states && s.technical.states[key]);
  return t ? `<span class="badge ${t.cls}" style="padding:1px 8px;font-size:.68rem;">${t.label}</span>` : '';
}
function analysisRowContext(s, i, idx){
  const r = (s.technical && s.technical.raw) || {};
  const mos = mosPct(s);
  const mosLabel = mos === -Infinity ? '' : `${mos >= 0 ? '+' : ''}${mos.toFixed(1)}%`;
  const mosRating = mosRatingAny(s);
  const mosClass = mosRating ? `mos-${mosRating}` : 'mos-none';
  const price = s.valuation && s.valuation.currentPrice != null ? `₹${s.valuation.currentPrice.toLocaleString('en-IN')}` : '';
  const pinned = isPinned(s);
  const scoreLabel = s.score != null ? s.score.toFixed(1) : '';
  return { s, i, idx, r, mosLabel, mosClass, price, pinned, scoreLabel, techWCell: techCell(s, 'weekMacd'), techMCell: techCell(s, 'monthMacd') };
}
// The columns of every other stock grid (Strategies, Explorer, a stock's peers): the Analysis "Columns" setting (its order), without the
// pin column, which only the Analysis leaderboard has. Change the order once in Analysis and every grid follows.
const stockGridColumnIds = () => analysisColumnOrder().filter(id => id !== 'pin');
// ---- sorting by a column header ----
// Every grid that draws its header with columnHeaderHtml(id, sort) gets clickable headers: a click sorts by that column, a second click reverses it.
// `sort` is { col, dir } ('asc' | 'desc'). A stock with no figure for the column always goes last, whichever way the column is sorted.
const finiteOrNull = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const rawOf = (s, key) => finiteOrNull(s.technical && s.technical.raw ? s.technical.raw[key] : null);
const TECH_STATE_RANK = { bull_above: 4, bull_below: 3, bear_above: 2, bear_below: 1 };
const techRank = (s, key) => { const v = s.technical && s.technical.states ? TECH_STATE_RANK[s.technical.states[key]] : undefined; return v === undefined ? null : v; };
// Days since research was saved or triggered, whichever is the more recent (what the "Research done" cell shows).
function researchDoneDays(s){
  const saved = stockResearchAgeDays(s), trig = daysSinceDate(getResearchTriggers().get(tickerSymbol(s)));
  const days = [saved, trig].filter(v => v !== null && v !== undefined);
  return days.length ? Math.min(...days) : null;
}
const SORT_VALUE = {
  score: (s) => finiteOrNull(s.score),
  techScore: (s) => finiteOrNull(s.technical ? s.technical.score : null),
  mos: (s) => { const m = mosPct(s); return m === -Infinity ? null : m; },
  stock: (s) => String(s.name || '').toLowerCase(),
  weekChg: (s) => rawOf(s, 'weekPctChange'),
  monthChg: (s) => rawOf(s, 'monthPctChange'),
  weekRsi: (s) => rawOf(s, 'weekRsi'),
  monthRsi: (s) => rawOf(s, 'monthRsi'),
  techW: (s) => techRank(s, 'weekMacd'),
  techM: (s) => techRank(s, 'monthMacd'),
  idea: (s) => { const r = ideaRankOf(s, analysisFilters.strategyId); return r ? r.rank : null; },
  news: (s) => { const c = newsCounts(s); return c ? c.pos - c.neg : null; },
  industry: (s) => tickerIndustry(s).toLowerCase(),
  triggered: researchDoneDays,
  price: (s) => finiteOrNull(s.valuation ? s.valuation.currentPrice : null)
};
const isSortableColumn = (id) => Object.prototype.hasOwnProperty.call(SORT_VALUE, id);
// The direction a column sorts in the first time it is clicked: words A to Z, ratings and figures best (highest) first, research done most recent first.
const firstSortDir = (id) => (id === 'stock' || id === 'industry' || id === 'name' || id === 'triggered' || id === 'idea') ? 'asc' : 'desc';
// A comparer that orders by `valueOf(item)` (a number, a string, or null for "no figure", which always goes last).
function compareBy(valueOf, dir){
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = valueOf(a), y = valueOf(b);
    if(x === null || y === null) return x === y ? 0 : (x === null ? 1 : -1);
    if(typeof x === 'string') return sign * x.localeCompare(/** @type {string} */ (y));
    return sign * (x - /** @type {number} */ (y));
  };
}
const compareByColumn = (col, dir) => compareBy(SORT_VALUE[col] || (() => null), dir);
// What a click on column `id` changes the sort to.
const nextSort = (sort, id) => sort && sort.col === id ? { col: id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col: id, dir: firstSortDir(id) };
const sortLabelOf = (sort) => { const c = ANALYSIS_LB_COLUMN_MAP.get(sort.col); return (c ? (c.sortName || c.label) : sort.col) + (sort.dir === 'asc' ? ' (low to high)' : ' (high to low)'); };
// One sortable header cell: the label as a button (with an arrow when it is the sorted column). `extra` is the th's own attributes.
function sortHeaderHtml(id, label, sort, extra){
  const on = !!sort && sort.col === id;
  return `<th${extra || ''} aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-sort${on ? ' on' : ''}" data-sort-col="${id}" title="Sort by ${escapeHtml(label)}">${escapeHtml(label)}<span class="th-arrow" aria-hidden="true">${on ? (sort.dir === 'asc' ? '&#9650;' : '&#9660;') : ''}</span></button></th>`;
}
function columnHeaderHtml(id, sort){
  const c = ANALYSIS_LB_COLUMN_MAP.get(id);
  if(!c) return '';
  const extra = (c.num ? ' class="num"' : '') + (c.title ? ` title="${escapeHtml(c.title)}"` : '');
  if(!sort || !isSortableColumn(id)) return `<th${extra}>${escapeHtml(c.label)}</th>`;
  return sortHeaderHtml(id, c.label, sort, extra);
}

function renderAnalysisColumnsPanel(colOrder){
  if(!getAnalysisColumnsPanelOpen()) return '';
  const grip = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
  const rows = colOrder.map((id) => {
    const col = ANALYSIS_LB_COLUMN_MAP.get(id);
    const label = col.label || (id === 'pin' ? 'Pin' : id);
    return `
      <div class="analysis-column-row" data-col="${id}">
        <button type="button" class="analysis-col-grip" data-col="${id}" aria-label="Move ${escapeHtml(label)}: drag it, or press the up and down arrow keys" title="Drag to move">${grip}</button>
        <span class="analysis-column-label">${escapeHtml(label)}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="analysis-columns-panel" id="analysisColumnsPanel">
      <div class="analysis-columns-panel-title">Reorder columns <span class="analysis-columns-hint">drag a row by its handle</span></div>
      <div class="analysis-columns-list">${rows}</div>
      <button type="button" class="analysis-reset-btn" id="analysisColumnsResetBtn">Reset order</button>
    </div>
  `;
}

export { ANALYSIS_LB_COLUMN_IDS, analysisColumnOrder, analysisLbCell, analysisRowContext, columnHeaderHtml, compareBy, compareByColumn, nextSort, renderAnalysisColumnsPanel, sortHeaderHtml, sortLabelOf, stockGridColumnIds };
