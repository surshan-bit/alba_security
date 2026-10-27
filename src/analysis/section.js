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
import { ANALYSIS_VIEW_KEYS, ANALYSIS_VIEW_OPTIONS, analysisFilters, saveAnalysisFilters } from './state.js';
import { escapeHtml } from '../core/util.js';
import { dropMenuHtml } from '../ui/dropmenu.js';
import { closestEl } from '../core/evt.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { analysisBucket, renderAnalysisFilterPanel } from './filterpanel.js';
import { syncSheets } from '../ui/phonesheet.js';
import { chartGeometry, stocksInRange, valueFor } from './geometry.js';
import { analysisControlsHtml, wireAnalysisControls } from './controls.js';
import { TOOLTIP_HTML, createAnalysisTooltip, wireDotEvents } from './tooltip.js';
import { leaderboardHtml, renderLeaderboardRows, wireLeaderboard } from './leaderboard.js';
import { keepScroll, redrawWhenIdle } from '../ui/scrollkeep.js';

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

// View: the stocks one by one, or one row per Industry / Industry Group (the industry table Explorer has, drawn here from the stocks the filters let through).
const VIEW_HINTS = { stocks: 'Every stock, one row each', industry: 'One row per industry', group: 'One row per broader industry group' };
function viewBarHtml(){
  const cur = analysisFilters.view, now = ANALYSIS_VIEW_OPTIONS.find(o => o.value === cur) || ANALYSIS_VIEW_OPTIONS[0];
  const items = ANALYSIS_VIEW_OPTIONS.map(o => ({ attrs: `data-analysis-view="${o.value}"`, title: o.label, desc: VIEW_HINTS[o.value] || '', current: o.value === now.value }));
  return `<div class="analysis-view-bar">${dropMenuHtml({ btnHtml: `<small>View</small><b>${escapeHtml(now.label)}</b><span class="dm-caret" aria-hidden="true">&#9662;</span>`, label: 'View: ' + now.label, items })}</div>`;
}
const toolbarOnlyHtml = () => `<div class="analysis-toolbar">${viewBarHtml()}</div>`;
function wireViewBar(body){
  renderAnalysisFilterPanel(renderAnalysisSection);   // drawn once the toolbar exists: the panel docks into it (and the body redraw above removed the old one)
  const bar = body.querySelector('.analysis-view-bar');
  if(bar) bar.addEventListener('click', (e) => {
    const b = closestEl(e, '[data-analysis-view]'), v = (b && b.dataset.analysisView) || '';
    if(!b || !ANALYSIS_VIEW_KEYS.has(v) || v === analysisFilters.view) return;
    analysisFilters.view = v;
    saveAnalysisFilters(analysisFilters);
    renderAnalysisSection();
  });
}
// The industry views: the table's code (business/panel.js) is fetched once and kept. It is requested in the background as soon as the Stocks view is drawn, so
// switching View normally draws the table in the same step as the toolbar, with no "Loading…" frame in between (which looked like a flicker).
let industryMod = null;
const loadIndustryMod = () => industryMod ? Promise.resolve(industryMod) : import('../business/panel.js').then((m) => (industryMod = m));
function paintIndustryView(m, el){
  m.showIn({ el, by: analysisFilters.view === 'group' ? 'group' : 'industry', section: appSections.analysis, label: 'Analysis', stocksNow: () => new Set(stocksInRange(analysisBucket())) });
  syncSheets();
}
function drawIndustryView(body){
  body.innerHTML = toolbarOnlyHtml() + `<div id="analysisIndustryBody" class="analysis-industry">${industryMod ? '' : '<p class="upload-hint">Loading…</p>'}</div>`;
  wireViewBar(body);
  const el = document.getElementById('analysisIndustryBody');
  if(!el) return;
  if(industryMod){ paintIndustryView(industryMod, el); return; }
  loadIndustryMod().then((m) => {
    if(!el.isConnected || analysisFilters.view === 'stocks') return;
    paintIndustryView(m, el);
  }).catch((e) => { el.innerHTML = '<p class="upload-hint">Could not load this view. Please try again.</p>'; console.error('Could not load the industry view', e); });
  syncSheets();
}

