// The Analysis section: filter panel, controls, scatter chart and leaderboard, drawn on demand (from
// showSection, not on page load).
//
// Plots every stock that passes the filters on a Weekly RSI x Monthly RSI scatter, split into four quadrants
// at RSI 50. A stock with no weekly or monthly RSI reading yet can't be placed, so it is left off the chart.
//
// Two ways to redraw:
//  - renderAnalysisSection() rebuilds everything. Used when the filter buttons, axes, columns or
//    Live Data Refresh mode change.
//  - updateAnalysisChart() redraws only the dots and the leaderboard rows. Used while a slider is dragged:
//    a full render would recreate the slider under the drag and kill it. Calls are coalesced to one per
//    animation frame.
// The filter state (analysisFilters) lives outside the render so it survives leaving the section and coming back.
import { stockIndex } from '../core/stocks.js';
import { isPinned } from '../core/pins.js';
import { mosPct } from '../list/metrics.js';
import { analysisFilters } from './state.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { analysisBucket, renderAnalysisFilterPanel } from './filterpanel.js';
import { chartGeometry, stocksInRange, valueFor } from './geometry.js';
import { analysisControlsHtml, wireAnalysisControls } from './controls.js';
import { TOOLTIP_HTML, createAnalysisTooltip, wireDotEvents } from './tooltip.js';
import { leaderboardHtml, renderLeaderboardRows, wireLeaderboard } from './leaderboard.js';

function openStockFromAnalysis(idx){
  openStockInline(appSections.analysis, 'Analysis', idx);
}

// One <circle> per stock (and a star above pinned ones). Pinned stocks are drawn last, i.e. on top, so their
// highlight ring is never hidden under an unpinned neighbour.
function dotsSvg(filtered, geo){
  const dotsOrdered = filtered.filter(hasBothRsi).sort((a, b) => (isPinned(a) ? 1 : 0) - (isPinned(b) ? 1 : 0));
  return dotsOrdered.map(s => {
    const idx = stockIndex.get(s);
    const r = s.technical.raw;
    const cxNum = geo.xFor(valueFor(s, analysisFilters.xAxis));
    const cyNum = geo.yFor(valueFor(s, analysisFilters.yAxis));
    const cx = cxNum.toFixed(1);
    const cy = cyNum.toFixed(1);
    const colorRsi = analysisFilters.colorBy === 'month' ? r.monthRsi : r.weekRsi;
    const colorClass = colorRsi > 50 ? 'color-green' : 'color-red';
    const radius = geo.radiusForMos(mosPct(s));
    const pinned = isPinned(s);
    const pinnedClass = pinned ? ' pinned' : '';
    const star = pinned ? `<text class="analysis-dot-star" x="${cx}" y="${(cyNum - radius - 4).toFixed(1)}">&#9733;</text>` : '';
    return `<circle class="analysis-dot ${colorClass}${pinnedClass}" cx="${cx}" cy="${cy}" r="${radius.toFixed(1)}" data-idx="${idx}"></circle>${star}`;
  }).join('');
}

// A stock can only be drawn when it has both RSI readings.
const hasBothRsi = (s) => !!(s.technical && s.technical.raw && s.technical.raw.weekRsi != null && s.technical.raw.monthRsi != null);

function chartHtml(geo){
  const { W, H } = geo;
  return `<div class="analysis-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-label="Scatter plot of weekly versus monthly RSI for stocks matching the current filters">
        ${geo.gridSvg}
        ${geo.axisBox}
        ${geo.quadrantLines}
        ${geo.quadrantLabels}
        ${geo.axisLabels}
        <g id="analysisDots"></g>
      </svg>
    </div>`;
}

// Hide / show the RSI Quadrant with its sliders (remembered on this device; hidden until first opened). The leaderboard stays.
const CHART_HIDDEN_KEY = 'albaAnalysisChartHidden';
function chartHiddenSaved(){ try { return localStorage.getItem(CHART_HIDDEN_KEY) !== '0'; } catch(e){ return true; } }
function wireChartToggle(){
  const btn = document.getElementById('analysisChartToggle'), box = document.querySelector('.analysis-leaderboard');
  if(!btn || !box) return;
  const apply = (hidden) => {
    box.classList.toggle('chart-hidden', hidden);
    btn.textContent = hidden ? 'Show chart' : 'Hide chart';
    btn.setAttribute('aria-expanded', String(!hidden));
  };
  apply(chartHiddenSaved());
  btn.onclick = () => {
    const hidden = !box.classList.contains('chart-hidden');
    apply(hidden);
    try { localStorage.setItem(CHART_HIDDEN_KEY, hidden ? '1' : '0'); } catch(e){ /* storage unavailable: the choice lasts until reload */ }
  };
}

function renderAnalysisSection(){
  const body = document.getElementById('analysisPanelBody');
  if(!body) return;

  const bucket = analysisBucket();
  const plottable = bucket.filter(hasBothRsi);

  renderAnalysisFilterPanel(renderAnalysisSection);

  if(bucket.length === 0){
    body.innerHTML = `<p class="analysis-panel-sub">No stocks match the current filters, so there's nothing to plot.</p>`;
    return;
  }

  const geo = chartGeometry(body, plottable);

  // The RSI Quadrant (its sliders, axis choices and the scatter plot) sits inside the leaderboard, opened by its "Show chart" button.
  body.innerHTML = `
    ${leaderboardHtml(`<div class="analysis-chart-block">
      ${analysisControlsHtml(geo.mosBoundLo, geo.mosBoundHi)}
      ${chartHtml(geo)}
    </div>`)}
    ${TOOLTIP_HTML}
  `;

  function updateAnalysisChart(){
    // Saving is done by the controls' own 'change' handlers (once per drag, on release), not here: this runs on
    // every 'input' tick, and a synchronous localStorage write per tick was a measurable drag-performance cost.
    const filtered = stocksInRange(bucket);
    document.getElementById('analysisDots').innerHTML = dotsSvg(filtered, geo);
    renderLeaderboardRows(filtered);
  }

  // Slider drags fire 'input' many times per frame and each redraw rebuilds every dot and row, so coalesce
  // them to one redraw per animation frame. The final state is identical.
  let updateRaf = null;
  function scheduleAnalysisChartUpdate(){
    if(updateRaf) return;
    updateRaf = requestAnimationFrame(() => { updateRaf = null; updateAnalysisChart(); });
  }

  wireChartToggle();
  const tooltip = createAnalysisTooltip();
  wireDotEvents(document.getElementById('analysisDots'), tooltip, openStockFromAnalysis);
  wireLeaderboard({ update: updateAnalysisChart, rerender: renderAnalysisSection, openStock: openStockFromAnalysis, hideTooltip: tooltip.hide });
  wireAnalysisControls({ mosBoundLo: geo.mosBoundLo, mosBoundHi: geo.mosBoundHi, update: updateAnalysisChart, schedule: scheduleAnalysisChartUpdate, rerender: renderAnalysisSection });

  updateAnalysisChart();
}

// Redraw the chart when the window is resized, so it keeps filling the available width.
let analysisResizeTimer = null;

function init_analysis_section(){
  window.addEventListener('resize', () => {
    clearTimeout(analysisResizeTimer);
    analysisResizeTimer = setTimeout(() => {
      const sec = document.getElementById('section-analysis');
      if(sec && sec.classList.contains('active')){ try { renderAnalysisSection(); } catch(e){ console.error('Could not redraw Analysis after a resize', e); } }
    }, 200);
  });
}

export { init_analysis_section, renderAnalysisSection };
