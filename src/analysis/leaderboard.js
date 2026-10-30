// The Analysis leaderboard table: ranking, header and rows, and its click handling.
import { stockIndex, stocks } from '../core/stocks.js';
import { isPinned, togglePin } from '../core/pins.js';
import { getAnalysisColumnsPanelOpen, setAnalysisColumnsPanelOpen, analysisFilters, analysisPersistUi, setAnalysisShownIdx, saveAnalysisFilters } from './state.js';
import { analysisTakeBatch, defineAnalysisScope, updateAnalysisRefresh } from './selectbar.js';
import { ANALYSIS_LB_COLUMN_IDS, analysisColumnOrder, analysisLbCell, analysisRowContext, columnHeaderHtml, compareByColumn, nextSort, renderAnalysisColumnsPanel } from './columns.js';
import { ldOpenPermissions } from '../livedata/bar.js';
import { ldBatchStart, ldBatchStop } from '../livedata/batch.js';
import { browserFullscreen, fullscreenLabel, watchFullscreenExit } from '../ui/fullscreen.js';
import { getRefreshKit } from '../refresh/hook.js';
import { closestEl } from '../core/evt.js';

// Rows drawn at first and added by each "Show more": a table of thousands of rows is slow to lay out.
const LB_STEP = 100;
let lbRows = LB_STEP;

// ---- full screen ----
// The leaderboard can fill the whole window. The state lives here so a redraw of the section keeps it. Esc and the browser's own full screen are handled in ui/fullscreen.js.
let lbFull = false;
function paintFullscreen(){
  const box = document.querySelector('.analysis-leaderboard'), btn = document.getElementById('analysisFullscreenBtn');
  if(box) box.classList.toggle('lb-full', lbFull);
  document.body.classList.toggle('lb-full-open', lbFull);
  if(btn){
    const label = fullscreenLabel(lbFull) + ' (Esc to leave)';
    btn.innerHTML = iconBtnInner(lbFull ? 'shrink' : 'expand', fullscreenLabel(lbFull));
    btn.title = label; btn.setAttribute('aria-label', label); btn.setAttribute('aria-pressed', lbFull ? 'true' : 'false');
  }
}
function setLbFull(on){
  lbFull = !!on;
  paintFullscreen();
  browserFullscreen(lbFull);
}
function init_leaderboard_fullscreen(){
  watchFullscreenExit(() => lbFull, () => { lbFull = false; paintFullscreen(); });
}

// ---- markup ----
// One toolbar row: the Filters chip (docked here by filterpanel.js), the View selector (`viewHtml`), the count, and the Columns, Chart and Full screen
// icon buttons with Refresh. Below it: the RSI Quadrant block (`chartBlock`, hidden until opened), the columns panel, the table shell and the Live Data Refresh panel.
const ICONS = {
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>',
  chart: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  shrink: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'
};
const iconSvg = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
// The text label is hidden on a wide screen (the icon and its tooltip say it) and shown when the buttons sit in the phone filter sheet.
const iconBtnInner = (name, text) => `${iconSvg(name)}<span class="analysis-btn-label">${text}</span>`;
const iconBtn = (id, name, text, tip, state) => `<button type="button" class="analysis-icon-btn" id="${id}" title="${tip}" aria-label="${tip}"${state}>${iconBtnInner(name, text)}</button>`;
function leaderboardHtml(chartBlock, viewHtml){
  const headerColOrder = analysisColumnOrder(), kit = getRefreshKit();
  return `<div class="analysis-leaderboard${lbFull ? ' lb-full' : ''}">
      <div class="analysis-leaderboard-head analysis-toolbar">
        ${viewHtml}
        <div class="rk-headline"><p class="upload-hint biz-showing" style="margin:0"><span id="analysisLeaderboardCount" class="analysis-count"></span></p>${(defineAnalysisScope(), '')}</div>
        <div class="analysis-actions">
          ${iconBtn('analysisColumnsBtn', 'columns', 'Columns', 'Columns: choose and reorder the grid columns', ` aria-pressed="${getAnalysisColumnsPanelOpen()}"`)}
          ${iconBtn('analysisChartToggle', 'chart', 'Show chart', 'Show chart', ' aria-expanded="false"')}
          ${iconBtn('analysisFullscreenBtn', lbFull ? 'shrink' : 'expand', fullscreenLabel(lbFull), fullscreenLabel(lbFull) + ' (Esc to leave)', ` aria-pressed="${lbFull}"`)}
          ${kit ? kit.barHtml('analysis') : ''}
        </div>
      </div>
      ${chartBlock}
      ${renderAnalysisColumnsPanel(headerColOrder)}
      <div class="strat-table-wrap">
        <table class="strat-table">
          <thead><tr>${headerColOrder.map(id => columnHeaderHtml(id, analysisSort())).join('')}</tr></thead>
          <tbody id="analysisLeaderboardBody"></tbody>
        </table>
      </div>
      <div class="strat-empty" id="analysisLeaderboardMore" hidden></div>
      ${kit ? kit.selbarSlot('analysis') : ''}
    </div>`;
}