// Hide / show the RSI Quadrant with its sliders (remembered on this device; hidden until first opened). The leaderboard stays.
const CHART_HIDDEN_KEY = 'albaAnalysisChartHidden';
function chartHiddenSaved(){ try { return localStorage.getItem(CHART_HIDDEN_KEY) !== '0'; } catch(e){ return true; } }
function wireChartToggle(){
  const btn = document.getElementById('analysisChartToggle'), box = document.querySelector('.analysis-leaderboard');
  if(!btn || !box) return;
  const apply = (hidden) => {
    box.classList.toggle('chart-hidden', hidden);
    const label = hidden ? 'Show chart' : 'Hide chart';
    btn.title = label; btn.setAttribute('aria-label', label);
    const text = btn.querySelector('.analysis-btn-label'); if(text) text.textContent = label;
    btn.setAttribute('aria-expanded', String(!hidden));
  };
  apply(chartHiddenSaved());
  btn.onclick = () => {
    const hidden = !box.classList.contains('chart-hidden');
    apply(hidden);
    try { localStorage.setItem(CHART_HIDDEN_KEY, hidden ? '1' : '0'); } catch(e){ /* storage unavailable: the choice lasts until reload */ }
  };
}

// A full redraw puts the scrolled table and filter rows back where the viewer had them.
function renderAnalysisSection(){ keepScroll(document.getElementById('section-analysis'), drawAnalysisSection); }
// The redraw for a change that arrived in the background (saved prices, a refresh, another device): it waits until scrolling has stopped.
function refreshAnalysisSoon(){ redrawWhenIdle('analysis', renderAnalysisSection); }

function drawAnalysisSection(){
  const body = document.getElementById('analysisPanelBody');
  if(!body) return;

  const bucket = analysisBucket();
  const plottable = bucket.filter(hasBothRsi);

  if(analysisFilters.view !== 'stocks'){ drawIndustryView(body); return; }
  if(bucket.length === 0){
    body.innerHTML = toolbarOnlyHtml() + `<p class="analysis-panel-sub">No stocks match the current filters, so there's nothing to plot.</p>`;
    wireViewBar(body);
    return;
  }

  const geo = chartGeometry(body, plottable);

  // The RSI Quadrant (its sliders, axis choices and the scatter plot) sits inside the leaderboard, opened by its "Show chart" button.
  body.innerHTML = `
    ${leaderboardHtml(`<div class="analysis-chart-block">
      ${analysisControlsHtml(geo.mosBoundLo, geo.mosBoundHi)}
      ${chartHtml(geo)}
    </div>`, viewBarHtml())}
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

  wireViewBar(body);
  wireChartToggle();
  const tooltip = createAnalysisTooltip();
  wireDotEvents(document.getElementById('analysisDots'), tooltip, openStockFromAnalysis);
  wireLeaderboard({ update: updateAnalysisChart, rerender: renderAnalysisSection, openStock: openStockFromAnalysis, hideTooltip: tooltip.hide });
  wireAnalysisControls({ mosBoundLo: geo.mosBoundLo, mosBoundHi: geo.mosBoundHi, update: updateAnalysisChart, schedule: scheduleAnalysisChartUpdate, rerender: renderAnalysisSection, onRelease: () => renderAnalysisFilterPanel(renderAnalysisSection) });

  updateAnalysisChart();
  syncSheets();
  if(!industryMod) setTimeout(() => { loadIndustryMod().catch(() => { /* fetched again when the viewer opens an industry view */ }); }, 400);
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

export { init_analysis_section, refreshAnalysisSoon, renderAnalysisSection };
