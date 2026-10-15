// The Analysis leaderboard table: ranking, header and rows, and its click handling.
import { stockIndex, stocks } from '../core/stocks.js';
import { isPinned, togglePin } from '../core/pins.js';
import { escapeHtml } from '../core/util.js';
import { ANALYSIS_SORT_KEYS, ANALYSIS_SORT_OPTIONS, getAnalysisColumnsPanelOpen, setAnalysisColumnsPanelOpen, analysisFilters, analysisPersistUi, setAnalysisShownIdx, analysisSortComparator, saveAnalysisFilters } from './state.js';
import { analysisTakeBatch, defineAnalysisScope, updateAnalysisRefresh } from './selectbar.js';
import { ANALYSIS_LB_COLUMN_IDS, analysisColumnOrder, analysisLbCell, analysisRowContext, columnHeaderHtml, renderAnalysisColumnsPanel } from './columns.js';
import { ldOpenPermissions } from '../livedata/bar.js';
import { ldBatchStart, ldBatchStop } from '../livedata/batch.js';
import { browserFullscreen, fullscreenLabel, watchFullscreenExit } from '../ui/fullscreen.js';
import { getRefreshKit } from '../refresh/hook.js';
import { closestEl } from '../core/evt.js';

// ---- full screen ----
// The leaderboard can fill the whole window. The state lives here so a redraw of the section keeps it. Esc and the browser's own full screen are handled in ui/fullscreen.js.
let lbFull = false;
function paintFullscreen(){
  const box = document.querySelector('.analysis-leaderboard'), btn = document.getElementById('analysisFullscreenBtn');
  if(box) box.classList.toggle('lb-full', lbFull);
  document.body.classList.toggle('lb-full-open', lbFull);
  if(btn){ btn.textContent = fullscreenLabel(lbFull); btn.setAttribute('aria-pressed', lbFull ? 'true' : 'false'); }
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
// Title, "Sort by", the Columns, Show chart and Full screen buttons, the RSI Quadrant block (`chartBlock`, hidden until opened), the columns panel, the table shell and, below the table, the Live Data Refresh panel.
function leaderboardHtml(chartBlock){
  const headerColOrder = analysisColumnOrder(), kit = getRefreshKit();
  return `<div class="analysis-leaderboard${lbFull ? ' lb-full' : ''}">
      <div class="analysis-leaderboard-head" style="margin-top:0;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div class="rk-headline"><p class="upload-hint biz-showing" style="margin:0"><span id="analysisLeaderboardCount"></span></p>${(defineAnalysisScope(), '')}</div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label class="analysis-filter-label" style="display:flex;align-items:center;gap:6px;">Sort by:
            <select class="sort-select" id="analysisSortSelect">
              ${ANALYSIS_SORT_OPTIONS.map(o => `<option value="${o.value}"${analysisFilters.sortBy === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>
          </label>
          <button type="button" class="analysis-reset-btn" id="analysisColumnsBtn">Columns</button>
          <button type="button" class="analysis-reset-btn" id="analysisChartToggle" aria-expanded="false">Show chart</button>
          <button type="button" class="analysis-reset-btn" id="analysisFullscreenBtn" aria-pressed="${lbFull}" title="Show the leaderboard across the whole window (Esc to leave)">${fullscreenLabel(lbFull)}</button>
          ${kit ? kit.barHtml('analysis') : ''}
        </div>
      </div>
      ${chartBlock}
      ${renderAnalysisColumnsPanel(headerColOrder)}
      <div class="strat-table-wrap">
        <table class="strat-table">
          <thead><tr>${kit ? kit.headCell() : ''}${headerColOrder.map(columnHeaderHtml).join('')}</tr></thead>
          <tbody id="analysisLeaderboardBody"></tbody>
        </table>
      </div>
      ${kit ? kit.selbarSlot('analysis') : ''}
    </div>`;
}

// ---- rows ----
// Pinned stocks (the same pin as the detail panel) always sort to the top; within each
// group the order follows the "Sort by" dropdown (default: Margin of Safety).
function rankStocks(filtered){
  const sortCmp = analysisSortComparator(analysisFilters.sortBy);
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
              ${kit ? kit.rowCell() : ''}${colOrder.map(id => analysisLbCell(id, ctx)).join('')}
            </tr>
          `;
}

// Fills the count and the table body for the stocks currently in the chart's range.
function renderLeaderboardRows(filtered){
  const ranked = rankStocks(filtered);
  const lbCountEl = document.getElementById('analysisLeaderboardCount');
  if(lbCountEl) lbCountEl.textContent = `Showing ${ranked.length} of ${stocks.length} stocks`;
  const lbBody = document.getElementById('analysisLeaderboardBody');
  const colOrder = analysisColumnOrder();
  lbBody.innerHTML = ranked.length === 0
    ? `<tr><td colspan="${colOrder.length + (getRefreshKit() ? 1 : 0)}" class="analysis-lb-empty">No stocks in the current RSI range.</td></tr>`
    : ranked.map((s, i) => leaderboardRowHtml(s, i, colOrder)).join('');
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

  // "Sort by" only reorders the rows, so it needs update(), not a full render.
  const sortSelect = /** @type {HTMLInputElement} */ (document.getElementById('analysisSortSelect'));
  if(sortSelect){
    sortSelect.addEventListener('change', () => {
      analysisFilters.sortBy = ANALYSIS_SORT_KEYS.has(sortSelect.value) ? sortSelect.value : 'mos_desc';
      saveAnalysisFilters(analysisFilters);
      update();
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