// ---- rows ----
// Pinned stocks (the same pin as the detail panel) always sort to the top; within each
// the list the order follows the column header that was clicked (default: Margin of Safety, highest first).
const analysisSort = () => ({ col: analysisFilters.sortCol, dir: analysisFilters.sortDir });
function rankStocks(filtered){
  const sortCmp = compareByColumn(analysisFilters.sortCol, analysisFilters.sortDir);
  return filtered.slice().sort((a, b) => {
    const pa = isPinned(a) ? 1 : 0, pb = isPinned(b) ? 1 : 0;
    if(pa !== pb) return pb - pa;
    return sortCmp(a, b);
  });
}

function leaderboardRowHtml(s, i, colOrder){
  const kit = getRefreshKit(), idx = stockIndex.get(s);
  const pinned = isPinned(s);
  const ctx = analysisRowContext(s, i, idx);
  return `
            <tr class="analysis-lb-row${pinned ? ' pinned' : ''}" data-idx="${idx}">
              ${colOrder.map(id => analysisLbCell(id, ctx)).join('')}
            </tr>
          `;
}

// Fills the count and the table body for the stocks currently in the chart's range.
function renderLeaderboardRows(filtered){
  const ranked = rankStocks(filtered);
  const lbCountEl = document.getElementById('analysisLeaderboardCount');
  if(lbCountEl){
    lbCountEl.textContent = `Showing ${ranked.length} of ${stocks.length} stocks`;
    lbCountEl.dataset.short = `${ranked.length} of ${stocks.length}`;
    const chip = document.getElementById('analysisFiltersCount');   // a phone shows the count inside the Filters chip instead of on a line of its own (phone.css)
    if(chip) chip.textContent = lbCountEl.dataset.short;
  }
  const lbBody = document.getElementById('analysisLeaderboardBody');
  const colOrder = analysisColumnOrder(), colSpan = colOrder.length + (getRefreshKit() ? 1 : 0);
  let drawn = Math.min(ranked.length, lbRows), drawable = ranked.length, rowsHtml;
  if(ranked.length === 0) rowsHtml = `<tr><td colspan="${colSpan}" class="analysis-lb-empty">No stocks in the current RSI range.</td></tr>`;
  else rowsHtml = ranked.slice(0, lbRows).map((s, i) => leaderboardRowHtml(s, i, colOrder)).join('');
  if(lbBody) lbBody.innerHTML = rowsHtml;
  const moreEl = document.getElementById('analysisLeaderboardMore');
  if(moreEl){
    moreEl.hidden = drawable <= drawn;
    moreEl.innerHTML = moreEl.hidden ? '' : `Showing the first ${drawn} rows. <button type="button" class="analysis-reset-btn" data-lb-more="1">Show ${Math.min(LB_STEP, drawable - drawn)} more</button>`;
  }
  // The refresh buttons work through the shown stocks in the order they are listed.
  setAnalysisShownIdx(ranked.map(s => stockIndex.get(s)));
  updateAnalysisRefresh();
}

// ---- wiring ----
// `update` redraws the dots and rows; `rerender` redraws the whole section (needed when the table's column set
// changes); `openStock(idx)` opens the stock's detail page; `hideTooltip` closes the chart tooltip.
function wireLeaderboard({ update, rerender, openStock, hideTooltip }){
  // Delegated: the table body persists across redraws, so one listener replaces rebinding every row and pin button.
  document.getElementById('analysisLeaderboardBody').addEventListener('click', (evt) => {
    const pinBtn = closestEl(evt, '.pin-btn');
    if(pinBtn){
      evt.stopPropagation();
      togglePin(pinBtn.dataset.ticker);
      update(); // togglePin() only re-renders the dashboard list/detail, so refresh this section too
      return;
    }
    const row = closestEl(evt, '.analysis-lb-row');
    if(!row) return;
    hideTooltip();
    openStock(Number(row.dataset.idx));
  });

  const moreEl = document.getElementById('analysisLeaderboardMore');
  if(moreEl) moreEl.addEventListener('click', (evt) => { if(closestEl(evt, '[data-lb-more]')){ lbRows += LB_STEP; update(); } });

  // A click on a column header sorts by it (again: reverses it). Only the order changes, so the rows are redrawn, not the whole section.
  const lbTable = document.querySelector('.analysis-leaderboard .strat-table thead');
  if(lbTable){
    lbTable.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-sort-col]'));
      if(!btn) return;
      const next = nextSort(analysisSort(), btn.dataset.sortCol || '');
      analysisFilters.sortCol = next.col; analysisFilters.sortDir = next.dir;
      saveAnalysisFilters(analysisFilters);
      rerender();
    });
  }

  const fsBtn = document.getElementById('analysisFullscreenBtn');
  if(fsBtn) fsBtn.addEventListener('click', () => setLbFull(!lbFull));
  paintFullscreen();
  wireRefreshControls();
  wireColumnControls(rerender);
}

// The two Live Data Refresh cards below the table: a press refreshes the next batch of the shown stocks (ranks 1-50, then 51-100, and so on).
function wireRefreshControls(){
  const on = (id, fn) => { const el = document.getElementById(id); if(el) el.addEventListener('click', fn); };
  on('analysisSelFund', () => ldBatchStart('fund', analysisTakeBatch('fund'), 'analysis'));
  on('analysisSelTech', () => ldBatchStart('tech', analysisTakeBatch('tech'), 'analysis'));
  on('analysisStop-fund', () => ldBatchStop());
  on('analysisStop-tech', () => ldBatchStop());
  on('analysisPerm', () => ldOpenPermissions());
}

// Reordering by drag and drop: grab a row by its handle and drop it where it belongs; the arrow keys move a focused handle one step.
// The rows shuffle while dragging and the new order is saved once, on release.
function wireColumnDrag(rerender){
  const list = document.querySelector('.analysis-columns-list');
  if(!list) return;
  const rowsOf = () => Array.from(list.querySelectorAll('.analysis-column-row'));
  const commit = (focusCol) => {
    const order = rowsOf().map(r => /** @type {HTMLElement} */ (r).dataset.col);
    if(order.join() === analysisColumnOrder().join()) return;
    analysisFilters.columnOrder = order;
    saveAnalysisFilters(analysisFilters);
    rerender();
    const g = focusCol && document.querySelector('.analysis-col-grip[data-col="' + focusCol + '"]');
    if(g) /** @type {HTMLElement} */ (g).focus();
  };
  list.addEventListener('pointerdown', (e) => {
    const grip = closestEl(e, '.analysis-col-grip');
    if(!grip || (/** @type {MouseEvent} */ (e).button != null && /** @type {MouseEvent} */ (e).button !== 0)) return;
    const row = grip.closest('.analysis-column-row');
    e.preventDefault();
    row.classList.add('dragging');
    const move = (ev) => {
      const y = ev.clientY;
      if(y < 70) window.scrollBy(0, -14); else if(y > window.innerHeight - 70) window.scrollBy(0, 14);
      const next = rowsOf().filter(r => r !== row).find(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if(next){ if(row.nextElementSibling !== next) list.insertBefore(row, next); }
      else if(list.lastElementChild !== row) list.appendChild(row);
    };
    const end = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
      row.classList.remove('dragging');
      commit(/** @type {HTMLElement} */ (row).dataset.col);
    };
    // listened for on the document: moving the row in the list would drop a pointer capture held by its handle
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  });
  list.addEventListener('keydown', (e) => {
    const grip = closestEl(e, '.analysis-col-grip');
    if(!grip || (/** @type {KeyboardEvent} */ (e).key !== 'ArrowUp' && /** @type {KeyboardEvent} */ (e).key !== 'ArrowDown')) return;
    e.preventDefault();
    const row = grip.closest('.analysis-column-row'), up = /** @type {KeyboardEvent} */ (e).key === 'ArrowUp';
    const other = up ? row.previousElementSibling : row.nextElementSibling;
    if(!other) return;
    if(up) list.insertBefore(row, other); else list.insertBefore(other, row);
    commit(/** @type {HTMLElement} */ (row).dataset.col);
  });
}

// Column panel: a move or reset changes the table's column SET (header included), so it redraws the whole section.
function wireColumnControls(rerender){
  const columnsBtn = document.getElementById('analysisColumnsBtn');
  if(columnsBtn){
    columnsBtn.addEventListener('click', () => {
      setAnalysisColumnsPanelOpen(!getAnalysisColumnsPanelOpen());
      analysisPersistUi();
      rerender();
    });
  }
  wireColumnDrag(rerender);
  const resetBtn = document.getElementById('analysisColumnsResetBtn');
  if(resetBtn){
    resetBtn.addEventListener('click', () => {
      analysisFilters.columnOrder = ANALYSIS_LB_COLUMN_IDS.slice();
      saveAnalysisFilters(analysisFilters);
      rerender();
    });
  }
}

export { init_leaderboard_fullscreen, leaderboardHtml, renderLeaderboardRows, wireLeaderboard };
